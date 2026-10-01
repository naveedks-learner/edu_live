const WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";

const THEME_STORAGE_KEY = "edukripa-theme";
const themeToggle = document.getElementById("theme-toggle");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "auto";
}

themeToggle.addEventListener("click", () => {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const isDark = currentTheme() === "dark" || (currentTheme() === "auto" && prefersDark);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (e) {}
});

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

const INGEST_KEY_STORAGE = "edukripa-ingest-key";

function uploadCardHtml() {
  const savedKey = localStorage.getItem(INGEST_KEY_STORAGE) ?? "";
  return `
    <div class="card" id="upload-card">
      <h2>Upload notes (PDF)</h2>
      <div class="upload-row">
        <input type="password" id="ingest-key-input" placeholder="x-ingest-key (if configured)" autocomplete="off" value="${escapeHtml(savedKey)}" />
      </div>
      <div class="upload-row">
        <input type="file" id="file-input" accept="application/pdf" />
        <button id="upload-btn">Upload</button>
      </div>
      <p id="upload-status" class="txn-meta"></p>
    </div>`;
}

function wireUploadCard(onUploaded) {
  const ingestKeyInput = document.getElementById("ingest-key-input");
  const fileInput = document.getElementById("file-input");
  const uploadBtn = document.getElementById("upload-btn");
  const uploadStatus = document.getElementById("upload-status");

  ingestKeyInput.addEventListener("input", () => {
    localStorage.setItem(INGEST_KEY_STORAGE, ingestKeyInput.value);
  });

  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) {
      uploadStatus.textContent = "Choose a PDF first.";
      return;
    }

    uploadBtn.disabled = true;
    uploadStatus.textContent = "Uploading...";
    const formData = new FormData();
    formData.append("file", file);
    const ingestKey = ingestKeyInput.value.trim();

    try {
      const response = await fetch(`${WORKER_URL}/ingest`, {
        method: "POST",
        headers: ingestKey ? { "x-ingest-key": ingestKey } : {},
        body: formData,
      });
      const result = await response.json();

      uploadStatus.textContent = response.ok
        ? `${result.status}: ${result.source}${result.chunkCount ? ` (${result.chunkCount} chunks)` : ""}`
        : `Error: ${result.error}`;

      if (response.ok) onUploaded();
    } catch (err) {
      uploadStatus.textContent = `Error: could not reach the server (${err.message})`;
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

async function loadDocumentsTab() {
  const el = document.getElementById("tab-documents");
  renderLoading(el);
  try {
    const { documents, chunkPreviewCount } = await fetchAdmin("/admin/documents");
    if (documents.length === 0) {
      el.innerHTML = `${uploadCardHtml()}<div class="card empty-state">No documents indexed yet.</div>`;
      wireUploadCard(loadDocumentsTab);
      return;
    }

    const totalChunks = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);

    const rows = documents
      .map((doc) => {
        const chunkSection = doc.chunks
          ? `<details class="io-block chunk-preview">
               <summary>View ${doc.chunks.length} chunk(s)</summary>
               ${doc.chunks
                 .map(
                   (c) => `<div class="chunk-item"><div class="chunk-meta">Chunk ${c.chunkId} · page ${c.page}</div><pre>${escapeHtml(c.text)}</pre></div>`
                 )
                 .join("")}
             </details>`
          : `<span class="txn-meta">Chunks not shown for this document</span>`;

        return `
        <tr>
          <td>${escapeHtml(doc.name)}</td>
          <td>${(doc.sizeBytes / 1024).toFixed(1)} KB</td>
          <td>${doc.indexedAt ? new Date(doc.indexedAt).toLocaleString() : "—"}</td>
          <td>${doc.pageCount ?? "—"}</td>
          <td>${doc.chunkCount ?? "—"}</td>
          <td>${doc.enriched === null ? "—" : doc.enriched ? "Yes" : "No"}</td>
        </tr>
        <tr class="chunk-row"><td colspan="6">${chunkSection}</td></tr>`;
      })
      .join("");

    el.innerHTML = `
      ${uploadCardHtml()}
      <div class="card">
        <div class="metric-row">
          <div class="metric"><div class="label">Documents</div><div class="value">${documents.length}</div></div>
          <div class="metric"><div class="label">Total chunks</div><div class="value">${totalChunks}</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Indexed documents</h2>
        <p class="txn-meta">Chunk text shown for the ${chunkPreviewCount ?? 0} most recently indexed document(s) only.</p>
        <table>
          <thead><tr><th>File</th><th>Size</th><th>Indexed</th><th>Pages</th><th>Chunks</th><th>Enriched</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    wireUploadCard(loadDocumentsTab);
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
    <details class="card txn-card">
      <summary class="txn-summary">
        <span class="txn-summary-question">${escapeHtml(txn.question)}</span>
        <span class="txn-summary-meta">Query #${txn.id} · ${new Date(txn.timestamp).toLocaleString()} · ${escapeHtml(txn.pathTaken)} · confidence ${txn.confidence != null ? txn.confidence.toFixed(2) : "—"}</span>
      </summary>
      <div class="txn-meta">
        <strong>${escapeHtml(txn.provider)} / ${escapeHtml(txn.model)}</strong>${txn.jevModel ? ` · JEV: <strong>${escapeHtml(txn.jevModel)}</strong>` : ""}
      </div>
      <h4>Vector Retrieval results</h4>
      ${renderRetrievalTable(txn.retrieval)}
      ${
        txn.jevInput
          ? `<details class="io-block"><summary>JEV input</summary><pre>${escapeHtml(JSON.stringify(txn.jevInput, null, 2))}</pre></details>
             <details class="io-block"><summary>JEV output</summary><pre>${escapeHtml(JSON.stringify(txn.jevOutput, null, 2))}</pre></details>`
          : ""
      }
      <details class="io-block"><summary>LLM input</summary><pre>${escapeHtml(txn.llmInput)}</pre></details>
      <details class="io-block"><summary>LLM output</summary><pre>${escapeHtml(txn.llmOutput)}</pre></details>
    </details>`;
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
          <p class="txn-meta">LLM: <strong>${escapeHtml(lastTransaction.model)}</strong>${lastTransaction.jev_model ? ` · JEV: <strong>${escapeHtml(lastTransaction.jev_model)}</strong>` : ""}</p>
          <div class="metric-row">
            <div class="metric"><div class="label">Input tokens (est.)</div><div class="value">${lastTransaction.input_tokens}</div></div>
            <div class="metric"><div class="label">Output tokens (est.)</div><div class="value">${lastTransaction.output_tokens}</div></div>
            <div class="metric"><div class="label">LLM cost</div><div class="value">$${lastTransaction.llm_cost_usd.toFixed(5)}</div></div>
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
        ${lastTransaction ? `<p class="txn-meta">Most recent LLM: <strong>${escapeHtml(lastTransaction.model)}</strong>${lastTransaction.jev_model ? ` · JEV: <strong>${escapeHtml(lastTransaction.jev_model)}</strong>` : ""}</p>` : ""}
        <div class="metric-row">
          <div class="metric"><div class="label">Queries</div><div class="value">${summary?.queryCount ?? 0}</div></div>
          <div class="metric"><div class="label">Input tokens (est.)</div><div class="value">${summary?.inputTokens ?? 0}</div></div>
          <div class="metric"><div class="label">Output tokens (est.)</div><div class="value">${summary?.outputTokens ?? 0}</div></div>
          <div class="metric"><div class="label">LLM cost</div><div class="value">$${(summary?.llmCostUsd ?? 0).toFixed(5)}</div></div>
          <div class="metric"><div class="label">JEV cost</div><div class="value">$${(summary?.jevCostUsd ?? 0).toFixed(5)}</div></div>
        </div>
      </div>`;

    el.innerHTML = lastCard + summaryCard;
    document.getElementById("range-picker").addEventListener("change", (e) => loadCostingTab(e.target.value));
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab: Settings ---

async function loadSettingsTab() {
  const el = document.getElementById("tab-settings");
  renderLoading(el);
  try {
    const { config } = await fetchAdmin("/admin/config");
    el.innerHTML = `
      <div class="card">
        <h2>Runtime settings</h2>
        <p class="txn-meta">Changes apply to the next question asked - Cloudflare Workers have no long-running process to restart.</p>
        <form id="settings-form" class="settings-form">
          <label>Top K chunks retrieved
            <input type="number" name="topK" min="1" step="1" value="${config.topK}" />
          </label>
          <label>Confidence threshold (0-1)
            <input type="number" name="confidenceThreshold" min="0" max="1" step="0.01" value="${config.confidenceThreshold}" />
          </label>
          <fieldset>
            <legend>Web search mode</legend>
            <label class="checkbox-row"><input type="radio" name="webSearchMode" value="rag_only" ${config.webSearchMode === "rag_only" ? "checked" : ""} /> RAG only</label>
            <label class="checkbox-row"><input type="radio" name="webSearchMode" value="rag_web_fallback" ${config.webSearchMode === "rag_web_fallback" ? "checked" : ""} /> RAG + web fallback</label>
          </fieldset>
          <label class="checkbox-row"><input type="checkbox" name="hardFailNoDocument" ${config.hardFailNoDocument ? "checked" : ""} /> Hard fail when no document found</label>
          <label class="checkbox-row"><input type="checkbox" name="jevEnabled" ${config.jevEnabled ? "checked" : ""} /> JEV relevance filtering enabled</label>
          <label>JEV relevance threshold (0-3, lower = less strict)
            <input type="number" name="jevRelevanceThreshold" min="0" max="3" step="0.1" value="${config.jevRelevanceThreshold}" />
          </label>
          <label class="checkbox-row"><input type="checkbox" name="guardrailEnabled" ${config.guardrailEnabled ? "checked" : ""} /> Guardrail enabled</label>
          <button type="submit">Save</button>
        </form>
        <p id="settings-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>LLM provider</h2>
        <p class="txn-meta">Controls which model answers chat questions. Changes apply to the next question asked.</p>
        <form id="llm-form" class="settings-form">
          <label>Provider
            <input type="text" value="OpenRouter" disabled />
          </label>
          <label>Model (slug)
            <input type="text" name="llmModelSlug" value="${escapeHtml(config.llmModelSlug)}" placeholder="qwen/qwen-2.5-72b-instruct:free" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="llm-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>Ingestion enrichment</h2>
        <p class="txn-meta">Extracts formulas, tables, and figures from uploaded PDFs via a vision-capable model before chunking. Applies to documents uploaded after this is enabled - ingestion skips a filename it already has, so an already-indexed document won't get enrichment just by re-uploading it under the same name.</p>
        <form id="ingestion-form" class="settings-form">
          <label class="checkbox-row"><input type="checkbox" name="ingestionEnrichmentEnabled" ${config.ingestionEnrichmentEnabled ? "checked" : ""} /> Enrichment enabled</label>
          <label>Model (slug)
            <input type="text" name="ingestionModelSlug" value="${escapeHtml(config.ingestionModelSlug)}" placeholder="google/gemini-2.5-flash" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="ingestion-status" class="txn-meta"></p>
      </div>`;

    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("settings-status");
      const update = {
        topK: Number(form.topK.value),
        confidenceThreshold: Number(form.confidenceThreshold.value),
        webSearchMode: form.webSearchMode.value,
        hardFailNoDocument: form.hardFailNoDocument.checked,
        jevEnabled: form.jevEnabled.checked,
        jevRelevanceThreshold: Number(form.jevRelevanceThreshold.value),
        guardrailEnabled: form.guardrailEnabled.checked,
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("llm-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("llm-status");
      const update = { llmModelSlug: form.llmModelSlug.value.trim() };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("ingestion-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("ingestion-status");
      const update = {
        ingestionEnrichmentEnabled: form.ingestionEnrichmentEnabled.checked,
        ingestionModelSlug: form.ingestionModelSlug.value.trim(),
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - applies to documents uploaded from now on.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab switching ---

const tabLoaders = {
  documents: loadDocumentsTab,
  transactions: loadTransactionsTab,
  costing: () => loadCostingTab(),
  settings: loadSettingsTab,
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
