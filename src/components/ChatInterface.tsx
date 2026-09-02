import React, { useState, useRef, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { useTranslation } from "react-i18next";
import { openai, ChatMessage } from "../services/openai";
import { BTCData, coinglass } from "../services/coinglass";
import { useAIQuota } from "../hooks/useAIQuota";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import "../styles/ChatInterface.css";

interface ChatInterfaceProps {
  btcData: Partial<BTCData> | null;
  embedded?: boolean;
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

const predictionTriggers = [
  "predict", "prediction", "forecast", "trend",
  "bullish", "bearish", "outlook", "analysis",
  "price target", "future price", "technical",
];

const shouldFetchFreshMarketData = (message: string) => {
  const normalized = message.toLowerCase();
  return predictionTriggers.some((t) => normalized.includes(t));
};

interface DisplayMessage extends ChatMessage {
  id: string;
  images?: string[]; // display-only, not persisted to localStorage
}

const CHAT_STORAGE_KEY = "coinhintzChatMessages";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ btcData, embedded = false, onOpenAuth, onOpenUpgrade }) => {
  const { t } = useTranslation();
  const { exceeded, consume } = useAIQuota();
  const { tier, user } = useAuth();
  const hasPro = hasAccess(tier, "pro");

  const defaultMessages = (): DisplayMessage[] => [
    { id: "0", role: "assistant", content: t("chat.defaultMessage", { coin: "BTC" }) },
  ];

  const [isOpen,    setIsOpen]    = useState(false);

  // Lets other floating widgets (Daily Brief) hide themselves while this
  // panel is open, instead of stacking/overlapping it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("ai-chat-active", { detail: isOpen }));
    return () => { if (isOpen) window.dispatchEvent(new CustomEvent("ai-chat-active", { detail: false })); };
  }, [isOpen]);

  const [messages,  setMessages]  = useState<DisplayMessage[]>(() => {
    if (typeof window === "undefined") return defaultMessages();
    try {
      const stored = window.localStorage.getItem(CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as DisplayMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return defaultMessages();
  });
  const [input,     setInput]     = useState("");
  const [images,    setImages]    = useState<string[]>([]);   // pending attachments
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const isInitialMount = useRef(true);
  const panelRef        = useRef<HTMLDivElement>(null);

  // capacitor.config.ts sets Keyboard resize:'none' globally (needed
  // elsewhere to stop a coin-picker popover getting stuck shifted), so this
  // fixed-position full-height panel never shrinks for the keyboard on its
  // own — the input row at its bottom just ends up hidden underneath it.
  // Pulling the panel's own `bottom` up by the keyboard height reflows its
  // flex column so the input stays above the keyboard, without touching the
  // global setting other components rely on.
  useEffect(() => {
    if (embedded || !Capacitor.isNativePlatform()) return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (panelRef.current) panelRef.current.style.bottom = `${info.keyboardHeight}px`;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (panelRef.current) panelRef.current.style.bottom = "0px";
    });
    return () => { showSub.then(s => s.remove()); hideSub.then(s => s.remove()); };
  }, [embedded]);

  // Persist messages without images (too large for localStorage)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const toSave = messages.map(({ images: _imgs, ...m }) => m);
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(toSave));
    }
  }, [messages]);

  useEffect(() => {
    if (isInitialMount.current) { isInitialMount.current = false; return; }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 120);
      messagesEndRef.current?.scrollIntoView();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  // ── Image helpers ────────────────────────────────────────────────────────────

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type.startsWith("image/")).slice(0, 4);
    if (!arr.length) return;
    const b64s = await Promise.all(arr.map(fileToBase64));
    setImages(prev => [...prev, ...b64s].slice(0, 4));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
    if (imageFiles.length) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  };

  const removeImage = (idx: number) => setImages(prev => prev.filter((_, i) => i !== idx));

  // ── Send ─────────────────────────────────────────────────────────────────────

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() && !images.length) return;
    if (!hasPro) { onOpenUpgrade?.(); return; }

    // Gate quota BEFORE touching UI state — await to catch DB write failures
    if (exceeded || !(await consume())) {
      setError(t("chat.quotaExceeded", "Weekly AI limit reached. Upgrade to Elite for unlimited access."));
      return;
    }

    const snap = [...images];
    const userMsg: DisplayMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input || "Please analyse this image.",
      images: snap.length ? snap : undefined,
    };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setImages([]);
    setLoading(true);
    setError("");

    const history = next
      .filter(m => m.role !== "system")
      .slice(0, -1) // exclude the message we just added (sent separately with images)
      .map(m => ({ role: m.role, content: m.content }) as ChatMessage);

    const marketData = shouldFetchFreshMarketData(input) || !btcData
      ? await coinglass.getAllBTCData().catch(() => btcData)
      : btcData;

    const response = await openai.chat(userMsg.content, marketData, history, snap.length ? snap : undefined);

    if (response.success) {
      setMessages(prev => [
        ...prev,
        { id: (Date.now() + 1).toString(), role: "assistant", content: response.message },
      ]);
    } else {
      setError(response.error || "Failed to get response");
    }
    setLoading(false);
  };

  const handleClear = () => {
    setMessages(defaultMessages());
    setImages([]);
    if (typeof window !== "undefined") window.localStorage.removeItem(CHAT_STORAGE_KEY);
    setError("");
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const panel = (
    <div ref={panelRef} className={`chat-panel${embedded ? " chat-panel--embedded" : ""}`}>
      <div className="chat-header">
        <div className="chat-header-title">
          <h2>{t("chat.title")}</h2>
          {btcData?.price && (
            <span className="btc-context">
              BTC: ${btcData.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        <div className="chat-header-actions">
          <button type="button" className="clear-chat-btn" onClick={handleClear} disabled={loading}>
            {t("chat.clear")}
          </button>
          {!embedded && (
            <button type="button" className="chat-close-btn" onClick={() => setIsOpen(false)}>✕</button>
          )}
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.role === "assistant" && <span className="chat-ai-badge">✦ AI Powered</span>}
            {msg.images && msg.images.length > 0 && (
              <div className="chat-msg-images">
                {msg.images.map((src, i) => (
                  <img key={i} src={src} alt="" className="chat-msg-image" />
                ))}
              </div>
            )}
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        {loading && (
          <div className="message assistant loading">
            <div className="message-content">
              <div className="typing-indicator"><span /><span /><span /></div>
            </div>
          </div>
        )}
        {error && <div className="message error"><div className="message-content">{error}</div></div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <form onSubmit={handleSend} className="chat-input-card">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          {/* Image previews inside card */}
          {images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((src, i) => (
                <div key={i} className="chat-image-preview">
                  <img src={src} alt="" />
                  <button className="chat-image-remove" onClick={() => removeImage(i)} type="button">✕</button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as unknown as React.FormEvent); }
            }}
            onPaste={handlePaste}
            placeholder={images.length ? "Ask about the image…" : "Ask anything"}
            disabled={loading}
            rows={1}
            className="chat-input"
          />

          <div className="chat-input-toolbar">
            <div className="chat-toolbar-left">
              <button
                type="button"
                className="chat-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                disabled={loading}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
              <button type="button" className="chat-tool-btn" title="Web search" disabled>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
              </button>
              <button type="button" className="chat-tool-btn" title="Image" onClick={() => fileInputRef.current?.click()} disabled={loading}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
              <span className="chat-toolbar-label">AI Powered</span>
            </div>

            <div className="chat-toolbar-right">
              <button
                type="submit"
                className="chat-send-btn"
                disabled={loading || (!input.trim() && !images.length)}
                title="Send"
              >
                {loading
                  ? <span className="chat-send-spinner" />
                  : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5"/>
                      <polyline points="5 12 12 5 19 12"/>
                    </svg>
                  )
                }
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  if (embedded) return panel;

  const handleFabClick = () => {
    if (!hasPro) {
      if (!user) { onOpenAuth?.(); } else { onOpenUpgrade?.(); }
      return;
    }
    setIsOpen(v => !v);
  };

  return (
    <>
      {isOpen && hasPro && panel}
      <div className="chat-fab-wrap">
        <button
          className={`chat-fab ${isOpen ? "open" : ""}`}
          onClick={handleFabClick}
          title={hasPro ? t("chat.title") : "AI Chat · Pro required"}
        >
          {isOpen && hasPro ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L13.8 9.3L21 12L13.8 14.7L12 22L10.2 14.7L3 12L10.2 9.3Z"/>
              <path d="M19.5 4.5L20.2 6.8L22.5 7.5L20.2 8.2L19.5 10.5L18.8 8.2L16.5 7.5L18.8 6.8Z" opacity="0.8"/>
            </svg>
          )}
        </button>
      </div>
    </>
  );
};
