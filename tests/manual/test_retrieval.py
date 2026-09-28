"""
Quality check: auto-samples questions from whatever is currently indexed
in the real ./chroma_db (via question_sampler - no hardcoded questions),
runs retrieval for each, and asserts top-k results are non-empty and
attributed to the correct source document. New documents ingested since
the last run are picked up automatically because sampling reads the live
store at run time.
"""

import os
import fixtures  # sets up sys.path for the flat src/ imports below
from store import VectorStore
from retrieval import search_documents
from question_sampler import sample_questions


def test_retrieval_returns_results_for_sampled_questions():
    # VectorStore()'s default persist_dir is relative to CWD - anchor it to
    # the project root so this suite works regardless of where it's run from.
    store = VectorStore(persist_dir=os.path.join(fixtures.PROJECT_ROOT, "chroma_db"))
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
