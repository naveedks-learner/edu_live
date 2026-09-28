# Manual Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, manually-triggered test suite (`tests/manual/`) that gives confidence nothing broke across ingestion, retrieval, and LLM response, without ever auto-wiring into CI/pytest discovery.

**Architecture:** Plain Python scripts (no pytest), each exposing `test_*` functions that assert and raise `AssertionError` on failure. `test_runner.py` reflects over each suite module, runs every `test_*` function, catches exceptions, and prints a pass/fail/skip summary per suite. Retrieval questions are sampled live from the real `chroma_db/` collection at run time via a small pure helper (`question_sampler.py`), so newly-ingested docs are covered automatically with no hardcoded questions.

**Tech Stack:** Python 3, existing project deps only (chromadb, sentence-transformers, ollama client) — no new dependencies, no pytest dependency for these files (avoids pytest auto-discovery, keeps this suite opt-in/manual per the user's requirement).

**Spec:** Design agreed in-chat during brainstorming (see conversation) — no separate spec doc; user approved the summarized design directly.

## Global Constraints

- Never use pytest decorators/fixtures/`assert` auto-rewriting for these files — plain functions + explicit `raise AssertionError(...)`, so nothing here is picked up by an incidental `pytest` run elsewhere in the repo.
- `tests/manual/` is a new subpackage; existing `tests/test_rag_provider_config.py` (pytest-based) is untouched.
- Ingestion tests must use a scratch/temp Chroma dir — never write to the real `./chroma_db`.
- Retrieval tests read the real `./chroma_db` (must already be populated by the user via `python src/ingestion.py`) and must not hardcode questions — sample from `VectorStore.all_chunks()` at run time.
- LLM tests use `provider="ollama"` and must detect an unreachable Ollama server and SKIP (not FAIL) those tests, with a clear printed reason.
- `test_runner.py` lives at the repo root (mirrors how `src/ingestion.py` is documented to be run — a single obvious entry point: `python test_runner.py`).
- Follow TDD for the one piece of new, non-trivial logic with a pure input/output contract: `question_sampler.sample_questions`. The other files are themselves the "tests" (integration checks against existing modules) — there is no separate production code under them to drive with a red/green cycle; write them directly and verify by running.

---

### Task 1: `question_sampler.py` — auto-question generation (TDD)

**Files:**
- Create: `tests/manual/question_sampler.py`
- Create: `tests/manual/test_question_sampler.py` (TDD unit test — pure function, fake store, no real Chroma)

**Interfaces:**
- Produces: `sample_questions(chunks: list[dict], per_doc: int = 2) -> list[dict]`
  - Input `chunks`: list of dicts shaped like `VectorStore.all_chunks()` output — each has at least `"text"` and `"source"`.
  - Output: list of `{"source": str, "query": str, "chunk_id": int | None}`, up to `per_doc` entries per distinct `source`.
  - `query` is derived from the chunk's `text`: first sentence (split on `". "`), truncated to the first 12 words, whitespace-normalized. Skips chunks whose derived query is empty/too short (< 3 words) rather than emitting a junk query.
  - Later tasks (`test_retrieval.py`, `test_llm.py`) call this with `store.all_chunks()`.

- [ ] **Step 1: Write the failing test**

```python
# tests/manual/test_question_sampler.py
from question_sampler import sample_questions


def test_sample_questions_picks_per_doc_limit():
    chunks = [
        {"source": "a.pdf", "chunk_id": 0, "text": "Photosynthesis is the process plants use to make food. More text here about chlorophyll and sunlight absorption in leaves."},
        {"source": "a.pdf", "chunk_id": 1, "text": "The mitochondria is the powerhouse of the cell. Extra filler words to pad this chunk out further."},
        {"source": "a.pdf", "chunk_id": 2, "text": "A third chunk from the same document that should be dropped by the per_doc limit of two."},
        {"source": "b.pdf", "chunk_id": 0, "text": "Light travels in straight lines called rays. This is the basis of the rectilinear propagation of light."},
    ]

    result = sample_questions(chunks, per_doc=2)

    sources = [q["source"] for q in result]
    assert sources.count("a.pdf") == 2
    assert sources.count("b.pdf") == 1
    assert all(q["query"] for q in result)


def test_sample_questions_skips_too_short_text():
    chunks = [
        {"source": "a.pdf", "chunk_id": 0, "text": "ok"},
        {"source": "a.pdf", "chunk_id": 1, "text": "This is a properly long first sentence to use as a query. Trailing text."},
    ]

    result = sample_questions(chunks, per_doc=2)

    assert len(result) == 1
    assert result[0]["chunk_id"] == 1


def test_sample_questions_truncates_to_12_words():
    chunks = [{
        "source": "a.pdf", "chunk_id": 0,
        "text": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen. next sentence.",
    }]

    result = sample_questions(chunks, per_doc=1)

    assert len(result[0]["query"].split()) <= 12
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m tests.manual.test_question_sampler` won't work for bare asserts — instead run directly:
```bash
cd tests/manual && python -c "import test_question_sampler as t; t.test_sample_questions_picks_per_doc_limit(); t.test_sample_questions_skips_too_short_text(); t.test_sample_questions_truncates_to_12_words(); print('all passed')"
```
Expected: `ModuleNotFoundError: No module named 'question_sampler'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```python
# tests/manual/question_sampler.py
"""
Pure helper: turns already-indexed chunks into retrieval test questions,
so test_retrieval.py never hardcodes questions - any newly-ingested
document is covered automatically the next time the suite runs.
"""


def sample_questions(chunks: list[dict], per_doc: int = 2) -> list[dict]:
    per_source_count: dict[str, int] = {}
    questions = []

    for chunk in chunks:
        source = chunk["source"]
        if per_source_count.get(source, 0) >= per_doc:
            continue

        first_sentence = chunk["text"].split(". ")[0]
        words = first_sentence.split()
        if len(words) < 3:
            continue

        query = " ".join(words[:12]).strip()
        questions.append({"source": source, "query": query, "chunk_id": chunk.get("chunk_id")})
        per_source_count[source] = per_source_count.get(source, 0) + 1

    return questions
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd tests/manual && python -c "import test_question_sampler as t; t.test_sample_questions_picks_per_doc_limit(); t.test_sample_questions_skips_too_short_text(); t.test_sample_questions_truncates_to_12_words(); print('all passed')"
```
Expected: `all passed`

- [ ] **Step 5: Commit**

```bash
git add tests/manual/question_sampler.py tests/manual/test_question_sampler.py
git commit -m "test: add auto-question sampler for manual retrieval suite"
```

---

### Task 2: `fixtures.py` — scratch vector store helper

**Files:**
- Create: `tests/manual/fixtures.py`

**Interfaces:**
- Consumes: `store.VectorStore` (constructor: `VectorStore(persist_dir, collection_name, embedding_model=None)`) — from `src/store.py`, added to `sys.path` via the same pattern `ingestion.py` uses (flat imports, no package prefix).
- Produces:
  - `scratch_store() -> contextlib.AbstractContextManager[VectorStore]` — a context manager yielding a `VectorStore` backed by a fresh temp directory, deleted on exit (success or failure).
  - `SAMPLE_PDF: str` — absolute path to `data/light notes.pdf` (smallest of the 3 indexed PDFs, ~520KB), resolved relative to the repo root regardless of CWD.
  - `PROJECT_ROOT: str`, `SRC_DIR: str` — used by the other suite files to extend `sys.path` before importing `ingestion`/`chunker`/`pdf_parser`/`store`/`retrieval`/`query_engine`.

- [ ] **Step 1: Implement directly** (test-infrastructure, not production logic under test — verified by Task 3 actually using it against a real temp dir)

```python
# tests/manual/fixtures.py
"""
Shared test-only helpers: path setup so the suite can import the flat
`src/` modules the same way ingestion.py/cli.py do, plus a scratch
VectorStore so ingestion tests never touch the real ./chroma_db.
"""

import contextlib
import os
import shutil
import sys
import tempfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

SAMPLE_PDF = os.path.join(PROJECT_ROOT, "data", "light notes.pdf")


@contextlib.contextmanager
def scratch_store():
    """Yields a VectorStore backed by a fresh temp dir; deletes it on exit."""
    from store import VectorStore

    tmp_dir = tempfile.mkdtemp(prefix="rag_test_scratch_")
    try:
        yield VectorStore(persist_dir=tmp_dir, collection_name="test_chunks")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
```

- [ ] **Step 2: Sanity-check by hand**

```bash
cd tests/manual && python -c "
from fixtures import scratch_store, SAMPLE_PDF
import os
assert os.path.isfile(SAMPLE_PDF), SAMPLE_PDF
with scratch_store() as s:
    assert s.list_sources() == set()
print('fixtures ok')
"
```
Expected: `fixtures ok` (first run downloads the embedding model if not cached — this is expected, not a failure).

- [ ] **Step 3: Commit**

```bash
git add tests/manual/fixtures.py
git commit -m "test: add scratch VectorStore fixture for manual suite"
```

---

### Task 3: `test_ingestion.py` — ingestion smoke test

**Files:**
- Create: `tests/manual/test_ingestion.py`

**Interfaces:**
- Consumes: `fixtures.scratch_store`, `fixtures.SAMPLE_PDF`; `pdf_parser.extract_pages(pdf_path) -> list[dict]`; `chunker.chunk_text(pages, source, chunk_size, overlap) -> list[dict]`; `store.VectorStore.add_chunks(chunks)`, `.list_sources() -> set[str]`.
- Produces: `test_extract_pages_smoke()`, `test_chunk_text_smoke()`, `test_index_write_smoke()` — each raises `AssertionError` with a descriptive message on failure, returns `None` on success. `test_runner.py` (Task 5) discovers these by name.

- [ ] **Step 1: Write the test functions**

```python
# tests/manual/test_ingestion.py
"""
Smoke test: load a sample PDF, chunk it, embed it into a scratch vector
store, and confirm each stage produced sane output. Never touches the
real ./chroma_db - see fixtures.scratch_store.
"""

import os
from fixtures import scratch_store, SAMPLE_PDF
from pdf_parser import extract_pages
from chunker import chunk_text


def test_extract_pages_smoke():
    pages = extract_pages(SAMPLE_PDF)
    assert pages, "extract_pages returned no pages for the sample PDF"
    assert all(p.get("text", "").strip() for p in pages), "at least one page had no extractable text"
    assert all(isinstance(p.get("page"), int) for p in pages), "every page dict must carry an int 'page' number"


def test_chunk_text_smoke():
    pages = extract_pages(SAMPLE_PDF)
    source = os.path.basename(SAMPLE_PDF)
    chunks = chunk_text(pages, source=source, chunk_size=220, overlap=60)

    assert chunks, "chunk_text produced 0 chunks for a non-empty PDF"
    assert all(c["text"].strip() for c in chunks), "found a chunk with empty text"
    assert all(c["source"] == source for c in chunks), "chunk 'source' must match the input filename"
    assert all(c["word_end"] > c["word_start"] for c in chunks), "every chunk must span a non-empty word range"


def test_index_write_smoke():
    pages = extract_pages(SAMPLE_PDF)
    source = os.path.basename(SAMPLE_PDF)
    chunks = chunk_text(pages, source=source, chunk_size=220, overlap=60)

    with scratch_store() as store:
        store.add_chunks(chunks)
        assert source in store.list_sources(), "indexed source not found in store.list_sources() after add_chunks"
        all_chunks = store.all_chunks()
        assert len(all_chunks) == len(chunks), (
            f"expected {len(chunks)} chunks written, found {len(all_chunks)} in the store"
        )
```

- [ ] **Step 2: Run it directly to confirm it passes against real code**

```bash
cd tests/manual && python -c "
import test_ingestion as t
t.test_extract_pages_smoke()
t.test_chunk_text_smoke()
t.test_index_write_smoke()
print('all passed')
"
```
Expected: `all passed`. (This is an integration check against already-working modules, not new production code — there is nothing to watch fail first; running it *is* the verification.)

- [ ] **Step 3: Commit**

```bash
git add tests/manual/test_ingestion.py
git commit -m "test: add ingestion smoke suite"
```

---

### Task 4: `test_retrieval.py` — retrieval quality check

**Files:**
- Create: `tests/manual/test_retrieval.py`

**Interfaces:**
- Consumes: `fixtures.PROJECT_ROOT`/`SRC_DIR` (path setup already done by importing `fixtures`); `store.VectorStore()` (real default `./chroma_db`); `question_sampler.sample_questions(chunks, per_doc=2)`; `retrieval.search_documents(vector_store, query_text, top_k, doc_sources) -> (text, kept, all_candidates)`.
- Produces: `test_retrieval_returns_results_for_sampled_questions()` — raises `AssertionError` listing every failing question (not just the first) so one bad chunk doesn't hide others.

- [ ] **Step 1: Write the test function**

```python
# tests/manual/test_retrieval.py
"""
Quality check: auto-samples questions from whatever is currently indexed
in the real ./chroma_db (via question_sampler - no hardcoded questions),
runs retrieval for each, and asserts top-k results are non-empty and
attributed to the correct source document. New documents ingested since
the last run are picked up automatically because sampling reads the live
store at run time.
"""

import fixtures  # noqa: F401 - sets up sys.path for the flat src/ imports below
from store import VectorStore
from retrieval import search_documents
from question_sampler import sample_questions


def test_retrieval_returns_results_for_sampled_questions():
    store = VectorStore()
    all_chunks = store.all_chunks()
    assert all_chunks, (
        "./chroma_db has no indexed chunks - run `python src/ingestion.py` first, "
        "this suite reads the real index and cannot fabricate one."
    )

    questions = sample_questions(all_chunks, per_doc=2)
    assert questions, "question_sampler produced 0 questions from the indexed chunks"

    failures = []
    for q in questions:
        _, kept, _ = search_documents(store, q["query"], top_k=5, doc_sources=None)
        if not kept:
            failures.append(f"[{q['source']}] query={q['query']!r} -> 0 results")
            continue
        kept_sources = {c["source"] for c in kept}
        if q["source"] not in kept_sources:
            failures.append(
                f"[{q['source']}] query={q['query']!r} -> top-{len(kept)} sources were {kept_sources}, "
                f"expected '{q['source']}' among them"
            )

    assert not failures, "retrieval quality failures:\n" + "\n".join(failures)
```

- [ ] **Step 2: Run it directly**

```bash
cd tests/manual && python -c "
import test_retrieval as t
t.test_retrieval_returns_results_for_sampled_questions()
print('all passed')
"
```
Expected: `all passed`, provided `python src/ingestion.py` has already been run against `data/`. If it fails on "no indexed chunks", run ingestion first, then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/manual/test_retrieval.py
git commit -m "test: add auto-sampled retrieval quality suite"
```

---

### Task 5: `test_llm.py` — LLM sanity check (Ollama)

**Files:**
- Create: `tests/manual/test_llm.py`

**Interfaces:**
- Consumes: `fixtures` (path setup); `store.VectorStore()`; `question_sampler.sample_questions`; `query_engine.answer_question(vector_store, question, provider="ollama", ...) -> dict` (keys: `"answer"`, `"doc_sources"`, `"web_sources"`, `"trace"`, `"query_id"`).
- Produces:
  - `ollama_reachable() -> bool` — used by `test_runner.py` to decide SKIP vs run.
  - `test_llm_answers_sampled_question()` — raises `AssertionError` on empty/error answer; the function itself assumes Ollama is reachable (runner checks first, see Task 6).

- [ ] **Step 1: Write the test functions**

```python
# tests/manual/test_llm.py
"""
Sanity check: sends a real question through the full agentic loop with
provider="ollama" and asserts we got a non-empty, non-error answer with
no exception. Requires a running local Ollama server - see
ollama_reachable(), used by test_runner.py to SKIP this suite instead of
failing it when Ollama isn't up.
"""

import socket

import fixtures  # noqa: F401 - sets up sys.path
from store import VectorStore
from question_sampler import sample_questions
from query_engine import answer_question

_OLLAMA_HOST = "localhost"
_OLLAMA_PORT = 11434

_ERROR_PREFIXES = (
    "Sorry, I hit a",
    "Sorry, I couldn't reach the local Ollama server",
)


def ollama_reachable() -> bool:
    try:
        with socket.create_connection((_OLLAMA_HOST, _OLLAMA_PORT), timeout=2):
            return True
    except OSError:
        return False


def test_llm_answers_sampled_question():
    store = VectorStore()
    all_chunks = store.all_chunks()
    assert all_chunks, "./chroma_db has no indexed chunks - run `python src/ingestion.py` first"

    questions = sample_questions(all_chunks, per_doc=1)
    assert questions, "question_sampler produced 0 questions from the indexed chunks"
    question = questions[0]["query"]

    result = answer_question(store, question, provider="ollama", web_enabled=False)
    answer = result.get("answer") or ""

    assert answer.strip(), f"empty answer for question {question!r}"
    assert not answer.startswith(_ERROR_PREFIXES), f"LLM call errored out: {answer}"
```

- [ ] **Step 2: Run it directly** (requires `ollama serve` running and the configured model pulled)

```bash
cd tests/manual && python -c "
import test_llm as t
assert t.ollama_reachable(), 'start ollama serve first'
t.test_llm_answers_sampled_question()
print('all passed')
"
```
Expected: `all passed`. If Ollama isn't running, `ollama_reachable()` returns `False` and the assert stops the script before hitting the network — this is intentional (Task 6's runner does the same check to SKIP instead of hard-failing).

- [ ] **Step 3: Commit**

```bash
git add tests/manual/test_llm.py
git commit -m "test: add Ollama LLM sanity suite"
```

---

### Task 6: `test_runner.py` — master runner

**Files:**
- Create: `test_runner.py` (repo root)

**Interfaces:**
- Consumes: `tests.manual.test_ingestion`, `tests.manual.test_retrieval`, `tests.manual.test_llm` (each imported as modules); `tests.manual.test_llm.ollama_reachable()`.
- Produces: a `main()` that prints a per-suite, per-test PASS/FAIL/SKIP report and a final summary line, and returns a process exit code (`0` if nothing failed, `1` otherwise) — script has no importable side effects at import time (all logic inside `main()`/helpers), guarded by `if __name__ == "__main__":`.

- [ ] **Step 1: Write the runner**

```python
# test_runner.py
"""
Standalone manual test suite runner - never auto-wired into pytest/CI.
Run on demand:
    python test_runner.py

Runs every test_*.py suite under tests/manual/, prints a pass/fail/skip
summary per suite, and exits 1 if anything failed (0 if all passed or
were skipped). The LLM suite is skipped, not failed, when no local
Ollama server is reachable.
"""

import importlib
import inspect
import os
import sys
import traceback

MANUAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "manual")
sys.path.insert(0, MANUAL_DIR)

SUITES = ["test_ingestion", "test_retrieval", "test_llm"]


def _test_functions(module):
    return [
        (name, fn) for name, fn in inspect.getmembers(module, inspect.isfunction)
        if name.startswith("test_") and fn.__module__ == module.__name__
    ]


def _run_suite(suite_name: str) -> tuple[int, int, int]:
    """Returns (passed, failed, skipped) for one suite."""
    print(f"\n=== {suite_name} ===")
    module = importlib.import_module(suite_name)

    if suite_name == "test_llm" and not module.ollama_reachable():
        for name, _ in _test_functions(module):
            print(f"  SKIP  {name}  (Ollama not reachable on localhost:11434)")
        return 0, 0, len(_test_functions(module))

    passed = failed = 0
    for name, fn in _test_functions(module):
        try:
            fn()
        except Exception as e:
            failed += 1
            print(f"  FAIL  {name}  {e}")
            if not isinstance(e, AssertionError):
                traceback.print_exc()
        else:
            passed += 1
            print(f"  PASS  {name}")
    return passed, failed, 0


def main() -> int:
    total_passed = total_failed = total_skipped = 0
    for suite_name in SUITES:
        passed, failed, skipped = _run_suite(suite_name)
        total_passed += passed
        total_failed += failed
        total_skipped += skipped

    print(f"\n=== summary: {total_passed} passed, {total_failed} failed, {total_skipped} skipped ===")
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it end-to-end**

```bash
python test_runner.py
```
Expected: prints `=== test_ingestion ===`, `=== test_retrieval ===`, `=== test_llm ===` sections each with PASS/FAIL/SKIP lines, then a summary line, exit code 0 if `chroma_db/` is populated (it is — 3 PDFs already indexed) regardless of whether Ollama is running (SKIP is not a failure).

- [ ] **Step 3: Commit**

```bash
git add test_runner.py
git commit -m "test: add master test runner for manual suite"
```

---

## Self-Review Notes

- **Coverage:** ingestion (extract/chunk/write) ✓, retrieval quality with auto-sampled questions ✓, LLM sanity with Ollama ✓, master runner with pass/fail/skip summary ✓, new-doc coverage via live sampling ✓, Ollama-required-vs-not flagged via `ollama_reachable()` ✓.
- **No pytest auto-wiring:** confirmed no `pytest`/`unittest` imports anywhere in these files; runner is invoked manually only.
- **Type/signature consistency:** `sample_questions(chunks, per_doc)` signature matches across Task 1 definition and Tasks 4/5 call sites. `search_documents` and `answer_question` signatures match their real definitions in `src/retrieval.py` / `src/query_engine.py` read during brainstorming.
