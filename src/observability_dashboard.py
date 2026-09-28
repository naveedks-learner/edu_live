"""
Observability / debug dashboard for the RAG agent - rendered as a section
of the host page (src/app.py), not a separate Streamlit page, since the
dashboard IS the host page now and chat moved into the floating widget.

Reads everything logged by observability.py (per-query retrieval
candidates - kept and discarded, LLM I/O, tool calls, web fallback
results, errors) plus the vector store's chunk metadata, and surfaces the
two things needed to debug "why did I get this answer": what's indexed
(PDFs + chunks), and for the most recent query, what was retrieved from
the vector DB, exactly what went to the LLM, and what it answered.

Cost/latency/volume analytics are still logged by observability.py for a
later pass, but are not rendered here for now.
"""

import pandas as pd
import streamlit as st

import observability
from store import VectorStore


def render(store: VectorStore) -> None:
    # Two panes, per current needs:
    #  1. Infrequent events - what's indexed (PDFs + chunks).
    #  2. The most recent query's pipeline: what was retrieved from the
    #     vector DB (2a), exactly what went to the LLM (2b), and what it
    #     answered (2c) - enough to diagnose "why did I get this answer/error"
    #     without digging through the terminal.
    # Cost/latency/volume analytics are logged (see observability.py) but not
    # surfaced here yet - deferred to a later pass.
    tab_data, tab_latest, tab_costing = st.tabs(
        ["🗄️ PDFs & Chunks", "🔎 TransactionTracker", "💰 Costing"]
    )

    # ----------------------------------------------------------- PDFs & Chunks
    with tab_data:
        st.subheader("Indexed documents")
        sources = sorted(store.list_sources())
        st.write(sources or "_None indexed yet._")

        st.subheader("All chunks")
        chunks = store.all_chunks()
        if chunks:
            df = pd.DataFrame(chunks)
            cols = [c for c in ["source", "page", "chunk_id", "word_start", "word_end", "chunk_size", "overlap", "text"] if c in df.columns]
            st.dataframe(df[cols], use_container_width=True, hide_index=True)
        else:
            st.write("_No chunks stored yet._")

    # -------------------------------------------------------------- Latest Query
    with tab_latest:
        queries = observability.list_queries(limit=1)
        if not queries:
            st.info("No queries logged yet - ask something in the 🤖 Ask Edukripa widget (bottom right) first.")
        else:
            q = observability.get_query(queries[0]["id"])
            query_id = q["id"]

            st.caption(f"Query #{query_id} · {q['timestamp'][:19]} · provider: {q['provider']} / {q['model']}")
            st.markdown(f"**Question:** {q['question']}")
            path = q["routing_path"] or "none"
            conf, threshold = q["confidence"], q["threshold"]
            c1, c2, c3 = st.columns(3)
            c1.metric("Path taken", path)
            c2.metric("Confidence", f"{conf:.2f}" if conf is not None else "—")
            c3.metric("Threshold", f"{threshold:.2f}" if threshold is not None else "—")
            if q["error"]:
                st.error(f"Query error: {q['error']}")

            st.divider()
            st.subheader("2a. Retrieval results (chunks matched against the vector DB)")
            candidates = observability.get_retrieval_candidates(query_id)
            if not candidates:
                st.write("No retrieval candidates logged for this query (e.g. it only used web_search).")
            else:
                st.caption(
                    "**confidence** = raw cosine similarity from the vector store (miscalibrated on its "
                    "own - unrelated chunks can still score high). **rerank_score** = the cross-encoder's "
                    "relevance score, which is what actually decides kept/discarded and drives the "
                    "confidence gate; blank means the reranker failed and the cosine rank was used instead."
                )
                df = pd.DataFrame(candidates)
                df["status"] = df["kept"].map({1: "kept", 0: "discarded"})
                st.dataframe(
                    df[["iteration", "rank", "source", "page", "chunk_id", "distance", "confidence", "rerank_score", "status"]]
                    .sort_values(["iteration", "rank"]),
                    use_container_width=True, hide_index=True,
                )
                with st.expander("Full chunk text"):
                    for c in candidates:
                        tag = "kept" if c["kept"] else "discarded"
                        meta = store.get_chunk_metadata(c["source"], c["chunk_id"])
                        st.markdown(f"**{c['source']} · page {c['page']} · chunk {c['chunk_id']} ({tag})**")
                        st.text(meta["text"] if meta else "_Chunk metadata not found._")

            llm_calls = observability.get_llm_calls(query_id)

            st.divider()
            st.subheader("2b. LLM input")
            if not llm_calls:
                st.write("No LLM calls logged.")
            else:
                last_call = llm_calls[-1]
                st.caption(f"Iteration {last_call['iteration']} · {last_call['model']}")
                st.json(last_call["messages"])
                with st.expander("Call params"):
                    st.json(last_call["params"])

            st.divider()
            st.subheader("2c. LLM output")
            if llm_calls:
                st.write(last_call["response_text"] or "_(empty - see error above, if any)_")
                st.caption(
                    f"stop_reason: {last_call['stop_reason']} · "
                    f"{last_call['input_tokens']}in/{last_call['output_tokens']}out · "
                    f"{last_call['latency_ms']:.0f} ms"
                )
            st.markdown(f"**Final answer returned to chat:** {q['answer'] or '_(empty)_'}")

            tool_calls = observability.get_tool_calls(query_id)
            web_results = observability.get_web_results(query_id)
            web_tool_calls = [t for t in tool_calls if t["tool_name"] == "web_search"]
            if web_tool_calls:
                st.divider()
                st.subheader("Web fallback")
                for t in web_tool_calls:
                    st.markdown(
                        f"**Searched:** `{t['input_query']}` · triggered by **{t['triggered_by']}** "
                        f"({t['latency_ms']:.0f} ms)"
                    )
                if web_results:
                    st.dataframe(
                        pd.DataFrame(web_results)[["rank", "title", "url", "snippet"]],
                        use_container_width=True, hide_index=True,
                    )

    # -------------------------------------------------------------- Costing
    with tab_costing:
        st.subheader("Tokens used - last transaction")
        last_txn = observability.get_token_usage_last_txn()
        if not last_txn or (last_txn["total_input_tokens"] is None and last_txn["total_output_tokens"] is None):
            st.info("No queries logged yet.")
        else:
            in_tok = last_txn["total_input_tokens"] or 0
            out_tok = last_txn["total_output_tokens"] or 0
            cost = last_txn["estimated_cost_usd"] or 0.0
            c1, c2, c3 = st.columns(3)
            c1.metric("Input tokens", f"{in_tok:,}")
            c2.metric("Output tokens", f"{out_tok:,}")
            c3.metric("Estimated cost", f"${cost:.5f}")
            st.caption(f"Query #{last_txn['id']} · {last_txn['timestamp'][:19]} · model: {last_txn['model']}")

        st.divider()
        st.subheader("Tokens used - last 1 day")
        day_usage = observability.get_token_usage_since(hours=24)
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Queries", f"{day_usage['query_count']:,}")
        c2.metric("Input tokens", f"{day_usage['input_tokens']:,}")
        c3.metric("Output tokens", f"{day_usage['output_tokens']:,}")
        c4.metric("Estimated cost", f"${day_usage['cost_usd']:.5f}")
