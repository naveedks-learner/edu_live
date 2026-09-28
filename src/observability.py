"""
Persistent, queryable logging for every stage of a RAG query: retrieval
candidates (kept and discarded), the confidence/routing decision, every
LLM round-trip (exact messages sent, raw response, tokens, latency), every
tool call, web fallback results, and errors.

Stored in a local SQLite file (stdlib only - Chroma already keeps its own
SQLite file, this is a separate one just for observability data) so the
dashboard (src/pages/1_Observability.py) can filter/aggregate with plain
SQL instead of re-parsing logs.
"""

import json
import sqlite3
from datetime import datetime, timezone

DB_PATH = "observability.db"

# USD per 1,000,000 tokens, (input_rate, output_rate). Approximate - update
# as provider pricing changes. Groq's free tier is $0.
# Any model not listed here defaults to (0.0, 0.0) - i.e. cost is silently
# under-reported for unlisted paid models, so keep this in sync with
# config.py's get_model_choices_for_provider() when adding new models.
PRICING_PER_MILLION_TOKENS = {
    "llama-3.3-70b-versatile": (0.0, 0.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "gemini-flash-latest": (0.075, 0.30),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-pro": (1.25, 10.0),
    "openai/gpt-oss-20b": (0.05, 0.20),
    "openai/gpt-oss-20b:free": (0.0, 0.0),
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    question TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    answer TEXT,
    routing_path TEXT,
    confidence REAL,
    threshold REAL,
    auto_gate_triggered INTEGER,
    total_latency_ms REAL,
    total_input_tokens INTEGER,
    total_output_tokens INTEGER,
    estimated_cost_usd REAL,
    error TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL,
    iteration INTEGER,
    source TEXT,
    page INTEGER,
    chunk_id INTEGER,
    distance REAL,
    confidence REAL,
    rerank_score REAL,
    rank INTEGER,
    kept INTEGER
);

CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL,
    iteration INTEGER,
    messages_json TEXT,
    model TEXT,
    params_json TEXT,
    response_text TEXT,
    stop_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms REAL
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL,
    iteration INTEGER,
    tool_name TEXT,
    input_query TEXT,
    output_text TEXT,
    latency_ms REAL,
    triggered_by TEXT
);

CREATE TABLE IF NOT EXISTS web_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL,
    title TEXT,
    url TEXT,
    snippet TEXT,
    rank INTEGER
);

CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER,
    stage TEXT,
    message TEXT,
    timestamp TEXT
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """
    One-off column additions for DBs created before a schema change -
    CREATE TABLE IF NOT EXISTS above only handles brand-new DBs, so an
    existing observability.db needs its missing columns added by hand.
    Each ALTER is wrapped since SQLite has no "ADD COLUMN IF NOT EXISTS".
    """
    try:
        conn.execute("ALTER TABLE retrieval_candidates ADD COLUMN rerank_score REAL")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    in_rate, out_rate = PRICING_PER_MILLION_TOKENS.get(model, (0.0, 0.0))
    return (input_tokens or 0) / 1_000_000 * in_rate + (output_tokens or 0) / 1_000_000 * out_rate


def start_query(session_id: str, question: str, provider: str, model: str) -> int:
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO queries (session_id, timestamp, question, provider, model) VALUES (?, ?, ?, ?, ?)",
        (session_id, _now(), question, provider, model),
    )
    conn.commit()
    query_id = cur.lastrowid
    conn.close()
    return query_id


def log_retrieval_candidates(query_id: int, iteration: int, candidates: list[dict]) -> None:
    if not candidates:
        return
    conn = _connect()
    conn.executemany(
        """INSERT INTO retrieval_candidates
           (query_id, iteration, source, page, chunk_id, distance, confidence, rerank_score, rank, kept)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                query_id, iteration, c["source"], c["page"], c["chunk_id"],
                c["distance"], c["confidence"], c.get("rerank_score"), c["rank"], int(c["kept"]),
            )
            for c in candidates
        ],
    )
    conn.commit()
    conn.close()


def log_llm_call(
    query_id: int, iteration: int, messages: list, model: str, params: dict,
    response_text: str | None, stop_reason: str | None,
    input_tokens: int | None, output_tokens: int | None, latency_ms: float,
) -> None:
    conn = _connect()
    conn.execute(
        """INSERT INTO llm_calls
           (query_id, iteration, messages_json, model, params_json, response_text,
            stop_reason, input_tokens, output_tokens, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            query_id, iteration, json.dumps(messages, default=str), model,
            json.dumps(params), response_text, stop_reason, input_tokens,
            output_tokens, latency_ms,
        ),
    )
    conn.commit()
    conn.close()


def log_tool_call(
    query_id: int, iteration: int, tool_name: str, input_query: str,
    output_text: str, latency_ms: float, triggered_by: str,
) -> None:
    conn = _connect()
    conn.execute(
        """INSERT INTO tool_calls
           (query_id, iteration, tool_name, input_query, output_text, latency_ms, triggered_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (query_id, iteration, tool_name, input_query, output_text, latency_ms, triggered_by),
    )
    conn.commit()
    conn.close()


def log_web_results(query_id: int, results: list[dict]) -> None:
    if not results:
        return
    conn = _connect()
    conn.executemany(
        "INSERT INTO web_results (query_id, title, url, snippet, rank) VALUES (?, ?, ?, ?, ?)",
        [(query_id, r["title"], r["url"], r["snippet"], i + 1) for i, r in enumerate(results)],
    )
    conn.commit()
    conn.close()


def log_error(query_id: int | None, stage: str, message: str) -> None:
    conn = _connect()
    conn.execute(
        "INSERT INTO errors (query_id, stage, message, timestamp) VALUES (?, ?, ?, ?)",
        (query_id, stage, message, _now()),
    )
    conn.commit()
    conn.close()


def finish_query(
    query_id: int, answer: str, routing_path: str, confidence: float | None,
    threshold: float | None, auto_gate_triggered: bool, total_latency_ms: float,
    total_input_tokens: int, total_output_tokens: int, model: str,
    error: str | None = None,
) -> None:
    cost = estimate_cost(model, total_input_tokens, total_output_tokens)
    conn = _connect()
    conn.execute(
        """UPDATE queries SET
               answer = ?, routing_path = ?, confidence = ?, threshold = ?,
               auto_gate_triggered = ?, total_latency_ms = ?, total_input_tokens = ?,
               total_output_tokens = ?, estimated_cost_usd = ?, error = ?
           WHERE id = ?""",
        (
            answer, routing_path, confidence, threshold, int(auto_gate_triggered),
            total_latency_ms, total_input_tokens, total_output_tokens, cost, error,
            query_id,
        ),
    )
    conn.commit()
    conn.close()


# --- Read helpers for the dashboard ---------------------------------------

def list_queries(
    date_from: str | None = None,
    date_to: str | None = None,
    provider: str | None = None,
    routing_path: str | None = None,
    errors_only: bool = False,
    min_confidence: float | None = None,
    max_confidence: float | None = None,
    limit: int = 200,
) -> list[dict]:
    clauses, params = [], []
    if date_from:
        clauses.append("timestamp >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("timestamp <= ?")
        params.append(date_to)
    if provider:
        clauses.append("provider = ?")
        params.append(provider)
    if routing_path:
        clauses.append("routing_path = ?")
        params.append(routing_path)
    if errors_only:
        clauses.append("error IS NOT NULL")
    if min_confidence is not None:
        clauses.append("confidence >= ?")
        params.append(min_confidence)
    if max_confidence is not None:
        clauses.append("confidence <= ?")
        params.append(max_confidence)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    conn = _connect()
    rows = conn.execute(
        f"SELECT * FROM queries {where} ORDER BY id DESC LIMIT ?", (*params, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_query(query_id: int) -> dict | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM queries WHERE id = ?", (query_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_retrieval_candidates(query_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM retrieval_candidates WHERE query_id = ? ORDER BY iteration, rank",
        (query_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_llm_calls(query_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM llm_calls WHERE query_id = ? ORDER BY iteration", (query_id,)
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["messages"] = json.loads(d.pop("messages_json"))
        d["params"] = json.loads(d.pop("params_json"))
        out.append(d)
    return out


def get_tool_calls(query_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM tool_calls WHERE query_id = ? ORDER BY iteration", (query_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_web_results(query_id: int) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM web_results WHERE query_id = ? ORDER BY rank", (query_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_errors(errors_only_limit: int = 200) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM errors ORDER BY id DESC LIMIT ?", (errors_only_limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_token_usage_last_txn() -> dict | None:
    """Token usage for the most recently finished query."""
    conn = _connect()
    row = conn.execute(
        "SELECT id, timestamp, model, total_input_tokens, total_output_tokens, estimated_cost_usd "
        "FROM queries WHERE total_input_tokens IS NOT NULL OR total_output_tokens IS NOT NULL "
        "ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_token_usage_since(hours: int = 24) -> dict:
    """Aggregate token usage over the last `hours` hours."""
    from datetime import timedelta

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    conn = _connect()
    row = conn.execute(
        """SELECT COUNT(*) AS query_count,
                  COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(estimated_cost_usd), 0.0) AS cost_usd
           FROM queries WHERE timestamp >= ?""",
        (cutoff,),
    ).fetchone()
    conn.close()
    return dict(row)


def get_analytics() -> dict:
    conn = _connect()
    volume_by_day = conn.execute(
        "SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS n FROM queries GROUP BY day ORDER BY day"
    ).fetchall()
    by_routing_path = conn.execute(
        "SELECT COALESCE(routing_path, 'unknown') AS routing_path, COUNT(*) AS n "
        "FROM queries GROUP BY routing_path"
    ).fetchall()
    questions = [r["question"] for r in conn.execute("SELECT question FROM queries").fetchall()]
    conn.close()

    stopwords = {
        "the", "a", "an", "is", "are", "of", "to", "in", "on", "for", "and",
        "what", "how", "does", "do", "can", "you", "me", "some", "about",
        "this", "that", "with", "it", "explain", "i", "we", "get",
    }
    word_counts: dict[str, int] = {}
    for q in questions:
        for word in q.lower().split():
            word = "".join(ch for ch in word if ch.isalnum())
            if len(word) > 2 and word not in stopwords:
                word_counts[word] = word_counts.get(word, 0) + 1
    top_terms = sorted(word_counts.items(), key=lambda kv: kv[1], reverse=True)[:15]

    return {
        "volume_by_day": [dict(r) for r in volume_by_day],
        "by_routing_path": [dict(r) for r in by_routing_path],
        "top_terms": top_terms,
    }
