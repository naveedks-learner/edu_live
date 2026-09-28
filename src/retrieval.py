"""
Read-side of the RAG pipeline: given a question, get back the top-k most
relevant chunks from the vector store, formatted for the LLM prompt.

The VectorStore class itself (embedding, writing, and querying Chroma)
lives in store.py - this module is the "ask a question, get chunks back"
layer on top of it, plus the search_documents tool implementation shared
by every provider loop in query_engine.py.
"""

import logging

from reranker import rerank as _rerank
from store import VectorStore

logger = logging.getLogger(__name__)


def page_label(c: dict) -> str:
    """Formats a chunk's page(s) for display, e.g. 'Page 3' or 'Pages 3-4'
    when the chunk straddles a page break (see chunker.py's page_end)."""
    page_end = c.get("page_end", c["page"])
    return f"Page {c['page']}" if page_end == c["page"] else f"Pages {c['page']}-{page_end}"


def top_confidence(chunks: list[dict]) -> float:
    """
    Best available relevance signal for the top-ranked chunk: the
    reranker's score if it ran successfully, otherwise the raw cosine
    "confidence" from the vector store. Used by query_engine.py's
    confidence gate - the reranker's score is what should actually drive
    the "was this good enough" decision (see reranker.py for why raw
    cosine confidence is a poor absolute signal on its own).
    """
    if not chunks:
        return 0.0
    top = chunks[0]
    rerank_score = top.get("rerank_score")
    return rerank_score if rerank_score is not None else top["confidence"]


def search_documents(
    vector_store: VectorStore,
    query_text: str,
    top_k: int,
    doc_sources: list[str] | None,
    use_reranker: bool = True,
) -> tuple[str, list[dict], list[dict]]:
    """
    Runs the search_documents tool: queries the vector store, reranks the
    candidates with a cross-encoder, and formats the result for the LLM
    prompt.

    The vector store's cosine search over-fetches (fetch_k = top_k * 3) so
    the reranker has more than top_k candidates to actually choose from -
    reranking is what decides the final top_k / kept-vs-discarded split,
    not the raw cosine rank.

    Returns (text_for_model, kept_chunks, all_candidates) where
    all_candidates = kept_chunks + discarded (used for observability only).
    Every candidate carries both "confidence" (cosine) and "rerank_score"
    (cross-encoder, None if reranking failed) so both are visible in the
    observability dashboard.
    """
    logger.debug(f"search_documents: query={query_text!r} top_k={top_k} doc_sources={doc_sources}")
    try:
        kept, discarded = vector_store.query_with_candidates(
            query_text, top_k=top_k, fetch_k=top_k * 3, sources=doc_sources
        )
    except Exception as e:
        logger.error(f"search_documents failed for query {query_text!r}: {e}")
        return f"Document search failed: {e}", [], []

    all_candidates = kept + discarded
    if use_reranker and all_candidates:
        all_candidates = _rerank(query_text, all_candidates)
        reranked = all_candidates[0].get("rerank_score") is not None
        for rank, c in enumerate(all_candidates, start=1):
            c["rank"] = rank
            c["kept"] = rank <= top_k
        if reranked:
            kept = [c for c in all_candidates if c["kept"]]
            discarded = [c for c in all_candidates if not c["kept"]]
        # else: reranker failed - keep the original cosine-based kept/discarded split.

    logger.debug(f"search_documents: kept={len(kept)} discarded={len(discarded)}")
    text = "\n\n".join(f"[{c['source']}, {page_label(c)}]\n{c['text']}" for c in kept)
    return text or "No relevant passages found in the documents.", kept, kept + discarded
