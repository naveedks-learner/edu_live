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

const THINKING_PHRASES = ["Thinking", "Searching your notes", "Checking sources", "Composing an answer"];

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  const submitBtn = chatForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  const thinkingEl = appendMessage("assistant", `${THINKING_PHRASES[0]}...`, { thinking: true });
  let phraseIndex = 0;
  const timer = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.length;
    thinkingEl.textContent = `${THINKING_PHRASES[phraseIndex]}...`;
  }, 1200);

  try {
    const response = await fetch(`${WORKER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();

    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;
  } catch (err) {
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = `Error: could not reach the server (${err.message})`;
  } finally {
    clearInterval(timer);
    submitBtn.disabled = false;
  }
});

function appendMessage(role, text, { thinking = false } = {}) {
  const el = document.createElement("div");
  el.className = `message ${role}${thinking ? " thinking" : ""}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}
