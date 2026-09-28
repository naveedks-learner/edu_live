"""
Browser-native voice input for the Ask Edukripa widget, via the Web Speech
API (window.SpeechRecognition / webkitSpeechRecognition). Free, built into
Chrome/Edge, no server-side ASR call and no API key - but only Chrome/Edge
support it, so the button disables itself with an explanatory tooltip
everywhere else (Firefox, Safari).

There's no Python API for browser speech recognition, so this is a small
inline Streamlit Custom Component (v2, no build step): the JS drives the
mic + recognition, and reports the final transcript back to Python via
setTriggerValue - see the CCv2 state-sync pattern in Streamlit's own
bundled dev docs (venv/.../developing-with-streamlit/references/).
"""

import streamlit as st

_HTML = """
<div style="display:flex; align-items:center; gap:8px;">
  <button id="mic-btn" type="button" title="Click and speak your question">🎤</button>
  <span id="mic-status"></span>
</div>
"""

_CSS = """
#mic-btn {
  width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
  background: linear-gradient(135deg, #2a78d6, #4a3aa7);
  color: #fff; font-size: 1.1rem; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(74,58,167,0.4);
  transition: filter 0.15s ease;
}
#mic-btn:hover:not(:disabled) { filter: brightness(1.1); }
#mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
#mic-btn.listening {
  background: linear-gradient(135deg, #d03b3b, #eb6834);
  animation: mic-pulse 1.2s infinite;
}
@keyframes mic-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(208,59,59,0.55); }
  70%  { box-shadow: 0 0 0 12px rgba(208,59,59,0); }
  100% { box-shadow: 0 0 0 0 rgba(208,59,59,0); }
}
#mic-status { font-size: 0.75rem; color: #52514e; }
"""

_JS = """
export default function (component) {
  const { parentElement, setTriggerValue } = component
  const btn = parentElement.querySelector("#mic-btn")
  const status = parentElement.querySelector("#mic-status")
  if (!btn || !status) return

  // Streamlit re-invokes this render function on every rerun - only wire
  // up listeners/recognition once per mounted instance.
  if (btn.dataset.wired) return
  btn.dataset.wired = "1"

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    btn.disabled = true
    btn.title = "Voice input needs Chrome or Edge (Web Speech API isn't available in this browser)."
    status.textContent = "not supported here"
    return
  }

  const recognition = new SR()
  recognition.lang = "en-US"
  recognition.continuous = false
  recognition.interimResults = true

  let listening = false

  recognition.onresult = (event) => {
    let interim = ""
    let final = ""
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript
      if (event.results[i].isFinal) {
        final += transcript
      } else {
        interim += transcript
      }
    }
    if (interim) status.textContent = interim + " …"
    if (final) {
      status.textContent = ""
      setTriggerValue("transcript", final.trim())
    }
  }

  recognition.onerror = (event) => {
    listening = false
    btn.classList.remove("listening")
    status.textContent = ""
    // "no-speech" (silence timeout) and "aborted" (user clicked stop) are
    // routine, not worth surfacing as an error to the user.
    if (event.error !== "aborted" && event.error !== "no-speech") {
      setTriggerValue("error", event.error)
    }
  }

  recognition.onend = () => {
    listening = false
    btn.classList.remove("listening")
    if (!status.textContent.endsWith("…")) status.textContent = ""
  }

  btn.onclick = () => {
    if (listening) {
      recognition.stop()
      return
    }
    listening = true
    btn.classList.add("listening")
    status.textContent = "Listening…"
    recognition.start()
  }
}
"""

_MIC = st.components.v2.component("ask_edukripa_mic", html=_HTML, css=_CSS, js=_JS)


def voice_mic_button(*, key: str):
    """
    Mounts the mic button. On the rerun where the browser finishes
    recognizing speech, the returned object's `.transcript` holds the
    final text (None otherwise); `.error` holds a Web Speech API error
    code (e.g. "not-allowed" for a denied mic permission) if one occurred.
    """
    # Trigger result attributes only exist if a (even empty) callback is
    # registered for them - otherwise accessing .transcript/.error raises
    # AttributeError on runs where the mic hasn't fired yet.
    return _MIC(key=key, on_transcript_change=lambda: None, on_error_change=lambda: None)
