"""
The agentic RAG step: instead of always stuffing retrieved chunks into the
prompt, the model gets two TOOLS and decides for itself which to call:

- search_documents: searches the local PDF vector store
- web_search: searches the live internet (DuckDuckGo, no API key)

This is the core "function calling / tool use" pattern - the model reads the
question, decides what it needs, calls a tool, reads the result, and either
calls another tool or answers. See _run_groq_loop / _run_claude_loop below
for the two providers' tool-calling wire formats.

On top of that, a deterministic CONFIDENCE GATE runs in code right after
every search_documents call (see _run_confidence_gate): if the best
retrieved chunk's relevance is below a threshold, web_search is
auto-triggered regardless of what the model decides. This replaces relying
purely on the model noticing (via SYSTEM_PROMPT wording) that its document
matches were too generic - that heuristic was observed to misfire (generic
passages got treated as "good enough" when they didn't address the actual
question). The model can still call web_search itself too; the gate only
forces the call it might otherwise skip.

The gate's confidence number is top_confidence() from retrieval.py: the
cross-encoder reranker's score for the top chunk when reranking succeeded,
falling back to raw cosine confidence otherwise. Raw cosine similarity
alone was observed to score irrelevant chunks ~0.6-0.8 "confidence" (see
reranker.py's docstring), which let the gate go unfired for genuinely
off-topic questions - the reranker is what actually makes this threshold
meaningful.

By design, web_search never runs in parallel with search_documents - it is
strictly a fallback (either the model asks for it after finding document
results insufficient, or the confidence gate auto-triggers it). Document
search alone answers the large majority of questions.

Every stage - retrieval candidates, the gate's decision, each LLM
round-trip, each tool call, web results, and errors - is logged via
observability.py so it's inspectable per-query in the dashboard.

Providers and models are resolved per-call: answer_question(provider=...,
model=...) lets a caller (e.g. app.py's sidebar) override the .env-configured
default for a single query, with no shared mutable state between calls.
"""

import json
import logging
import os
import time
import observability

logger = logging.getLogger(__name__)
from config import get_active_provider_settings, guardrail_enabled  # also loads .env on import
from store import VectorStore
from retrieval import search_documents as _search_documents, top_confidence as _top_confidence
from web_search import web_search as _web_search
from query_scope_and_age_guardrail import check_query_in_scope_and_age_appropriate

settings = get_active_provider_settings()
DEFAULT_PROVIDER = settings.name
DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"
DEFAULT_HUGGINGFACE_MODEL = settings.model if DEFAULT_PROVIDER == "huggingface" else os.environ.get("HUGGINGFACE_MODEL", "Qwen/Qwen2.5-3B-Instruct")
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY") or os.environ.get("HUGGINGFACEHUB_API_TOKEN")
DEFAULT_GEMINI_MODEL = settings.model if DEFAULT_PROVIDER == "gemini" else os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
DEFAULT_OPENROUTER_MODEL = settings.model if DEFAULT_PROVIDER == "openrouter" else os.environ.get("OPENROUTER_MODEL", "openai/gpt-oss-20b:free")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

_DEFAULT_MODEL_BY_PROVIDER = {
    "claude": DEFAULT_CLAUDE_MODEL,
    "groq": DEFAULT_GROQ_MODEL,
    "huggingface": DEFAULT_HUGGINGFACE_MODEL,
    "gemini": DEFAULT_GEMINI_MODEL,
    "openrouter": DEFAULT_OPENROUTER_MODEL,
}

MAX_TOOL_ITERATIONS = 6  # safety cap so a confused agent can't loop forever

# Below this (1 - distance/2, in [0, 1]) the confidence gate auto-triggers
# web_search regardless of what the model decides. Tunable per-call via
# answer_question(confidence_threshold=...) - app.py exposes it as a slider.
DEFAULT_CONFIDENCE_THRESHOLD = 0.55

SYSTEM_PROMPT = """You are a helpful research assistant and teacher with two tools:

- search_documents: searches the user's uploaded PDF documents.
- web_search: searches the live internet.

Core behavior:
- Document-first policy: always search_documents first for questions that could be answered from the indexed PDFs.
- Never use web_search before search_documents when the document corpus could plausibly answer the question.
- Use web_search only as a fallback for missing facts, current information, dates, names, places, events, or if the document search returns no useful result.
- For short factual or explanatory questions, one good document search is often enough. Do not keep calling tools after you already have a clear answer.
- If the tool result clearly answers the question, stop and answer immediately.
- Never call the same tool with the same query twice in a row.
- Never loop between search_documents and web_search without a new reason.

Quality rules:
- Read what search_documents actually returned. If it does not specifically address every part of the question - especially named entities, places, dates, events, or specific context - treat it as insufficient and use web_search only if it is allowed and needed.
- Prefer the document answer over a web answer when both are available, unless the question clearly needs current information or the document is clearly incomplete.
- Only say "I don't have information about this in the available sources" after you have actually tried all available relevant tools and none answered the question.
- If web_search is not offered to you, do not pretend it exists.
- Never write fake tool calls or fabricated tool results as text. Only real tool calls count.
- Answer only from real tool results. Do not invent facts, page numbers, or web sources.
- After answering, clearly name the document with page number or the web page used.
- Keep answers concise unless the user asks for detail.
- The policy is: document-first, web as fallback, and never bypass the RAG pipeline when document results are available.

Audience and scope:
- Your users are 16-17 year old students. Keep language and content age-appropriate.
- Only help with science and maths topics. If a question is outside that scope, politely say so instead of answering it.
"""

TOOLS_SCHEMA = [
    {
        "name": "search_documents",
        "description": "Search the user's indexed PDF documents for relevant passages.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "What to search for"}},
            "required": ["query"],
        },
    },
    {
        "name": "web_search",
        "description": "Search the live internet for current or general information.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "What to search for"}},
            "required": ["query"],
        },
    },
]


def _to_groq_tools(tools_schema: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tools_schema
    ]


def _execute_tool(
    name: str,
    query_text: str,
    vector_store: VectorStore,
    top_k: int,
    doc_sources: list[str] | None,
    allowed_domains: list[str] | None,
    blocked_domains: list[str] | None,
) -> tuple[str, list[dict], list[dict], list[dict]]:
    """Runs a tool call. Returns (text_for_model, doc_chunks_used, web_results_used, all_candidates)."""
    if name == "search_documents":
        text, kept, candidates = _search_documents(vector_store, query_text, top_k, doc_sources)
        return text, kept, [], candidates

    if name == "web_search":
        results = _web_search(query_text, max_results=5, allowed_domains=allowed_domains, blocked_domains=blocked_domains)
        text = "\n\n".join(f"[{r['title']}]({r['url']})\n{r['snippet']}" for r in results)
        return text or "No web results found.", [], results, []

    return f"Unknown tool: {name}", [], [], []


def _run_confidence_gate(
    query_text: str,
    confidence: float,
    threshold: float,
    web_enabled: bool,
    gate_state: dict,
    allowed_domains: list[str] | None,
    blocked_domains: list[str] | None,
    query_id: int,
    iteration: int,
    on_tool_call,
) -> tuple[str, list[dict]]:
    """
    Deterministic backstop: if document-retrieval confidence is below
    threshold and web_search hasn't already run this query, auto-trigger it
    in code rather than trusting the model to notice. Returns
    (extra_text_to_append, web_results) - both empty if the gate doesn't fire.
    """
    if gate_state["web_called"] or not web_enabled or confidence >= threshold:
        return "", []

    if on_tool_call:
        on_tool_call("web_search", query_text)

    t0 = time.perf_counter()
    results = _web_search(query_text, max_results=5, allowed_domains=allowed_domains, blocked_domains=blocked_domains)
    latency_ms = (time.perf_counter() - t0) * 1000
    text = "\n\n".join(f"[{r['title']}]({r['url']})\n{r['snippet']}" for r in results) or "No web results found."

    gate_state["web_called"] = True
    gate_state["auto_triggered"] = True

    observability.log_tool_call(query_id, iteration, "web_search", query_text, text, latency_ms, "auto_gate")
    observability.log_web_results(query_id, results)

    note = "\n\n[Auto-triggered web_search: document-retrieval confidence " \
           f"({confidence:.2f}) was below threshold ({threshold:.2f})]\n\n"
    return note + text, results


def _routing_path(doc_sources_used: list, web_sources_used: list) -> str:
    if doc_sources_used and web_sources_used:
        return "pdf_then_web"
    if doc_sources_used:
        return "pdf_only"
    if web_sources_used:
        return "web_only"
    return "none"


def _has_repeated_tool_cycle(trace: list[dict], tool_name: str, query_text: str, repeat_count: int = 2) -> bool:
    """Detect when the model keeps re-issuing the same tool call on the same query."""
    normalized_query = (query_text or "").strip()
    matches = 0
    for entry in reversed(trace):
        if entry.get("tool") == tool_name and str(entry.get("input", "")).strip() == normalized_query:
            matches += 1
            if matches >= repeat_count:
                return True
        else:
            # A different tool/query breaks the cycle pattern.
            matches = 0
    return False


def _groq_chat_with_retry(client, messages, tools, tool_choice, model, retries: int = 2):
    """
    Groq/Llama tool calling occasionally emits a malformed function-call tag
    (a model-side generation glitch, not something a prompt fix reliably
    prevents). Retry a couple times since it's often just a sampling fluke;
    returns None if it keeps failing so the caller can fall back gracefully
    instead of crashing.
    """
    from groq import BadRequestError

    for _ in range(retries + 1):
        try:
            return client.chat.completions.create(
                model=model, max_tokens=1000, messages=messages, tools=tools, tool_choice=tool_choice,
            )
        except BadRequestError as e:
            if "tool_use_failed" not in str(e):
                raise
    return None


def _run_groq_loop(question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
                    web_enabled, threshold, query_id, on_tool_call, hard_fail_on_no_document=False,
                    model=None):
    from groq import Groq, APIStatusError

    model = model or DEFAULT_GROQ_MODEL
    client = Groq()
    tools = _to_groq_tools(TOOLS_SCHEMA if web_enabled else TOOLS_SCHEMA[:1])
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]
    doc_sources_used, web_sources_used, trace = [], [], []
    gate_state = {"web_called": False, "auto_triggered": False, "confidence": None}
    total_input_tokens = total_output_tokens = 0
    start_time = time.perf_counter()

    def _finish(answer, error=None):
        total_latency_ms = (time.perf_counter() - start_time) * 1000
        observability.finish_query(
            query_id, answer, _routing_path(doc_sources_used, web_sources_used),
            gate_state["confidence"], threshold, gate_state["auto_triggered"],
            total_latency_ms, total_input_tokens, total_output_tokens, model, error=error,
        )
        return answer, doc_sources_used, web_sources_used, trace

    for iteration in range(MAX_TOOL_ITERATIONS):
        # Force a real tool call on the first turn - the model would sometimes
        # just narrate a fake "search" in plain text instead of actually
        # calling a tool, which defeats the entire "answer only from tool
        # results" premise. After the first turn it's free to conclude.
        tool_choice = "required" if iteration == 0 else "auto"
        t0 = time.perf_counter()
        try:
            response = _groq_chat_with_retry(client, messages, tools, tool_choice, model)
            if response is None:
                # Tool calling kept failing - fall back to a plain answer so
                # the user still gets something instead of a crash.
                fallback_messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": question}]
                response = client.chat.completions.create(model=model, max_tokens=1000, messages=fallback_messages)
                latency_ms = (time.perf_counter() - t0) * 1000
                usage = response.usage
                total_input_tokens += usage.prompt_tokens
                total_output_tokens += usage.completion_tokens
                observability.log_llm_call(
                    query_id, iteration, fallback_messages, model, {"max_tokens": 1000},
                    response.choices[0].message.content, response.choices[0].finish_reason,
                    usage.prompt_tokens, usage.completion_tokens, latency_ms,
                )
                return _finish(response.choices[0].message.content)
        except APIStatusError as e:
            note = "rate limit" if e.status_code == 429 else f"API error ({e.status_code})"
            answer = f"Sorry, I hit a Groq {note} while working on this - please try again shortly."
            observability.log_error(query_id, "llm", str(e))
            return _finish(answer, error=str(e))

        latency_ms = (time.perf_counter() - t0) * 1000
        msg = response.choices[0].message
        usage = response.usage
        total_input_tokens += usage.prompt_tokens
        total_output_tokens += usage.completion_tokens
        observability.log_llm_call(
            query_id, iteration, messages, model, {"max_tokens": 1000, "tool_choice": tool_choice},
            msg.content, response.choices[0].finish_reason, usage.prompt_tokens, usage.completion_tokens, latency_ms,
        )

        if not msg.tool_calls:
            return _finish(msg.content)

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ],
        })

        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            query_text = args.get("query", "")
            if tc.function.name == "web_search":
                gate_state["web_called"] = True
            if on_tool_call:
                on_tool_call(tc.function.name, query_text)
            trace.append({"tool": tc.function.name, "input": query_text})

            t_tool = time.perf_counter()
            try:
                result_text, chunks, web_results, candidates = _execute_tool(
                    tc.function.name, query_text, vector_store, top_k, doc_sources, allowed_domains, blocked_domains
                )
            except Exception as e:
                observability.log_error(query_id, "tool", str(e))
                result_text, chunks, web_results, candidates = f"Tool '{tc.function.name}' failed: {e}", [], [], []
            tool_latency_ms = (time.perf_counter() - t_tool) * 1000
            observability.log_tool_call(query_id, iteration, tc.function.name, query_text, result_text, tool_latency_ms, "llm")

            if _has_repeated_tool_cycle(trace, tc.function.name, query_text):
                return _finish(
                    "The model kept reusing the same tool call, so I stopped the loop and returned the latest result instead of waiting forever.\n\n"
                    f"{result_text[:2000]}"
                )

            if tc.function.name == "search_documents":
                observability.log_retrieval_candidates(query_id, iteration, candidates)
                confidence = _top_confidence(chunks)
                if gate_state["confidence"] is None:
                    gate_state["confidence"] = confidence
                extra_text, extra_web = _run_confidence_gate(
                    query_text, confidence, threshold, web_enabled, gate_state,
                    allowed_domains, blocked_domains, query_id, iteration, on_tool_call,
                )
                result_text += extra_text
                web_results = web_results + extra_web
                if extra_text:
                    trace.append({"tool": "web_search", "input": query_text})

            doc_sources_used.extend(chunks)
            web_sources_used.extend(web_results)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result_text})

    observability.log_error(query_id, "other", "tool-call iteration limit reached")
    return _finish("I wasn't able to finish within the tool-call limit.")


def _run_claude_loop(question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
                      web_enabled, threshold, query_id, on_tool_call, hard_fail_on_no_document=False,
                      model=None):
    from anthropic import Anthropic, APIStatusError

    model = model or DEFAULT_CLAUDE_MODEL
    client = Anthropic()
    tools = TOOLS_SCHEMA if web_enabled else TOOLS_SCHEMA[:1]
    messages = [{"role": "user", "content": question}]
    doc_sources_used, web_sources_used, trace = [], [], []
    gate_state = {"web_called": False, "auto_triggered": False, "confidence": None}
    total_input_tokens = total_output_tokens = 0
    start_time = time.perf_counter()

    def _finish(answer, error=None):
        total_latency_ms = (time.perf_counter() - start_time) * 1000
        observability.finish_query(
            query_id, answer, _routing_path(doc_sources_used, web_sources_used),
            gate_state["confidence"], threshold, gate_state["auto_triggered"],
            total_latency_ms, total_input_tokens, total_output_tokens, model, error=error,
        )
        return answer, doc_sources_used, web_sources_used, trace

    for iteration in range(MAX_TOOL_ITERATIONS):
        # Force a real tool call on the first turn (see matching comment in
        # _run_groq_loop) so the model can't just narrate a fake search.
        tool_choice = {"type": "any"} if iteration == 0 else {"type": "auto"}
        t0 = time.perf_counter()
        try:
            response = client.messages.create(
                model=model, max_tokens=1000, system=SYSTEM_PROMPT, tools=tools,
                tool_choice=tool_choice, messages=messages,
            )
        except APIStatusError as e:
            note = "rate limit" if e.status_code == 429 else f"API error ({e.status_code})"
            answer = f"Sorry, I hit a Claude {note} while working on this - please try again shortly."
            observability.log_error(query_id, "llm", str(e))
            return _finish(answer, error=str(e))

        latency_ms = (time.perf_counter() - t0) * 1000
        usage = response.usage
        total_input_tokens += usage.input_tokens
        total_output_tokens += usage.output_tokens
        response_text = next((b.text for b in response.content if b.type == "text"), None)
        observability.log_llm_call(
            query_id, iteration, messages, model, {"max_tokens": 1000, "tool_choice": tool_choice},
            response_text, response.stop_reason, usage.input_tokens, usage.output_tokens, latency_ms,
        )

        if response.stop_reason != "tool_use":
            return _finish(response_text or "")

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            args = block.input
            query_text = args.get("query", "")
            if block.name == "web_search":
                gate_state["web_called"] = True
            if on_tool_call:
                on_tool_call(block.name, query_text)
            trace.append({"tool": block.name, "input": query_text})

            t_tool = time.perf_counter()
            try:
                result_text, chunks, web_results, candidates = _execute_tool(
                    block.name, query_text, vector_store, top_k, doc_sources, allowed_domains, blocked_domains
                )
            except Exception as e:
                observability.log_error(query_id, "tool", str(e))
                result_text, chunks, web_results, candidates = f"Tool '{block.name}' failed: {e}", [], [], []
            tool_latency_ms = (time.perf_counter() - t_tool) * 1000
            observability.log_tool_call(query_id, iteration, block.name, query_text, result_text, tool_latency_ms, "llm")

            if _has_repeated_tool_cycle(trace, block.name, query_text):
                return _finish(
                    "The model kept reusing the same tool call, so I stopped the loop and returned the latest result instead of waiting forever.\n\n"
                    f"{result_text[:2000]}"
                )

            if block.name == "search_documents":
                observability.log_retrieval_candidates(query_id, iteration, candidates)
                if hard_fail_on_no_document and not chunks:
                    return _finish(
                        "I could not find a relevant answer in the indexed documents. This query is configured to stop without web fallback."
                    )
                confidence = _top_confidence(chunks)
                if gate_state["confidence"] is None:
                    gate_state["confidence"] = confidence
                extra_text, extra_web = _run_confidence_gate(
                    query_text, confidence, threshold, web_enabled, gate_state,
                    allowed_domains, blocked_domains, query_id, iteration, on_tool_call,
                )
                result_text += extra_text
                web_results = web_results + extra_web
                if extra_text:
                    trace.append({"tool": "web_search", "input": query_text})

            doc_sources_used.extend(chunks)
            web_sources_used.extend(web_results)
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result_text})

        messages.append({"role": "user", "content": tool_results})

    observability.log_error(query_id, "other", "tool-call iteration limit reached")
    return _finish("I wasn't able to finish within the tool-call limit.")


def _run_huggingface_loop(question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
                         web_enabled, threshold, query_id, on_tool_call, hard_fail_on_no_document=False,
                         model=None):
    from huggingface_hub import InferenceClient

    model = model or DEFAULT_HUGGINGFACE_MODEL
    client = InferenceClient(model=model, token=HF_TOKEN, provider="featherless-ai")
    tools = TOOLS_SCHEMA if web_enabled else TOOLS_SCHEMA[:1]
    messages = [{"role": "user", "content": question}]
    doc_sources_used, web_sources_used, trace = [], [], []
    gate_state = {"web_called": False, "auto_triggered": False, "confidence": None}
    total_input_tokens = total_output_tokens = 0
    start_time = time.perf_counter()

    def _finish(answer, error=None):
        total_latency_ms = (time.perf_counter() - start_time) * 1000
        observability.finish_query(
            query_id, answer, _routing_path(doc_sources_used, web_sources_used),
            gate_state["confidence"], threshold, gate_state["auto_triggered"],
            total_latency_ms, total_input_tokens, total_output_tokens, model, error=error,
        )
        return answer, doc_sources_used, web_sources_used, trace

    for iteration in range(MAX_TOOL_ITERATIONS):
        tool_choice = "required" if iteration == 0 else "auto"
        t0 = time.perf_counter()
        try:
            response = client.chat_completion(
                messages=[{"role": "system", "content": SYSTEM_PROMPT}, *messages],
                model=model,
                max_tokens=1000,
                tools=tools,
                tool_choice=tool_choice,
            )
        except Exception as e:
            note = "rate limit" if "429" in str(e) or "rate limit" in str(e).lower() else "API error"
            answer = f"Sorry, I hit a Hugging Face {note} while working on this - please try again shortly."
            observability.log_error(query_id, "llm", str(e))
            latency_ms = (time.perf_counter() - t0) * 1000
            observability.log_llm_call(
                query_id, iteration, messages, model, {"max_tokens": 1000, "tool_choice": tool_choice},
                None, "error", 0, 0, latency_ms,
            )
            return _finish(answer, error=str(e))

        latency_ms = (time.perf_counter() - t0) * 1000
        message = getattr(response, "choices", [None])[0].message if getattr(response, "choices", None) else None
        if message is None:
            answer = getattr(response, "content", "") or "I couldn't get a valid model response."
            observability.log_llm_call(
                query_id, iteration, messages, model, {"max_tokens": 1000, "tool_choice": tool_choice},
                answer, getattr(response, "finish_reason", None), 0, 0, latency_ms,
            )
            return _finish(answer)

        total_input_tokens += getattr(response, "usage", {}).get("prompt_tokens", 0) or 0
        total_output_tokens += getattr(response, "usage", {}).get("completion_tokens", 0) or 0
        observability.log_llm_call(
            query_id, iteration, messages, model, {"max_tokens": 1000, "tool_choice": tool_choice},
            getattr(message, "content", None), getattr(response, "finish_reason", None),
            getattr(response, "usage", {}).get("prompt_tokens", 0), getattr(response, "usage", {}).get("completion_tokens", 0), latency_ms,
        )

        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls:
            return _finish(getattr(message, "content", "") or "")

        messages.append({"role": "assistant", "content": getattr(message, "content", None), "tool_calls": [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in tool_calls
        ]})

        for tc in tool_calls:
            args = json.loads(tc.function.arguments)
            query_text = args.get("query", "")
            if tc.function.name == "web_search":
                gate_state["web_called"] = True
            if on_tool_call:
                on_tool_call(tc.function.name, query_text)
            trace.append({"tool": tc.function.name, "input": query_text})

            t_tool = time.perf_counter()
            try:
                result_text, chunks, web_results, candidates = _execute_tool(
                    tc.function.name, query_text, vector_store, top_k, doc_sources, allowed_domains, blocked_domains
                )
            except Exception as e:
                observability.log_error(query_id, "tool", str(e))
                result_text, chunks, web_results, candidates = f"Tool '{tc.function.name}' failed: {e}", [], [], []
            tool_latency_ms = (time.perf_counter() - t_tool) * 1000
            observability.log_tool_call(query_id, iteration, tc.function.name, query_text, result_text, tool_latency_ms, "llm")

            if _has_repeated_tool_cycle(trace, tc.function.name, query_text):
                return _finish(
                    "The model kept reusing the same tool call, so I stopped the loop and returned the latest result instead of waiting forever.\n\n"
                    f"{result_text[:2000]}"
                )

            if tc.function.name == "search_documents":
                observability.log_retrieval_candidates(query_id, iteration, candidates)
                confidence = _top_confidence(chunks)
                if gate_state["confidence"] is None:
                    gate_state["confidence"] = confidence
                extra_text, extra_web = _run_confidence_gate(
                    query_text, confidence, threshold, web_enabled, gate_state,
                    allowed_domains, blocked_domains, query_id, iteration, on_tool_call,
                )
                result_text += extra_text
                web_results = web_results + extra_web
                if extra_text:
                    trace.append({"tool": "web_search", "input": query_text})

            doc_sources_used.extend(chunks)
            web_sources_used.extend(web_results)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result_text})

    observability.log_error(query_id, "other", "tool-call iteration limit reached")
    return _finish("I wasn't able to finish within the tool-call limit.")


def _to_gemini_tools(tools_schema: list[dict]):
    from google.generativeai import types

    declarations = []
    for t in tools_schema:
        declarations.append(types.FunctionDeclaration(
            name=t["name"],
            description=t["description"],
            parameters=t["input_schema"],
        ))
    return [types.Tool(function_declarations=declarations)]


def _run_gemini_loop(question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
                    web_enabled, threshold, query_id, on_tool_call, hard_fail_on_no_document=False,
                    model=None):
    import google.generativeai as genai

    model = model or DEFAULT_GEMINI_MODEL
    doc_sources_used, web_sources_used, trace = [], [], []
    gate_state = {"web_called": False, "auto_triggered": False, "confidence": None}
    total_input_tokens = total_output_tokens = 0
    start_time = time.perf_counter()

    def _finish(answer, error=None):
        total_latency_ms = (time.perf_counter() - start_time) * 1000
        observability.finish_query(
            query_id, answer, _routing_path(doc_sources_used, web_sources_used),
            gate_state["confidence"], threshold, gate_state["auto_triggered"],
            total_latency_ms, total_input_tokens, total_output_tokens, model, error=error,
        )
        return answer, doc_sources_used, web_sources_used, trace

    if not GOOGLE_API_KEY:
        answer = "Gemini API key is missing. Set GOOGLE_API_KEY (or GEMINI_API_KEY) in your .env file."
        observability.log_error(query_id, "llm", answer)
        return _finish(answer, error=answer)

    genai.configure(api_key=GOOGLE_API_KEY)
    tools = _to_gemini_tools(TOOLS_SCHEMA if web_enabled else TOOLS_SCHEMA[:1])
    gemini_model = genai.GenerativeModel(model_name=model, tools=tools, system_instruction=SYSTEM_PROMPT)
    # A proper chat session keeps the full turn history for us - manually
    # replaying just the last exchange (as the old code did) meant the model
    # lost earlier tool results as soon as a query needed more than one
    # round-trip, so it would loop, contradict itself, or answer from thin air.
    chat = gemini_model.start_chat(history=[])

    next_message = question
    for iteration in range(MAX_TOOL_ITERATIONS):
        t0 = time.perf_counter()
        try:
            response = chat.send_message(next_message)
        except Exception as e:
            note = "rate limit" if "429" in str(e) or "rate limit" in str(e).lower() else "API error"
            answer = f"Sorry, I hit a Gemini {note} while working on this - please try again shortly."
            observability.log_error(query_id, "llm", str(e))
            return _finish(answer, error=str(e))

        latency_ms = (time.perf_counter() - t0) * 1000
        usage = getattr(response, "usage_metadata", None)
        prompt_tokens = getattr(usage, "prompt_token_count", 0) or 0
        completion_tokens = getattr(usage, "candidates_token_count", 0) or 0
        total_input_tokens += prompt_tokens
        total_output_tokens += completion_tokens

        parts = getattr(response.candidates[0].content, "parts", []) if getattr(response, "candidates", None) else []
        function_calls = [p.function_call for p in parts if getattr(p, "function_call", None)]
        text_parts = [p.text for p in parts if getattr(p, "text", None)]

        observability.log_llm_call(
            query_id, iteration, [], model, {},
            "\n".join(text_parts) or None, "tool_use" if function_calls else "stop",
            prompt_tokens, completion_tokens, latency_ms,
        )

        if not function_calls:
            return _finish("\n".join(text_parts) or "I couldn't get a valid Gemini response.")

        function_response_parts = []
        for fc in function_calls:
            args = dict(getattr(fc, "args", {}) or {})
            query_text = args.get("query", "")
            tool_name = getattr(fc, "name", "")
            if tool_name == "web_search":
                gate_state["web_called"] = True
            if on_tool_call:
                on_tool_call(tool_name, query_text)
            trace.append({"tool": tool_name, "input": query_text})

            t_tool = time.perf_counter()
            try:
                result_text, chunks, web_results, candidates = _execute_tool(
                    tool_name, query_text, vector_store, top_k, doc_sources, allowed_domains, blocked_domains
                )
            except Exception as e:
                observability.log_error(query_id, "tool", str(e))
                result_text, chunks, web_results, candidates = f"Tool '{tool_name}' failed: {e}", [], [], []
            tool_latency_ms = (time.perf_counter() - t_tool) * 1000
            observability.log_tool_call(query_id, iteration, tool_name, query_text, result_text, tool_latency_ms, "llm")

            if _has_repeated_tool_cycle(trace, tool_name, query_text):
                return _finish(
                    "The model kept reusing the same tool call, so I stopped the loop and returned the latest result instead of waiting forever.\n\n"
                    f"{result_text[:2000]}"
                )

            if tool_name == "search_documents":
                observability.log_retrieval_candidates(query_id, iteration, candidates)
                if hard_fail_on_no_document and not chunks:
                    return _finish(
                        "I could not find a relevant answer in the indexed documents. This query is configured to stop without web fallback."
                    )
                confidence = _top_confidence(chunks)
                if gate_state["confidence"] is None:
                    gate_state["confidence"] = confidence
                extra_text, extra_web = _run_confidence_gate(
                    query_text, confidence, threshold, web_enabled, gate_state,
                    allowed_domains, blocked_domains, query_id, iteration, on_tool_call,
                )
                result_text += extra_text
                web_results = web_results + extra_web
                if extra_text:
                    trace.append({"tool": "web_search", "input": query_text})

            doc_sources_used.extend(chunks)
            web_sources_used.extend(web_results)
            function_response_parts.append(
                genai.protos.Part(function_response=genai.protos.FunctionResponse(
                    name=tool_name, response={"content": result_text},
                ))
            )

        # Feed all tool results back as one turn - the chat session appends
        # this (and the model's next reply) to history automatically, so the
        # next iteration still has everything that came before.
        next_message = genai.protos.Content(parts=function_response_parts)

    observability.log_error(query_id, "other", "tool-call iteration limit reached")
    return _finish("I wasn't able to finish within the tool-call limit.")


def _run_openrouter_loop(question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
                        web_enabled, threshold, query_id, on_tool_call, hard_fail_on_no_document=False,
                        model=None):
    import requests

    model = model or DEFAULT_OPENROUTER_MODEL
    doc_sources_used, web_sources_used, trace = [], [], []
    gate_state = {"web_called": False, "auto_triggered": False, "confidence": None}
    start_time = time.perf_counter()

    def _finish(answer, input_tokens=0, output_tokens=0, error=None):
        total_latency_ms = (time.perf_counter() - start_time) * 1000
        observability.finish_query(
            query_id, answer, _routing_path(doc_sources_used, web_sources_used),
            gate_state["confidence"], threshold, gate_state["auto_triggered"],
            total_latency_ms, input_tokens, output_tokens, model, error=error,
        )
        return answer, doc_sources_used, web_sources_used, trace

    if not OPENROUTER_API_KEY:
        answer = "OpenRouter API key is missing. Set OPENROUTER_API_KEY in your .env file."
        observability.log_error(query_id, "llm", answer)
        observability.log_llm_call(query_id, 0, [], model, {}, answer, "error", 0, 0, 0.0)
        return _finish(answer, error=answer)

    if on_tool_call:
        on_tool_call("search_documents", question)
    trace.append({"tool": "search_documents", "input": question})

    t_tool = time.perf_counter()
    try:
        doc_text, chunks, web_results, candidates = _execute_tool(
            "search_documents", question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains
        )
    except Exception as e:
        observability.log_error(query_id, "tool", str(e))
        doc_text, chunks, web_results, candidates = f"Tool 'search_documents' failed: {e}", [], [], []
    tool_latency_ms = (time.perf_counter() - t_tool) * 1000
    observability.log_tool_call(query_id, 0, "search_documents", question, doc_text, tool_latency_ms, "llm")
    observability.log_retrieval_candidates(query_id, 0, candidates)
    doc_sources_used.extend(chunks)

    if hard_fail_on_no_document and not chunks:
        answer = "I could not find a relevant answer in the indexed documents. This query is configured to stop without web fallback."
        observability.log_llm_call(
            query_id, 0, [{"role": "user", "content": f"Question: {question}\n\nContext:\n{doc_text}"}],
            model, {}, answer, "hard_fail_no_document", 0, 0, 0.0,
        )
        return _finish(answer)

    gate_state["confidence"] = _top_confidence(chunks)
    extra_text, extra_web = _run_confidence_gate(
        question, gate_state["confidence"], threshold, web_enabled, gate_state,
        allowed_domains, blocked_domains, query_id, 0, on_tool_call,
    )
    if extra_text:
        doc_text += extra_text
        web_results = web_results + extra_web
        trace.append({"tool": "web_search", "input": question})
    web_sources_used.extend(web_results)

    system_message = SYSTEM_PROMPT + "\n\nUse the knowledge in the context below. If the information is insufficient, say so clearly."
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": f"Question: {question}\n\nContext:\n{doc_text}"},
        ],
        # Reasoning models on OpenRouter's free tier (e.g. gpt-oss-20b:free)
        # otherwise fall back to a small provider-side default, spend the
        # whole budget on internal reasoning, and return an empty `content`
        # with the answer half-formed. Also ask the provider to keep
        # reasoning out of the response so `content` gets the final answer.
        "max_tokens": 2048,
        "reasoning": {"effort": "low", "exclude": True},
    }
    t0 = time.perf_counter()
    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://localhost",
                "X-Title": "Edukripa RAG",
            },
            json=payload,
            timeout=120,
        )
    except requests.RequestException as e:
        answer = f"Sorry, I hit a network error reaching OpenRouter while working on this - please try again shortly."
        observability.log_error(query_id, "llm", str(e))
        latency_ms = (time.perf_counter() - t0) * 1000
        observability.log_llm_call(
            query_id, 0, payload["messages"], model, {}, None, "network_error", 0, 0, latency_ms,
        )
        return _finish(answer, error=str(e))
    latency_ms = (time.perf_counter() - t0) * 1000

    if response.status_code >= 400:
        msg = response.text[:500]
        answer = f"Sorry, I hit an OpenRouter API error ({response.status_code}): {msg}"
        observability.log_error(query_id, "llm", msg)
        observability.log_llm_call(
            query_id, 0, payload["messages"], model, {}, None, f"error_{response.status_code}", 0, 0, latency_ms,
        )
        return _finish(answer, error=msg)

    output = response.json()
    usage = output.get("usage") or {}
    input_tokens = usage.get("prompt_tokens", 0) or 0
    output_tokens = usage.get("completion_tokens", 0) or 0
    message = ((output.get("choices") or [{}])[0]).get("message") or {}
    finish_reason = (output.get("choices") or [{}])[0].get("finish_reason")
    answer = message.get("content") or None

    if not answer:
        # Reasoning models sometimes put the whole response in `reasoning`
        # and leave `content` empty (e.g. truncated before the final
        # answer). Fall back to that instead of a silent blank, and log
        # exactly why so it shows up in the dashboard/error bubble either way.
        reasoning = message.get("reasoning") or ""
        detail = f"finish_reason={finish_reason!r}" + (f"; reasoning: {reasoning[:500]}" if reasoning else "")
        observability.log_error(query_id, "llm", f"OpenRouter returned empty content ({detail})")
        if reasoning:
            answer = reasoning

    observability.log_llm_call(
        query_id, 0, payload["messages"], model, {}, answer,
        finish_reason, input_tokens, output_tokens, latency_ms,
    )
    return _finish(answer or "", input_tokens, output_tokens)


_LOOP_BY_PROVIDER = {
    "claude": _run_claude_loop,
    "groq": _run_groq_loop,
    "huggingface": _run_huggingface_loop,
    "gemini": _run_gemini_loop,
    "openrouter": _run_openrouter_loop,
}


def answer_question(
    vector_store: VectorStore,
    question: str,
    provider: str | None = None,
    model: str | None = None,
    top_k: int = 5,
    doc_sources: list[str] | None = None,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
    web_enabled: bool = True,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    hard_fail_on_no_document: bool = False,
    session_id: str = "default",
    on_tool_call=None,
) -> dict:
    """
    provider: which LLM provider to use for this call ('groq', 'claude',
        'huggingface', 'gemini', 'openrouter'). Defaults to the
        .env-configured ACTIVE_PROVIDER (see config.py).
    model: which model to use for the chosen provider. Defaults to that
        provider's .env-configured (or built-in) default model.
    doc_sources: restrict search_documents to these filenames (None/empty = all indexed docs)
    allowed_domains/blocked_domains: restrict web_search results (None/empty = unrestricted)
    web_enabled: if False, the model only gets the search_documents tool
    confidence_threshold: below this, web_search is auto-triggered by code
        after search_documents runs, regardless of what the model decides
    session_id: groups queries together for the observability dashboard
    on_tool_call: optional callback(tool_name, query) fired the moment each tool call is dispatched

    Before any of that: unless GUARDRAIL_ENABLED=false, the question first
    passes through query_scope_and_age_guardrail.check_query_in_scope_and_age_appropriate().
    A blocked question short-circuits here with a friendly refusal - no
    retrieval, no tool calls, no LLM call at all (see that module's docstring
    for why this deliberately avoids an extra LLM call).
    """
    resolved_provider = provider or DEFAULT_PROVIDER
    loop = _LOOP_BY_PROVIDER.get(resolved_provider)
    if loop is None:
        raise ValueError(
            f"Unknown provider {resolved_provider!r} (expected one of {sorted(_LOOP_BY_PROVIDER)})"
        )
    resolved_model = model or _DEFAULT_MODEL_BY_PROVIDER[resolved_provider]

    logger.debug(f"answer_question: provider={resolved_provider} model={resolved_model} question={question!r} top_k={top_k}")
    query_id = observability.start_query(session_id, question, resolved_provider, resolved_model)

    if guardrail_enabled():
        guardrail_decision = check_query_in_scope_and_age_appropriate(question)
        if not guardrail_decision.allowed:
            observability.finish_query(
                query_id, guardrail_decision.refusal_message, "blocked_by_guardrail",
                None, confidence_threshold, False, 0.0, 0, 0, resolved_model,
                error=f"guardrail: {guardrail_decision.reason}",
            )
            return {
                "answer": guardrail_decision.refusal_message,
                "doc_sources": [],
                "web_sources": [],
                "trace": [],
                "query_id": query_id,
            }

    answer, docs, webs, trace = loop(
        question, vector_store, top_k, doc_sources, allowed_domains, blocked_domains,
        web_enabled, confidence_threshold, query_id, on_tool_call, hard_fail_on_no_document,
        model=resolved_model,
    )

    summary = observability.get_query(query_id)
    if summary:
        logger.info(
            f"query #{query_id} done: provider={resolved_provider} model={resolved_model} "
            f"tokens_in={summary.get('total_input_tokens')} tokens_out={summary.get('total_output_tokens')} "
            f"latency_ms={round(summary.get('total_latency_ms') or 0)} "
            f"cost_usd={summary.get('estimated_cost_usd')} routing={summary.get('routing_path')}"
        )

    return {
        "answer": answer,
        "doc_sources": [
            {
                "source": c["source"],
                "page": c["page"],
                "page_end": c.get("page_end", c["page"]),
                "distance": round(c["distance"], 3),
                "text": c["text"],
            }
            for c in docs
        ],
        "web_sources": webs,
        "trace": trace,
        "query_id": query_id,
    }
