"""
Sanity check: sends a real question through the full agentic loop with
the .env-configured API provider and asserts we got a non-empty,
non-error, relevant answer with no exception. "Relevant" means: shares a
keyword with the question, and is semantically close (embedding cosine
similarity) to the retrieved source chunk - see relevance_check.py.
Requires the active provider's API key to be set (see config.py) -
skipped, not failed, when it's missing, same as test_runner.py's old
Ollama-reachability check.
"""

import os

import fixtures  # sets up sys.path
from store import VectorStore
from question_sampler import sample_questions
from query_engine import answer_question
from relevance_check import is_relevant
from config import get_active_provider_settings, REQUIRED_KEY_BY_PROVIDER

_ERROR_PREFIXES = ("Sorry, I hit a",)


def active_provider_key_available() -> bool:
    settings = get_active_provider_settings()
    required_key = REQUIRED_KEY_BY_PROVIDER.get(settings.name)
    return not required_key or bool(settings.api_key)


def test_llm_answers_sampled_question():
    # VectorStore()'s default persist_dir is relative to CWD - anchor it to
    # the project root so this suite works regardless of where it's run from.
    store = VectorStore(persist_dir=os.path.join(fixtures.PROJECT_ROOT, "chroma_db"))
    all_chunks = store.all_chunks()
    assert all_chunks, "./chroma_db has no indexed chunks - run `python src/ingestion.py` first"

    questions = sample_questions(all_chunks, per_doc=1)
    assert questions, "question_sampler produced 0 questions from the indexed chunks"
    question = questions[0]["query"]

    result = answer_question(store, question, web_enabled=False)
    answer = result.get("answer") or ""

    assert answer.strip(), f"empty answer for question {question!r}"
    assert not answer.startswith(_ERROR_PREFIXES), f"LLM call errored out: {answer}"

    doc_sources = result.get("doc_sources") or []
    if doc_sources:
        context_text = doc_sources[0]["text"]
        ok, reason = is_relevant(question, answer, context_text)
        assert ok, f"answer not relevant to question {question!r}: {reason}\nanswer={answer!r}"
