"""
Coherence check for test_llm.py: is the LLM's answer actually about the
question, and does it line up with the document context that was
retrieved for it? Two cheap, independent signals, both required:

1. Keyword overlap - the answer must literally contain at least one
   non-stopword from the question. Catches "answered a different
   question" / totally off-topic replies.
2. Embedding similarity - cosine similarity between the answer and the
   retrieved source chunk, using the same sentence-transformers model
   the vector store embeds with (see config.get_embedding_model()).
   Catches answers that use the right words but aren't actually
   grounded in the retrieved context.
"""

import logging
import math

logger = logging.getLogger(__name__)

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "what", "which", "who",
    "how", "why", "when", "where", "do", "does", "did", "of", "in", "on",
    "to", "and", "or", "for", "explain", "describe", "tell", "me", "about",
}

_embed_model = None


def _get_default_embed_fn():
    """Lazily loads the same embedding model the vector store uses, so the
    real-usage path in test_llm.py doesn't need sentence-transformers
    imported at module load time (mirrors reranker.py's lazy-load pattern)."""
    global _embed_model
    if _embed_model is None:
        import sys
        import os
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src"))
        from sentence_transformers import SentenceTransformer
        from config import get_embedding_model

        _embed_model = SentenceTransformer(get_embedding_model())

    def embed_fn(texts: list[str]) -> list[list[float]]:
        return _embed_model.encode(texts).tolist()

    return embed_fn


def _keyword_overlap(question: str, answer: str) -> bool:
    q_words = {
        w.strip(".,?!;:").lower()
        for w in question.split()
        if w.strip(".,?!;:").lower() not in _STOPWORDS and len(w) > 2
    }
    answer_lower = answer.lower()
    return any(w in answer_lower for w in q_words)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def is_relevant(
    question: str,
    answer: str,
    context_text: str,
    embed_fn=None,
    threshold: float = 0.3,
) -> tuple[bool, str | None]:
    """
    Returns (True, None) if the answer passes both checks, otherwise
    (False, reason). embed_fn: callable(list[str]) -> list[vector];
    defaults to the real sentence-transformers embedding model (lazy
    import) if not given - pass a fake in tests to avoid loading it.
    """
    if not _keyword_overlap(question, answer):
        return False, "no keyword overlap between question and answer"

    embed_fn = embed_fn or _get_default_embed_fn()
    answer_vec, context_vec = embed_fn([answer, context_text])
    similarity = _cosine(answer_vec, context_vec)
    if similarity < threshold:
        return False, f"embedding similarity {similarity:.3f} below threshold {threshold}"

    return True, None
