"""
Command-line chat loop for the RAG agent.

Run with:
    python src/cli.py

Uses whatever provider/model is configured in .env (ACTIVE_PROVIDER, see
config.py) - Gemini by default. Index PDFs first with:
    python src/ingestion.py
"""

import logging
import sys
import uuid

from config import validate_active_provider
from logging_setup import configure_logging
from query_engine import answer_question
from retrieval import page_label
from store import VectorStore

logger = logging.getLogger(__name__)


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # avoid UnicodeEncodeError on Windows' default cp1252 console
    configure_logging()

    settings = validate_active_provider()
    provider = settings.name

    store = VectorStore()
    if store.collection.count() == 0:
        print("No chunks in the vector store yet. Run src/ingestion.py first to index a PDF.")
        sys.exit(1)

    cli_session_id = f"cli-{uuid.uuid4().hex[:8]}"
    print(f"RAG agent ready (provider: {provider}). Type a question (or 'quit' to exit).\n")
    while True:
        q = input("You: ").strip()
        if q.lower() in ("quit", "exit"):
            break

        def _on_tool_call(name, query):
            icon = "🔍" if name == "web_search" else "📄"
            print(f"  {icon} {name}({query!r})")

        try:
            result = answer_question(store, q, session_id=cli_session_id, on_tool_call=_on_tool_call)
        except Exception as e:
            logger.error(f"answer_question failed for question {q!r}: {e}")
            print(f"\nSorry, something went wrong answering that: {e}\n")
            continue

        print(f"\n{provider.capitalize()}: {result['answer']}")
        if result["doc_sources"]:
            labels = ", ".join(f"{s['source']} {page_label(s)}" for s in result["doc_sources"])
            print(f"(doc sources: {labels})")
        if result["web_sources"]:
            labels = ", ".join(f"{s['title']} ({s['url']})" for s in result["web_sources"])
            print(f"(web sources: {labels})")
        print()


if __name__ == "__main__":
    main()
