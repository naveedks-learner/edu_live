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
