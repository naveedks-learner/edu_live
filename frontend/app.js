const WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";

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

  uploadStatus.textContent = "Uploading...";
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${WORKER_URL}/ingest`, { method: "POST", body: formData });
  const result = await response.json();

  uploadStatus.textContent = response.ok
    ? `${result.status}: ${result.source}${result.chunkCount ? ` (${result.chunkCount} chunks)` : ""}`
    : `Error: ${result.error}`;
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";

  const response = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const result = await response.json();

  appendMessage("assistant", result.answer ?? `Error: ${result.error}`);
});

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}
