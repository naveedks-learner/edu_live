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
