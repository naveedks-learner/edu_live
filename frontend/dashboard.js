const WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";

const adminKeyInput = document.getElementById("admin-key-input");
adminKeyInput.value = localStorage.getItem("edukripa-admin-key") ?? "";
adminKeyInput.addEventListener("input", () => {
  localStorage.setItem("edukripa-admin-key", adminKeyInput.value);
});

function adminHeaders() {
  const key = adminKeyInput.value.trim();
  return key ? { "x-admin-key": key } : {};
}

async function fetchAdmin(path) {
  const response = await fetch(`${WORKER_URL}${path}`, { headers: adminHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderLoading(el) {
  el.innerHTML = `<div class="loading-state">Loading...</div>`;
}

function renderError(el, message) {
  el.innerHTML = `<div class="card error-state">Could not load this tab: ${escapeHtml(message)}</div>`;
}

// --- Tab: PDFs & Chunks ---

async function loadDocumentsTab() {
  const el = document.getElementById("tab-documents");
  renderLoading(el);
  try {
    const { documents } = await fetchAdmin("/admin/documents");
    if (documents.length === 0) {
      el.innerHTML = `<div class="card empty-state">No documents indexed yet.</div>`;
      return;
    }
    const rows = documents
      .map(
        (doc) => `
        <tr>
          <td>${escapeHtml(doc.name)}</td>
          <td>${(doc.sizeBytes / 1024).toFixed(1)} KB</td>
          <td>${doc.indexedAt ? new Date(doc.indexedAt).toLocaleString() : "—"}</td>
          <td>${doc.pageCount ?? "—"}</td>
          <td>${doc.chunkCount ?? "—"}</td>
        </tr>`
      )
      .join("");
    el.innerHTML = `
      <div class="card">
        <h2>Indexed documents</h2>
        <table>
          <thead><tr><th>File</th><th>Size</th><th>Indexed</th><th>Pages</th><th>Chunks</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab: TransactionTracker ---

function statusPill(status) {
  return status === "kept" ? `<span class="pill pill-kept">kept</span>` : `<span class="pill pill-discarded">discarded</span>`;
}

function renderRetrievalTable(retrieval) {
  if (retrieval.length === 0) return `<p class="txn-meta">No chunks retrieved.</p>`;
  const rows = retrieval
    .map(
      (r) => `
      <tr>
        <td>${r.rank}</td>
        <td>${escapeHtml(r.source)}</td>
        <td>${r.page}</td>
        <td>${r.chunkId}</td>
        <td>${r.cosineScore.toFixed(4)}</td>
        <td>${r.rerankScore ?? "—"}</td>
        <td>${r.jevRelevance ?? "—"}</td>
        <td>${statusPill(r.status)}</td>
      </tr>`
    )
    .join("");
  return `
    <table>
      <thead><tr><th>Rank</th><th>Source</th><th>Page</th><th>Chunk</th><th>Cosine</th><th>Rerank</th><th>JEV</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTransactionCard(txn) {
  return `
    <div class="card txn-card">
      <div class="txn-meta">
        Query #${txn.id} · ${new Date(txn.timestamp).toLocaleString()} · <strong>${escapeHtml(txn.provider)} / ${escapeHtml(txn.model)}</strong>
      </div>
      <h3>${escapeHtml(txn.question)}</h3>
      <div class="metric-row">
        <div class="metric"><div class="label">Path taken</div><div class="value">${escapeHtml(txn.pathTaken)}</div></div>
        <div class="metric"><div class="label">Confidence</div><div class="value">${txn.confidence != null ? txn.confidence.toFixed(2) : "—"}</div></div>
      </div>
      <h4>Retrieval results</h4>
      ${renderRetrievalTable(txn.retrieval)}
      <details class="io-block"><summary>LLM input</summary><pre>${escapeHtml(txn.llmInput)}</pre></details>
      <details class="io-block"><summary>LLM output</summary><pre>${escapeHtml(txn.llmOutput)}</pre></details>
      ${
        txn.jevInput
          ? `<details class="io-block"><summary>JEV input</summary><pre>${escapeHtml(JSON.stringify(txn.jevInput, null, 2))}</pre></details>
             <details class="io-block"><summary>JEV output</summary><pre>${escapeHtml(JSON.stringify(txn.jevOutput, null, 2))}</pre></details>`
          : ""
      }
    </div>`;
}

async function loadTransactionsTab() {
  const el = document.getElementById("tab-transactions");
  renderLoading(el);
  try {
    const { transactions } = await fetchAdmin("/admin/transactions?limit=3");
    el.innerHTML =
      transactions.length === 0
        ? `<div class="card empty-state">No queries yet.</div>`
        : transactions.map(renderTransactionCard).join("");
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab: Costing ---

async function loadCostingTab(range = "1d") {
  const el = document.getElementById("tab-costing");
  renderLoading(el);
  try {
    const { lastTransaction, summary } = await fetchAdmin(`/admin/costing?range=${range}`);
    const lastCard = lastTransaction
      ? `
        <div class="card">
          <h2>Tokens used — last transaction</h2>
          <div class="metric-row">
            <div class="metric"><div class="label">Input tokens (est.)</div><div class="value">${lastTransaction.input_tokens}</div></div>
            <div class="metric"><div class="label">Output tokens (est.)</div><div class="value">${lastTransaction.output_tokens}</div></div>
            <div class="metric"><div class="label">JEV cost</div><div class="value">$${lastTransaction.jev_cost_usd.toFixed(5)}</div></div>
          </div>
        </div>`
      : `<div class="card empty-state">No usage recorded yet.</div>`;

    const summaryCard = `
      <div class="card">
        <div class="range-select">
          <label for="range-picker">Range: </label>
          <select id="range-picker">
            <option value="1h" ${range === "1h" ? "selected" : ""}>Last 1 hour</option>
            <option value="1d" ${range === "1d" ? "selected" : ""}>Last 1 day</option>
            <option value="7d" ${range === "7d" ? "selected" : ""}>Last 7 days</option>
          </select>
        </div>
        <h2>Tokens used — ${escapeHtml(range)}</h2>
        <div class="metric-row">
          <div class="metric"><div class="label">Queries</div><div class="value">${summary?.queryCount ?? 0}</div></div>
          <div class="metric"><div class="label">Input tokens (est.)</div><div class="value">${summary?.inputTokens ?? 0}</div></div>
          <div class="metric"><div class="label">Output tokens (est.)</div><div class="value">${summary?.outputTokens ?? 0}</div></div>
          <div class="metric"><div class="label">JEV cost</div><div class="value">$${(summary?.jevCostUsd ?? 0).toFixed(5)}</div></div>
        </div>
      </div>`;

    el.innerHTML = lastCard + summaryCard;
    document.getElementById("range-picker").addEventListener("change", (e) => loadCostingTab(e.target.value));
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab switching ---

const tabLoaders = {
  documents: loadDocumentsTab,
  transactions: loadTransactionsTab,
  costing: () => loadCostingTab(),
};

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    panel.classList.add("active");
    tabLoaders[btn.dataset.tab]();
  });
});

loadDocumentsTab();
