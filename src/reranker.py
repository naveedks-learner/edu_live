"""
Cross-encoder reranker: scores each (query, chunk) pair jointly, instead of
comparing two separately-computed embeddings the way cosine similarity does.

Why this exists: bi-encoder cosine similarity (see store.py) is not
well-calibrated as an absolute "is this relevant" score - two unrelated
passages routinely still score 0.6-0.8 "confidence", because the embedding
space clusters around generic "this is English text" signal rather than
spreading truly unrelated pairs down near 0. A cross-encoder reads the
query and the candidate text together in one forward pass, so it can
actually judge relevance rather than just proximity in embedding space,
and its scores separate relevant from irrelevant far more cleanly. This is
the standard second-stage fix for that miscalibration - see retrieval.py
for where this gets applied on top of the vector store's cosine ranking.
"""

import logging
import math

logger = logging.getLogger(__name__)

# Small (~80MB), CPU-friendly, trained on MS MARCO passage relevance -
# exactly the "does this passage answer this query" task we need here.
MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"

_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import CrossEncoder

        _model = CrossEncoder(MODEL_NAME)
    return _model


def rerank(query: str, candidates: list[dict]) -> list[dict]:
    """
    candidates: dicts with a "text" key (as returned by
    VectorStore.query_with_candidates - kept + discarded). Adds a
    "rerank_score" key to each (the cross-encoder's relevance logit,
    squashed through a sigmoid into [0, 1] so it reads like the cosine
    "confidence" score) and returns the list re-sorted by that score,
    most relevant first.

    Never raises: if the model can't be loaded/run (e.g. first download
    fails, offline), candidates come back in their original cosine order
    with rerank_score=None on every item, so callers can fall back to the
    cosine ranking instead of breaking retrieval entirely.
    """
    if not candidates:
        return candidates

    try:
        model = _get_model()
        pairs = [(query, c["text"]) for c in candidates]
        scores = model.predict(pairs)
    except Exception as e:
        logger.warning(f"rerank failed for query {query!r}, falling back to cosine order: {e}")
        for c in candidates:
            c["rerank_score"] = None
        return candidates

    for c, s in zip(candidates, scores):
        c["rerank_score"] = 1 / (1 + math.exp(-float(s)))

    candidates.sort(key=lambda c: c["rerank_score"], reverse=True)
    return candidates


if __name__ == "__main__":
    # quick manual sanity check: python reranker.py
    demo = [
        {"text": "Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, and Neptune are the eight planets."},
        {"text": "RAG pipelines chunk PDFs and embed them into a vector store for retrieval."},
    ]
    for c in rerank("what are the planets in solar system", demo):
        print(f"{c['rerank_score']:.3f}  {c['text'][:60]}")
