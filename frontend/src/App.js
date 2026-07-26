import React, { useState, useRef, useEffect } from "react";
import "./App.css";

const API_BASE = "http://localhost:5000";

const LS_MESSAGES = "readingRoom.messages";
const LS_DOCUMENTS = "readingRoom.documents";
const LS_THEME = "readingRoom.theme";
const MAX_HISTORY_TURNS = 8;

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [pendingFiles, setPendingFiles] = useState([]);
  const [documents, setDocuments] = useState(() => loadFromStorage(LS_DOCUMENTS, []));
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [stamp, setStamp] = useState(null); // "FILED" | "FAILED" | null
  const [aiEnabled, setAiEnabled] = useState(null); // null while unknown

  const [messages, setMessages] = useState(() => loadFromStorage(LS_MESSAGES, []));
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);

  const [theme, setTheme] = useState(() => loadFromStorage(LS_THEME, "dark"));

  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);

  // ---------- persistence ----------
  useEffect(() => {
    localStorage.setItem(LS_MESSAGES, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(LS_DOCUMENTS, JSON.stringify(documents));
  }, [documents]);

  useEffect(() => {
    localStorage.setItem(LS_THEME, JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const pushMessage = (msg) => {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), ...msg }]);
  };

  // ---------- boot: check server status + reconcile documents ----------
  useEffect(() => {
    fetch(`${API_BASE}/status`)
      .then((res) => res.json())
      .then((data) => setAiEnabled(Boolean(data.aiEnabled)))
      .catch(() => setAiEnabled(false));

    fetch(`${API_BASE}/documents`)
      .then((res) => res.json())
      .then((data) => {
        const live = data.documents || [];
        setDocuments((stored) => {
          if (stored.length > 0 && live.length === 0) {
            // Server restarted since our last session — documents are gone.
            pushMessage({
              sender: "bot",
              label: "NOTICE",
              text:
                "This session's documents were cleared (the server restarted). " +
                "Please re-upload your files to keep asking questions.",
            });
            return [];
          }
          return live;
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- file staging ----------
  const stageFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;
    setPendingFiles((prev) => {
      const existingKeys = new Set(prev.map((f) => `${f.name}-${f.size}`));
      const fresh = incoming.filter((f) => !existingKeys.has(`${f.name}-${f.size}`));
      return [...prev, ...fresh];
    });
  };

  const removePendingFile = (index) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    stageFiles(e.dataTransfer.files);
  };

  // ---------- upload ----------
  const uploadFiles = async () => {
    if (pendingFiles.length === 0 || uploading) return;
    setUploading(true);
    setStamp(null);

    let allOk = true;

    for (const file of pendingFiles) {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: formData });
        const data = await res.json();

        if (data.success) {
          setDocuments((prev) => [
            ...prev,
            { id: data.id, fileName: data.fileName, lines: data.lines, words: data.words },
          ]);
          pushMessage({
            sender: "bot",
            label: "RESULT",
            text: data.summary
              ? `${data.message}\n\nSummary: ${data.summary}`
              : data.message,
          });
        } else {
          allOk = false;
          pushMessage({
            sender: "bot",
            label: "RESULT",
            text: data.message || `Couldn't read "${file.name}".`,
          });
        }
      } catch {
        allOk = false;
        pushMessage({
          sender: "bot",
          label: "RESULT",
          text: "Couldn't reach the server — is the backend running?",
        });
      }
    }

    setStamp(allOk ? "FILED" : "FAILED");
    setUploading(false);
    setPendingFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setTimeout(() => setStamp(null), 2600);
  };

  const removeDocument = async (id) => {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    try {
      await fetch(`${API_BASE}/documents/${id}`, { method: "DELETE" });
    } catch {
      // best-effort; local state already updated
    }
  };

  const clearAllDocuments = async () => {
    setDocuments([]);
    try {
      await fetch(`${API_BASE}/documents`, { method: "DELETE" });
    } catch {
      // best-effort
    }
    pushMessage({ sender: "bot", label: "NOTICE", text: "All documents cleared from the desk." });
  };

  const clearChat = () => {
    setMessages([]);
    try {
      localStorage.removeItem(LS_MESSAGES);
    } catch {
      // best-effort
    }
  };

  // ---------- ask ----------
  const askQuestion = async (overrideText) => {
    const q = (overrideText ?? question).trim();
    if (!q || loading) return;

    const history = messages
      .filter((m) => !m.isFullContent && m.label !== "NOTICE")
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({ role: m.sender === "user" ? "user" : "model", text: m.text }));

    pushMessage({ sender: "user", label: "QUERY", text: q });
    setQuestion("");
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      const data = await res.json();

      pushMessage({
        sender: "bot",
        label: data.isFullContent ? "FULL RECORD" : "RESULT",
        text: data.answer,
        isFullContent: Boolean(data.isFullContent),
        source: data.source,
      });
    } catch {
      pushMessage({
        sender: "bot",
        label: "RESULT",
        text: "Couldn't reach the server — is the backend running?",
      });
    }

    setLoading(false);
  };

  const totalWords = documents.reduce((sum, d) => sum + (d.words || 0), 0);
  const totalLines = documents.reduce((sum, d) => sum + (d.lines || 0), 0);

  return (
    <div className={`room theme-${theme}`}>
      <div className="grainOverlay" aria-hidden="true" />

      <button
        className="themeToggle"
        onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        aria-label="Toggle light and dark theme"
        title="Toggle theme"
      >
        {theme === "dark" ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      <header className="deskHeader">
        <div className="eyebrow">READING ROOM</div>
        <h1 className="title">The Reading Room</h1>
        <p className="tagline">
          File documents, then ask about them — follow-up questions and all — or ask
          to see the whole record.
        </p>
        {aiEnabled !== null && (
          <div className={`modeBadge ${aiEnabled ? "modeBadge--ai" : "modeBadge--basic"}`}>
            <span className="modeBadge__dot" />
            {aiEnabled ? "AI-powered answers" : "Basic keyword search"}
          </div>
        )}
      </header>

      {aiEnabled === false && (
        <div className="stickyNote">
          Running without an API key — answers use simple keyword matching.
          Get a free key at{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>{" "}
          and add it as <code>GEMINI_API_KEY</code> in <code>backend/.env</code>{" "}
          for full AI-powered answers.
        </div>
      )}

      <main className="desk">
        <section
          className={`dropzone ${dragActive ? "dropzone--active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          <div className="dropzone__inner">
            <svg
              className="dropzone__icon"
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 3v12m0-12 4.5 4.5M12 3 7.5 7.5M4 16.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            <div className="dropzone__text">
              {pendingFiles.length > 0 ? (
                <>
                  <strong>
                    {pendingFiles.length} file{pendingFiles.length > 1 ? "s" : ""} staged
                  </strong>
                  <span className="dropzone__meta">ready to file</span>
                </>
              ) : (
                <>
                  <strong>Drop .txt or .pdf files on the desk</strong>
                  <span className="dropzone__meta">or click to browse — multiple files OK</span>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.pdf,text/plain,application/pdf"
              onChange={(e) => stageFiles(e.target.files)}
              className="dropzone__input"
            />

            <button
              className="fileButton"
              disabled={pendingFiles.length === 0 || uploading}
              onClick={uploadFiles}
            >
              {uploading
                ? "Filing…"
                : `Upload${pendingFiles.length > 1 ? ` (${pendingFiles.length})` : ""}`}
            </button>
          </div>

          {pendingFiles.length > 0 && (
            <div className="stagedList">
              {pendingFiles.map((f, i) => (
                <span key={`${f.name}-${f.size}`} className="stagedChip">
                  {f.name}
                  <button
                    className="stagedChip__remove"
                    onClick={() => removePendingFile(i)}
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {stamp && (
            <div className={`stamp stamp--${stamp === "FILED" ? "ok" : "no"}`}>
              {stamp === "FILED" ? "FILED ✓" : "NOT FILED"}
            </div>
          )}
        </section>

        {documents.length > 0 && (
          <div className="ledgerStrip">
            <span className="ledgerStrip__dot" />
            On the desk: {totalLines} lines · {totalWords} words across{" "}
            {documents.length} file{documents.length > 1 ? "s" : ""}
            <button className="clearAllBtn" onClick={clearAllDocuments}>
              clear all
            </button>
            <div className="docChips">
              {documents.map((d) => (
                <span key={d.id} className="docChip">
                  {d.fileName}
                  <button
                    className="docChip__remove"
                    onClick={() => removeDocument(d.id)}
                    aria-label={`Remove ${d.fileName}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {messages.length > 0 && (
          <div className="chatHeaderRow">
            <button className="clearChatBtn" onClick={clearChat}>
              Clear chat
            </button>
          </div>
        )}

        <section className="chatBox" aria-live="polite">
          {messages.length === 0 && (
            <div className="emptyCard">
              No queries yet. Upload a file, then ask about it — or ask to{" "}
              <button
                className="linkChip"
                onClick={() => askQuestion("show me everything")}
              >
                show everything
              </button>
              .
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`card card--${m.sender} ${
                m.isFullContent ? "card--ledger" : ""
              } ${m.label === "NOTICE" ? "card--notice" : ""}`}
            >
              <div className="card__eyebrow">{m.label}</div>
              {m.isFullContent ? (
                <pre className="ledgerBox">{m.text}</pre>
              ) : (
                <div className="card__text">{m.text}</div>
              )}
            </div>
          ))}

          {loading && (
            <div className="card card--bot card--pending">
              <div className="card__eyebrow">RESULT</div>
              <div className="inkDots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </section>

        <section className="inputArea">
          <input
            className="questionInput"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && askQuestion()}
            placeholder="Ask about the document, or say “show everything”…"
          />
          <button
            className="sendButton"
            onClick={() => askQuestion()}
            disabled={!question.trim() || loading}
            aria-label="Send"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 12h15m0 0-6-6m6 6-6 6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </section>
      </main>
    </div>
  );
}
