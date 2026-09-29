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

const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question-input");
const answerStyleSelect = document.getElementById("answer-style-select");
const chatLog = document.getElementById("chat-log");

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
      body: JSON.stringify({ question, answerStyle: answerStyleSelect.value }),
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
