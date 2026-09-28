# RAG Chatbot

A minimal, dependency-light RAG (Retrieval-Augmented Generation) agent:
PDF → text extraction → chunking → embeddings → vector store → an LLM that
decides whether to answer from your documents, the live internet, or both.

No LangChain/LlamaIndex — every step is plain Python so you can see exactly
what's happening.

## Setup

1. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate   # on Windows: venv\Scripts\activate
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Add your API key(s):**
   ```bash
   cp .env.example .env
   # then edit .env and paste your key(s) in
   ```
   Set `LLM_PROVIDER=groq` (free) or `LLM_PROVIDER=claude` to choose which
   model answers your questions. Get a free Groq key at
   https://console.groq.com/keys, or an Anthropic key at
   https://console.anthropic.com/settings/keys.

4. **Put PDFs in the `data/` folder** — you can index as many as you like.

## Usage

**Step 1 — Index your PDFs** (only needs to be done once per document):
```bash
python src/main.py                  # indexes every PDF in data/
python src/main.py data/one.pdf     # or index just one file
```
This extracts text, chunks it, embeds the chunks, and stores them (tagged
with the source filename) in a local `chroma_db/` folder (created
automatically). Multiple documents can share the same `chroma_db/` — each
is deduped by filename, so re-running only indexes files that aren't
already in there.

**Step 2 — Chat with it**, either in the terminal:
```bash
python src/rag.py
```
Ask questions in the terminal. Type `quit` to exit.

...or in a browser:
```bash
streamlit run src/app.py
```
The web UI lets you switch providers, toggle web search, restrict which
documents/domains are searched, and watch the agent's tool calls happen live
— all from the sidebar and the chat itself.

## How it works, step by step

1. `pdf_parser.py` — pulls raw text out of the PDF, page by page
2. `chunker.py` — splits that text into ~300-word overlapping chunks, tagged
   with the source filename
3. `vector_store.py` — embeds each chunk (locally, via sentence-transformers)
   and stores it in ChromaDB, a local vector database, deduping per-source
4. `web_search.py` — free internet search via DuckDuckGo (no API key), with
   optional allow-list/block-list domain filtering
5. `rag.py` — the agent loop. Instead of always retrieving-then-answering,
   the model gets two **tools** — `search_documents` (your indexed PDFs) and
   `web_search` (the internet) — and decides for itself which to call, in
   however many rounds it needs, before answering. This is the core
   function-calling / tool-use pattern behind most LLM agents.
6. `app.py` — a Streamlit front-end over the same `vector_store`/`rag`
   functions: a real chat UI, live tool-call status, and separate
   document/web source panels per answer

## Agent behavior & source filtering

- The model is instructed to try `search_documents` first and only reach for
  `web_search` when the documents don't cover the question — but which tool
  it actually calls is its own decision each turn, not a fixed rule.
- **Document filter** (sidebar multiselect): restricts `search_documents` to
  a subset of your indexed PDFs. Default is all of them; selecting none
  makes document search return nothing (forcing the agent to fall back to
  web search, if enabled).
- **Web domain filters** (sidebar text areas): an allow-list and a
  block-list for `web_search` results, matched by domain (subdomains count).
  Both default to unrestricted.
- **Enable web search** (sidebar checkbox): turns off the `web_search` tool
  entirely for a pure-RAG session.
- A known quirk: Groq's free Llama models occasionally misformat a tool
  call — `rag.py` retries automatically and falls back to a plain answer if
  it keeps failing, so this shouldn't surface as a crash, just an
  occasional plainer answer.

## Re-indexing

Indexing is per-document: re-running `python src/main.py` only adds PDFs
that aren't already indexed. To fully start over (e.g. after changing
`chunk_size`/`overlap`), delete the whole `chroma_db/` folder first.

## Things to try next (once this works)

- Change `chunk_size` / `overlap` in `main.py` and see how answer quality changes
- Print the retrieved chunks (not just the final answer) to see what the model
  is actually working with — this is the best way to debug bad answers
- Swap `top_k` from 5 to 2 or 10 and compare
- Try a question you know isn't in the PDF — does it correctly say "I don't know"?
