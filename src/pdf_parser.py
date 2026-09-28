"""
Extracts text from a PDF, page by page.
We keep page numbers attached to each chunk of text so that later,
when we retrieve a chunk, we can tell the user roughly where it came from.
"""

import logging

import fitz  # this is PyMuPDF's import name, not a typo

logger = logging.getLogger(__name__)


def extract_pages(pdf_path: str) -> list[dict]:
    """
    Returns a list of {"page": int, "text": str} dicts, one per page.
    Skips pages that are empty (e.g. blank pages, pure-image pages with no text layer).

    Raises RuntimeError with a clear message if the PDF can't be opened or
    read (missing file, corrupted/locked PDF) instead of letting PyMuPDF's
    raw exception surface.
    """
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        raise RuntimeError(f"Failed to open PDF '{pdf_path}': {e}") from e

    try:
        total_pages = len(doc)
        pages = []

        for page_num in range(total_pages):
            page = doc[page_num]
            # sort=True orders text spans top-to-bottom, left-to-right instead of
            # PyMuPDF's raw internal block order - without it, multi-column pages
            # (or pages with sidebars/captions) can interleave unrelated sections.
            text = page.get_text(sort=True).strip()
            if text:  # skip empty pages
                pages.append({"page": page_num + 1, "text": text})
    except Exception as e:
        raise RuntimeError(f"Failed to extract text from PDF '{pdf_path}': {e}") from e
    finally:
        doc.close()

    logger.info(f"Extracted text from {len(pages)} non-empty pages (out of {total_pages} total) in '{pdf_path}'.")
    return pages


if __name__ == "__main__":
    # quick manual test: python pdf_parser.py path/to/file.pdf
    import sys

    if len(sys.argv) != 2:
        print("Usage: python pdf_parser.py <path_to_pdf>")
        sys.exit(1)

    result = extract_pages(sys.argv[1])
    print(f"\nFirst page preview:\n{result[0]['text'][:500]}")
