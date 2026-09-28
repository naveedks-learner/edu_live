# Plan: Split monolith into ingestion / retrieval / query_engine / config

Decisions locked in from brainstorm:
1. Chroma stays (LanceDB was a naming mistake).
2. `VectorStore` moves into a 5th shared low-level file (`store.py`), imported by both `ingestion` and `retrieval`.
3. `web_search` stays subordinate to document search — no parallel/auto-fire path; only called when doc results are insufficient (confidence gate / model-requested fallback), and lives under `query_engine` (it's a tool call, not a retrieval concern).
4. Provider/model selection becomes an explicit parameter into `answer_question(...)` — no more `app.py` poking `rag.LLM_PROVIDER` module globals.
5. Delete dead code: `provider_registry.py`, `provider_handlers.py`, `providers/factory.py` (and the now-empty `providers/` package, `providers/status.py` if nothing else uses it — verify first).
6. Delete `app_1.py` (confirmed unused backup).
7. `rag.py`'s CLI `__main__` REPL becomes a new thin `src/cli.py`; `python src/rag.py` goes away, `python src/cli.py` replaces it. Document as a breaking rename.
8. Ollama becomes the default provider when `ACTIVE_PROVIDER` is unset.

---

## Target file layout

```
src/
  config.py          # was llm_config.py (renamed for clarity)
  store.py           # NEW - VectorStore class only (Chroma client, add_chunks, query*, get_chunk_metadata, all_chunks, list_sources)
  ingestion.py        # was main.py + pdf_parser.py + chunker.py content, orchestration
  retrieval.py        # query-side helpers: _page_label, search_documents tool logic (calls store.py)
  query_engine.py      # SYSTEM_PROMPT, TOOLS_SCHEMA, confidence gate, routing, all _run_*_loop, answer_question()
  web_search.py        # unchanged, now conceptually owned/imported by query_engine only
  cli.py              # NEW - thin __main__ REPL, was rag.py's bottom block
  app.py              # updated: imports config/store/query_engine, passes provider/model explicitly
  observability.py, observability_dashboard.py, voice_input.py   # unchanged
```

Removed: `rag.py` (split away), `app_1.py`, `provider_registry.py`, `provider_handlers.py`, `providers/` package.

`pdf_parser.py` and `chunker.py`: fold into `ingestion.py` as internal functions (they're small, single-purpose, and only ever called from the indexing path) — OR keep as-is and have `ingestion.py` just import them. **Lean toward keeping them separate files** (they're already clean single-responsibility modules at 42/91 lines) and have `ingestion.py` be the thin orchestrator (`index_pdf`/`index_all`) that imports `pdf_parser`, `chunker`, `store`. This avoids pointless code churn on files that aren't part of the problem.

## Module contents in detail

### `config.py` (renamed from `llm_config.py`)
- Everything unchanged except:
  - `_provider_order()` and the unset-`ACTIVE_PROVIDER` fallback in `get_active_provider_settings()` change default from `"openrouter"` → `"ollama"`.
  - No other logic changes — this file is already a clean leaf.

### `store.py` (new, extracted from `vector_store.py`)
- `VectorStore` class moved verbatim (rename file only, not class).
- No import of `config`, `ingestion`, `retrieval`, or `query_engine` — stays a leaf so both `ingestion.py` and `retrieval.py` can import it safely without a cycle.

### `ingestion.py` (was `main.py`)
- `index_pdf()`, `index_all()` moved as-is.
- Imports `pdf_parser.extract_pages`, `chunker.chunk_text`, `store.VectorStore`.
- Keeps its own `__main__` block (`python src/ingestion.py [pdf]`) — this is a second, deliberate breaking rename from `main.py`; call out to user.

### `retrieval.py` (new, extracted from `vector_store.py` read-methods + `rag.py`'s doc-search half of `_execute_tool`)
- `_page_label()` moved here (only used for formatting retrieved chunks).
- A `search_documents(vector_store, query_text, top_k, doc_sources)` function extracted from `_execute_tool`'s first branch — returns `(text_for_model, kept_chunks, all_candidates)`.
- Imports `store.VectorStore` for typing only, does NOT instantiate it — `query_engine`/`app.py` own the single instance and pass it in.

### `query_engine.py` (was the bulk of `rag.py`)
- `SYSTEM_PROMPT`, `TOOLS_SCHEMA` moved as-is.
- `_run_confidence_gate`, `_routing_path`, `_has_repeated_tool_cycle`, `_to_groq_tools`, `_to_gemini_tools`, `_groq_chat_with_retry` moved as-is.
- `_execute_tool` simplified: `search_documents` branch now delegates to `retrieval.search_documents(...)`; `web_search` branch stays local (it's a tool, and per decision #3 must remain the fallback-only path, never parallel-fired with doc search).
- All six `_run_*_loop` functions moved as-is, each still doing: search_documents → confidence gate (may trigger web_search) → provider call. No structural change to the fallback-only sequencing — it already matches decision #3, just relocating code.
- `answer_question()` signature changes:
  ```python
  def answer_question(
      vector_store, question, *,
      provider: str | None = None,      # NEW - explicit override, falls back to config.get_active_provider_settings().name
      model: str | None = None,         # NEW - explicit override, falls back to that provider's configured model
      top_k=5, doc_sources=None, allowed_domains=None, blocked_domains=None,
      web_enabled=True, confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD,
      hard_fail_on_no_document=False, session_id="default", on_tool_call=None,
  ) -> dict:
  ```
  Internally resolves `provider`/`model` once at the top (falling back to `config.get_active_provider_settings()` when not passed), then dispatches to the matching `_run_*_loop` exactly as today. No more reading `rag.LLM_PROVIDER` as a mutable module global — `app.py` passes the sidebar's current selection straight through instead of mutating anything.
- Per-provider `*_MODEL` module constants (`GROQ_MODEL`, `OLLAMA_MODEL`, etc.) stay as fallback defaults for CLI use, but are no longer written to from outside the module.

### `cli.py` (new, was `rag.py`'s `__main__` block)
- The REPL loop (`while True: question = input(...)`) and its provider/API-key sanity check, unchanged logic.
- Imports `query_engine.answer_question`, `store.VectorStore`, `config.get_active_provider_settings`.
- Entry point becomes `python src/cli.py`.

### `app.py`
- Update imports: `config` (was `llm_config`), `store.VectorStore` (was `vector_store`), `query_engine.answer_question` (was `rag.answer_question`), `ingestion.index_all` (was `main.index_all`).
- Remove the `rag.LLM_PROVIDER = provider` / `rag.OPENROUTER_MODEL = selected_model` / etc. mutation block entirely.
- Sidebar's selectbox result (`provider`, `selected_model`) gets passed straight into `answer_question(store, question, provider=provider, model=selected_model, ...)` at the call site instead.
- Dropdown option list: switch from the hardcoded `provider_choices = [...]` to `config.build_provider_options()` (fixes the root cause of the earlier Ollama-not-showing bug for good, instead of just appending "ollama" to a second hardcoded list).
- Delete `app_1.py`.

## Deletions
- `src/rag.py` → replaced by `query_engine.py` + `cli.py`.
- `src/main.py` → replaced by `ingestion.py`.
- `src/app_1.py` → deleted outright (confirmed unused).
- `src/provider_registry.py`, `src/provider_handlers.py`, `src/providers/` (factory.py + status.py + `__init__.py`) → deleted; verify nothing else imports `providers.status.get_provider_status` before removing (grep first, since it wasn't traced back to a caller during brainstorm but wasn't exhaustively ruled out either).

## Verification steps (after each stage)
1. `python -m py_compile` every touched/new file.
2. `python src/ingestion.py` (or targeted PDF) — confirm indexing still writes to the same `chroma_db` persist dir with no schema change.
3. `python src/cli.py` — smoke-test one question end-to-end with Ollama as default (no `.env` override).
4. `streamlit run src/app.py` — confirm sidebar shows all providers via `build_provider_options()`, Ollama selected by default, switching provider still routes correctly with no leftover `rag.*` global references.
5. Grep the whole `src/` tree for `import rag`, `from rag`, `import main`, `from main`, `llm_config`, `vector_store` post-rename to catch stale references before calling it done.

## Rollout order (small, testable increments)
1. Extract `store.py` from `vector_store.py`; update `main.py`'s import only (no behavior change) — verify indexing still works.
2. Rename `llm_config.py` → `config.py`, flip default provider to `"ollama"`; update its one caller (`rag.py`) and app imports — verify `get_active_provider_settings()` behavior via a quick script.
3. Extract `retrieval.py` from `vector_store.py` (read methods) + pull doc-search half of `_execute_tool` out of `rag.py`; update `rag.py` to call into it — verify no behavior change via existing CLI.
4. Rename `rag.py` → `query_engine.py`, carve out `cli.py`'s `__main__` block; change `answer_question` signature to accept `provider`/`model` overrides — verify CLI still answers correctly.
5. Rename `main.py` → `ingestion.py` — verify indexing unchanged.
6. Update `app.py` to the new imports/signature, delete the `rag.*` global-mutation block, switch dropdown to `build_provider_options()`.
7. Delete `app_1.py`, `provider_registry.py`, `provider_handlers.py`, `providers/` (after confirming no remaining imports).
8. Final full grep sweep + manual smoke test of both CLI and Streamlit paths.
