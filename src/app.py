"""
Web UI for the RAG agent.

The host page is the Observability dashboard + Settings - that's what you
land on. Chat lives in the "Ask Edukripa" floating widget pinned to the
bottom-right corner (a st.popover styled to sit fixed over the page, like
a typical website chat bubble), so you can watch a query land in the
dashboard without switching pages.

Run with:
    streamlit run src/app.py
"""

import contextlib
import html
import io
import logging
import traceback
import uuid

import streamlit as st

import query_engine
import observability
import observability_dashboard
import voice_input
from config import build_provider_options, get_active_provider_settings, get_model_choices_for_provider
from ingestion import index_all
from logging_setup import configure_logging
from retrieval import page_label
from store import VectorStore

configure_logging()
st.set_page_config(page_title="RAG Agent - Observability", page_icon="🔬", layout="wide")

# --------------------------------------------------------------- Custom CSS
st.markdown(
    """
    <style>
    /* Sidebar */
    section[data-testid="stSidebar"] {
        background-color: #1A1B2E;
    }
    section[data-testid="stSidebar"] label,
    section[data-testid="stSidebar"] p,
    section[data-testid="stSidebar"] span {
        color: #C8CADD;
    }
    section[data-testid="stSidebar"] .stSelectbox label,
    section[data-testid="stSidebar"] .stSlider label,
    section[data-testid="stSidebar"] .stMultiSelect label,
    section[data-testid="stSidebar"] .stTextArea label,
    section[data-testid="stSidebar"] .stRadio label,
    section[data-testid="stSidebar"] .stCheckbox label {
        text-transform: uppercase;
        font-size: 0.72rem;
        color: #7B7FA8 !important;
    }

    /* Sliders - indigo gradient instead of red */
    div[data-testid="stSlider"] div[role="slider"] {
        background-color: #5B4FE8 !important;
    }
    div[data-testid="stSlider"] > div > div > div > div {
        background: linear-gradient(90deg, #5B4FE8, #7B68EE) !important;
    }

    /* Tabs */
    button[data-baseweb="tab"] {
        color: #6B6F9A;
        font-weight: 600;
    }
    button[data-baseweb="tab"][aria-selected="true"] {
        color: #5B4FE8;
        border-bottom: 2px solid #5B4FE8;
    }

    /* Table headers */
    div[data-testid="stDataFrame"] thead th {
        background-color: #EDEEF5 !important;
        color: #1A1B2E !important;
        font-size: 0.75rem !important;
        font-weight: 600 !important;
    }

    /* Space below the main header banner */
    div.main-header-banner {
        margin-bottom: 1rem;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_resource
def get_store() -> VectorStore:
    return VectorStore()


store = get_store()

if "history" not in st.session_state:
    st.session_state.history = []  # list of {"question", "answer", "doc_sources", "web_sources", "trace", "query_id"}
if "session_id" not in st.session_state:
    st.session_state.session_id = f"web-{uuid.uuid4().hex[:8]}"
with st.sidebar:
    st.header("⚙️ Settings")

    st.divider()

    provider_choices = ["groq", "claude", "huggingface", "gemini"]
    all_provider_choices = ["openrouter", *provider_choices]
    gemini_model_choices = get_model_choices_for_provider("gemini")
    active_settings = get_active_provider_settings()
    provider = st.selectbox(
        "ACTIVE PROVIDER",
        options=all_provider_choices,
        index=all_provider_choices.index(active_settings.name if active_settings.name in all_provider_choices else "gemini"),
    )
    st.session_state["ACTIVE_PROVIDER"] = provider

    model_choices = get_model_choices_for_provider(provider)
    selected_model = st.selectbox(
        "Gemini model" if provider == "gemini" else "MODEL TO BE USED",
        options=model_choices,
        index=model_choices.index(active_settings.model if active_settings.model in model_choices else model_choices[0]),
    )

    if provider == "openrouter":
        st.caption("🌐 Uses OpenRouter API")
    elif provider == "gemini":
        st.caption("⚡ Uses Google Gemini API")
    elif provider == "groq":
        st.caption("🆓 Free via Groq")
    elif provider == "claude":
        st.caption("💰 Uses Anthropic API credits")
    else:
        st.caption("🤗 Uses Hugging Face Inference")

    st.caption(f"Current selection: {provider} / {selected_model}")
    st.sidebar.info(
        f"🧩 Embedding model: `{store.embedding_model}` (set via EMBEDDING_MODEL in .env - "
        "switching requires deleting chroma_db/ and re-indexing, so not editable here)"
    )

    st.divider()

    top_k = st.slider("Chunks to retrieve per document search", min_value=1, max_value=10, value=5)

    confidence_threshold = st.slider(
        "Confidence threshold (auto web fallback)",
        min_value=0.0, max_value=1.0, value=query_engine.DEFAULT_CONFIDENCE_THRESHOLD, step=0.05,
        help="If the best document match scores below this, web_search is auto-triggered "
             "in code - regardless of what the model itself decides. See the Query Trace "
             "tab for the confidence each query actually scored.",
    )

    st.divider()
    st.subheader("🔧 Tools")

    web_mode = st.radio(
        "Web search mode",
        options=["RAG only", "RAG + web fallback"],
        index=0,
        help="Document search is always attempted first. Web search is only used as a fallback when enabled.",
    )
    web_enabled = web_mode == "RAG + web fallback"
    hard_fail_on_no_document = st.checkbox(
        "Hard fail when no document found",
        value=False,
        help="If enabled, the app stops and reports no document match instead of falling back to web search.",
    )

    sources = sorted(store.list_sources())
    selected_docs = st.multiselect(
        "Search only these documents",
        options=sources,
        default=sources,
        help="Empty selection means the document-search tool will find nothing (forcing the agent to fall back to web search, if enabled).",
    )
    if sources and not selected_docs:
        st.warning("No documents selected - document search will return nothing.")

    allowed_raw = st.text_area("Allowed web domains (one per line, empty = unrestricted)", height=70)
    blocked_raw = st.text_area("Blocked web domains (one per line)", height=70)
    allowed_domains = [d.strip() for d in allowed_raw.splitlines() if d.strip()] or None
    blocked_domains = [d.strip() for d in blocked_raw.splitlines() if d.strip()] or None

    st.divider()
    st.subheader("📚 Indexed documents")
    if sources:
        for i, doc in enumerate(sources):
            st.markdown(f"`{i}` &nbsp; 📄 {doc}", unsafe_allow_html=True)
    else:
        st.write("_None yet._")

    if st.button("🔄 Index PDFs from data/ folder"):
        with st.spinner("Indexing..."):
            index_all(store=store)
        st.rerun()

    st.divider()
    if st.button("🗑️ Clear chat"):
        st.session_state.history = []
        st.rerun()

# --------------------------------------------------------------- Host page
st.markdown(
    """
    <div class="main-header-banner" style="padding:22px 28px; border-radius:16px; margin-bottom:18px;
                background:linear-gradient(120deg, #2a78d6 0%, #4a3aa7 55%, #1baf7a 100%);
                box-shadow:0 6px 24px rgba(74,58,167,0.25);">
      <h1 style="margin:0; color:#ffffff; font-size:1.9rem;">🔬 RAG Agent - Observability &amp; Settings</h1>
      <p style="margin:6px 0 0; color:#f0efec; opacity:0.95;">
        Retrieval, routing decisions, LLM I/O, cost, and errors are shown below each query.
      </p>
    </div>
    """,
    unsafe_allow_html=True,
)

if not sources:
    st.info("No documents indexed yet. Use the sidebar button to index PDFs from `data/`.")

observability_dashboard.render(store)


# ------------------------------------------------------- Ask Edukripa popup
def _bubble(role: str, text: str) -> str:
    # Defensive: a provider can hand back None/empty content (e.g. some
    # OpenRouter free models on a truncated/rate-limited response) instead
    # of raising - html.escape() would crash on that and take the whole
    # popup down with it.
    safe = html.escape(text if isinstance(text, str) and text else "(empty response from the model)").replace("\n", "<br>")
    if role == "user":
        return f"""
        <div style="display:flex; justify-content:flex-end; margin:6px 0;">
          <div style="max-width:82%; background:linear-gradient(135deg,#2a78d6,#4a3aa7);
                      color:#fff; padding:8px 12px; border-radius:14px 14px 2px 14px; font-size:0.92rem;">
            {safe}
          </div>
        </div>"""
    return f"""
    <div style="display:flex; justify-content:flex-start; margin:6px 0;">
      <div style="max-width:82%; background:#eef3ff; color:#0b0b0b; padding:8px 12px;
                  border-radius:14px 14px 14px 2px; font-size:0.92rem; border-left:3px solid #1baf7a;">
        🎓 {safe}
      </div>
    </div>"""


def _error_bubble(text: str) -> str:
    safe = html.escape(text if isinstance(text, str) and text else "Unknown error").replace("\n", "<br>")
    return f"""
    <div style="display:flex; justify-content:flex-start; margin:6px 0;">
      <div style="max-width:82%; background:#fdecea; color:#611a15; padding:8px 12px;
                  border-radius:14px 14px 14px 2px; font-size:0.92rem; border-left:3px solid #d93025;">
        ⚠️ {safe}
      </div>
    </div>"""


st.markdown(
    """
    <style>
    div.st-key-ask_edukripa_launcher {
        position: fixed;
        bottom: 26px;
        right: 26px;
        z-index: 999999;
    }
    div.st-key-ask_edukripa_launcher > button {
        background: linear-gradient(135deg, #2a78d6, #4a3aa7 55%, #e87ba4) !important;
        color: #fff !important;
        border: none !important;
        border-radius: 999px !important;
        padding: 0.7rem 1.3rem !important;
        font-weight: 700 !important;
        font-size: 1rem !important;
        box-shadow: 0 8px 24px rgba(74,58,167,0.45) !important;
    }
    div[data-testid="stFormSubmitButton"] > button {
        white-space: nowrap !important;
    }
    /* Streamlit's auto "Press Enter to submit form" hint renders right under
       the chat text_input and visually collides with the Send button row -
       it's redundant (the form is submitted on Enter regardless), so hide it. */
    div[data-testid="InputInstructions"] {
        display: none !important;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

with st.popover("🤖 Ask Edukripa", key="ask_edukripa_launcher"):
    st.markdown(
        """
        <div style="padding:8px 12px; border-radius:10px; margin-bottom:6px;
                    background:linear-gradient(120deg,#2a78d6,#4a3aa7 60%,#e87ba4);
                    color:white; font-weight:700; font-size:1.05rem;">
          🤖 Ask Edukripa
        </div>
        """,
        unsafe_allow_html=True,
    )
    if not st.session_state.history:
        st.markdown(_bubble("assistant", "Ask a question about your indexed documents."), unsafe_allow_html=True)
    for turn in st.session_state.history:
        st.markdown(_bubble("user", turn["question"]), unsafe_allow_html=True)
        if turn.get("error"):
            st.markdown(_error_bubble(turn["error"]), unsafe_allow_html=True)
            with st.expander("Error details (also printed to the terminal)", expanded=False):
                st.code(turn["details"] or turn["error"], language="text")
            continue
        if turn["trace"]:
            trace_line = " → ".join(
                f"{'🔍' if t['tool'] == 'web_search' else '📄'} {t['input']}" for t in turn["trace"]
            )
            st.caption(trace_line)
        st.markdown(_bubble("assistant", turn["answer"]), unsafe_allow_html=True)
        # Surfaces the web_enabled state this specific query actually ran
        # with - the sidebar's "Web search mode" radio can silently differ
        # from what you expect (e.g. it resets to "RAG only" on a fresh
        # session), which otherwise only shows up by digging through the
        # dashboard's query trace.
        st.caption(
            "🌐 Web fallback: **on**" if turn.get("web_enabled")
            else "🌐 Web fallback: **off** (RAG only for this query)"
        )
        if turn["doc_sources"] or turn["web_sources"]:
            with st.expander("Sources", expanded=False):
                for s in turn["doc_sources"]:
                    st.caption(f"📄 {s['source']}, {page_label(s).lower()} (distance {s['distance']})")
                for s in turn["web_sources"]:
                    st.caption(f"🌐 [{s['title']}]({s['url']})")
        st.caption(f"🔬 Query #{turn['query_id']} - see the dashboard above for the full trace.")

    mic_col, hint_col = st.columns([1, 5])
    with mic_col:
        mic_result = voice_input.voice_mic_button(key="ask_edukripa_mic")
    with hint_col:
        st.caption("Click the mic and speak, or type below")
    if mic_result.error:
        st.warning(f"Voice input error: {mic_result.error}")
    if mic_result.transcript:
        st.session_state["ask_edukripa_message"] = mic_result.transcript

    with st.form(key="ask_edukripa_form", clear_on_submit=True, border=False):
        input_col, send_col = st.columns([5, 1.2])
        question = input_col.text_input(
            "Message", key="ask_edukripa_message", label_visibility="collapsed", placeholder="Ask a question about your notes...",
        )
        submitted = send_col.form_submit_button("Send", use_container_width=True)

    if submitted and question.strip():
        status = st.status("Working on your question…", expanded=True)
        status.write("Preparing retrieval and reasoning…")

        def _on_tool_call(name, q):
            icon = "🔍" if name == "web_search" else "📄"
            status.write(f"{icon} **{name}**: {q}")
            status.write("Searching the relevant source and thinking through the answer…")

        captured_output = io.StringIO()
        # logging.StreamHandler binds to sys.stderr at *creation* time, so
        # redirect_stdout/redirect_stderr alone miss anything the SDKs log
        # (retry/rate-limit warnings, etc.) — attach a handler directly to
        # the root logger so it also lands in the same buffer.
        log_handler = logging.StreamHandler(captured_output)
        log_handler.setLevel(logging.WARNING)
        log_handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
        root_logger = logging.getLogger()
        root_logger.addHandler(log_handler)
        try:
            with contextlib.redirect_stdout(captured_output), contextlib.redirect_stderr(captured_output):
                result = query_engine.answer_question(
                    store,
                    question,
                    provider=provider,
                    model=selected_model,
                    top_k=top_k,
                    doc_sources=selected_docs,
                    allowed_domains=allowed_domains,
                    blocked_domains=blocked_domains,
                    web_enabled=web_enabled,
                    confidence_threshold=confidence_threshold,
                    hard_fail_on_no_document=hard_fail_on_no_document,
                    session_id=st.session_state.session_id,
                    on_tool_call=_on_tool_call,
                )
        except Exception as exc:
            # Same traceback + log output that would otherwise only show up in the terminal.
            terminal_output = captured_output.getvalue()
            tb_text = traceback.format_exc()
            status.update(label="Query failed", state="error", expanded=False)
            st.session_state.history.append({
                "question": question,
                "error": f"{type(exc).__name__}: {exc}",
                "details": "\n".join(filter(None, [terminal_output.strip(), tb_text.strip()])),
            })
            st.rerun()
        else:
            if not result.get("answer"):
                # The call succeeded but the provider handed back no content
                # (seen with some OpenRouter free models) - surface it as an
                # error instead of silently rendering an empty bubble.
                status.update(label="Query failed", state="error", expanded=False)
                st.session_state.history.append({
                    "question": question,
                    "error": "The model returned an empty response.",
                    "details": (
                        f"{captured_output.getvalue().strip()}\n\nRaw result: {result!r}"
                    ).strip(),
                })
            else:
                status.update(label="Answer ready", state="complete", expanded=False)
                st.session_state.history.append({
                    "question": question,
                    "answer": result["answer"],
                    "doc_sources": result["doc_sources"],
                    "web_sources": result["web_sources"],
                    "trace": result["trace"],
                    "query_id": result["query_id"],
                    "web_enabled": web_enabled,
                })
            st.rerun()
        finally:
            root_logger.removeHandler(log_handler)
