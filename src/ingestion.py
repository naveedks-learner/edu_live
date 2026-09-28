"""
Run this to index PDFs:
    python src/ingestion.py                  # indexes every PDF in data/
    python src/ingestion.py data/one.pdf     # indexes just that file

Then chat with it via:
    python src/cli.py
or the web UI:
    streamlit run src/app.py
"""

import logging
import os
import sys
from pdf_parser import extract_pages
from chunker import chunk_text
from logging_setup import configure_logging
from store import VectorStore

logger = logging.getLogger(__name__)


def index_pdf(pdf_path: str, store: VectorStore = None) -> VectorStore:
    store = store or VectorStore()
    source = os.path.basename(pdf_path)

    logger.info(f"Indexing: {pdf_path}")

    pages = extract_pages(pdf_path)
    chunks = chunk_text(pages, source=source, chunk_size=220, overlap=60)  # logs chunk/page count at INFO
    store.add_chunks(chunks)

    logger.info(f"Done indexing: {pdf_path}")
    return store


def index_all(data_dir: str = "data", store: VectorStore = None) -> VectorStore:
    store = store or VectorStore()
    pdf_paths = sorted(
        os.path.join(data_dir, f) for f in os.listdir(data_dir) if f.lower().endswith(".pdf")
    )

    if not pdf_paths:
        logger.warning(f"No PDFs found in {data_dir}/")
        return store

    for pdf_path in pdf_paths:
        try:
            index_pdf(pdf_path, store=store)
        except Exception as e:
            # One bad PDF shouldn't stop the rest of the batch from indexing.
            logger.error(f"Skipping '{pdf_path}' - failed to index: {e}")

    return store


if __name__ == "__main__":
    configure_logging()
    if len(sys.argv) == 1:
        index_all()
    elif len(sys.argv) == 2:
        index_pdf(sys.argv[1])
    else:
        print("Usage: python src/ingestion.py [path_to_pdf]")
        sys.exit(1)

    print("\nDone. Now run: python src/cli.py (or: streamlit run src/app.py)")
