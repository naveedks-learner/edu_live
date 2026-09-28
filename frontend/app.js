const WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";
// Shared secret for POST /ingest, mirrors the Worker's INGEST_API_KEY.
// Update this if you configure INGEST_API_KEY via `wrangler secret put`.
const INGEST_KEY = "";

const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadStatus = document.getElementById("upload-status");
const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question-input");
const chatLog = document.getElementById("chat-log");

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

  try {
    const response = await fetch(`${WORKER_URL}/ingest`, {
      method: "POST",
      headers: INGEST_KEY ? { "x-ingest-key": INGEST_KEY } : {},
      body: formData,
    });
    const result = await response.json();

    uploadStatus.textContent = response.ok
      ? `${result.status}: ${result.source}${result.chunkCount ? ` (${result.chunkCount} chunks)` : ""}`
      : `Error: ${result.error}`;
  } catch (err) {
    uploadStatus.textContent = `Error: could not reach the server (${err.message})`;
  } finally {
    uploadBtn.disabled = false;
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  const submitBtn = chatForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  try {
    const response = await fetch(`${WORKER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();

    appendMessage("assistant", result.answer ?? `Error: ${result.error}`);
  } catch (err) {
    appendMessage("assistant", `Error: could not reach the server (${err.message})`);
  } finally {
    submitBtn.disabled = false;
  }
});

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}
