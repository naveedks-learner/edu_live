"""
Splits extracted page text into overlapping chunks suitable for embedding.

Why overlap? If a sentence or idea gets cut at a chunk boundary, overlap
means it's likely to appear whole in at least one chunk. Without it,
you can lose the exact fact you needed right at a chunk edge.

We chunk by word count as a simple, dependency-free approximation of
token count (roughly 0.75 words per token for English, but word count
alone is good enough to start with).

Chunking flows across the whole document rather than restarting at each
page. Page boundaries are usually arbitrary relative to chunk_size (300
words) - restarting per page produced small, weakly-overlapped chunks
whenever a page was shorter than chunk_size, and made word_start/word_end
reset to 0 on every page instead of advancing. We still track which
page(s) each chunk came from for citation, by tagging every word with its
source page before chunking.
"""


import logging

logger = logging.getLogger(__name__)


def chunk_text(pages: list[dict], source: str, chunk_size: int = 300, overlap: int = 50) -> list[dict]:
    """
    pages: output of pdf_parser.extract_pages()
    source: filename the pages came from (stamped onto every chunk so
        retrieval can cite which document an answer came from)
    chunk_size: target number of words per chunk
    overlap: number of words repeated between consecutive chunks

    Returns a list of {"text": str, "page": int, "page_end": int, "chunk_id": int,
    "source": str, "word_start": int, "word_end": int, "chunk_size": int,
    "overlap": int} dicts.
    word_start/word_end are word-index boundaries into the whole document's
    word stream (continuous across pages, not reset per page). "page" is the
    page the chunk starts on; "page_end" is the page it ends on - equal to
    "page" unless the chunk straddles a page break. chunk_size/overlap record
    the params this chunk was produced with - kept for observability so the
    dashboard can show exactly how a document was split without recomputing it.
    """
    if overlap >= chunk_size:
        raise ValueError("overlap must be smaller than chunk_size")

    # Flatten all pages into one continuous word stream, remembering which
    # page each word came from so chunks can still cite a page number.
    words = []
    word_pages = []
    for page in pages:
        page_words = page["text"].split()
        words.extend(page_words)
        word_pages.extend([page["page"]] * len(page_words))

    if not words:
        logger.warning(f"'{source}' has no extractable text - 0 chunks produced.")
        return []

    chunks = []
    chunk_id = 0
    start = 0

    while start < len(words):
        end = start + chunk_size
        chunk_words = words[start:end]
        chunk_str = " ".join(chunk_words)
        word_end = min(end, len(words))

        chunks.append({
            "text": chunk_str,
            "page": word_pages[start],
            "page_end": word_pages[word_end - 1],
            "chunk_id": chunk_id,
            "source": source,
            "word_start": start,
            "word_end": word_end,
            "chunk_size": chunk_size,
            "overlap": overlap,
        })
        chunk_id += 1

        if end >= len(words):
            break
        start = end - overlap  # step forward, but re-include the overlap

    logger.info(f"Created {len(chunks)} chunks from {len(pages)} pages for '{source}'.")
    return chunks


if __name__ == "__main__":
    # quick manual test
    fake_pages = [
        {"page": 1, "text": " ".join(f"word{i}" for i in range(400))},
        {"page": 2, "text": " ".join(f"word{i}" for i in range(400, 700))},
    ]
    result = chunk_text(fake_pages, source="fake.pdf", chunk_size=300, overlap=50)
    for c in result:
        print(c["chunk_id"], c["word_start"], c["word_end"], f"p{c['page']}-{c['page_end']}", c["text"][:40], "...")
