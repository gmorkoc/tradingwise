import { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
import "../styles/ContactForm.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORIES = [
  { value: "bug",      label: "🐛  Bug Report" },
  { value: "feature",  label: "✨  Feature Request" },
  { value: "feedback", label: "💬  General Feedback" },
  { value: "other",    label: "📬  Other" },
];

export const ContactForm: React.FC<Props> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const backdropRef = useRef<HTMLDivElement>(null);

  const [category, setCategory] = useState("feedback");
  const [email,    setEmail]    = useState("");
  const [message,  setMessage]  = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState("");
  const [sent,     setSent]     = useState(false);

  useEffect(() => {
    if (isOpen) {
      setEmail(user?.email ?? "");
      setCategory("feedback");
      setMessage("");
      setError("");
      setSent(false);
    }
  }, [isOpen, user]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) { setError("Please write a message before submitting."); return; }
    if (!email.trim())   { setError("Please enter your email address."); return; }

    setBusy(true);
    setError("");

    const categoryLabel = CATEGORIES.find((c) => c.value === category)?.label ?? category;

    // Save to Supabase
    const { error: sbErr } = await supabase
      .from("contact_submissions")
      .insert({
        category,
        email:   email.trim(),
        message: message.trim(),
        user_id: user?.id ?? null,
      });

    if (sbErr) {
      setBusy(false);
      setError("Something went wrong. Please try again.");
      return;
    }

    // Forward to Gmail via Web3Forms
    const w3fKey = import.meta.env.VITE_WEB3FORMS_KEY as string | undefined;
    if (w3fKey) {
      await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key:  w3fKey,
          subject:     `[CoinHintz] ${categoryLabel} from ${email.trim()}`,
          from_name:   "CoinHintz Contact Form",
          replyto:     email.trim(),
          category:    categoryLabel,
          message:     message.trim(),
        }),
      }).catch(() => { /* email forwarding failure is non-fatal */ });
    }

    setBusy(false);
    setSent(true);
  };

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="cf-overlay" ref={backdropRef} onClick={handleBackdrop}>
      <div className="cf-panel" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="cf-header">
          <div>
            <h2 className="cf-title">Contact Us</h2>
            <p className="cf-subtitle">We read every message.</p>
          </div>
          <button className="cf-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {sent ? (
          <div className="cf-success">
            <span className="cf-success-icon">✅</span>
            <p className="cf-success-title">Message sent!</p>
            <p className="cf-success-body">Thanks for reaching out. We'll get back to you soon.</p>
            <button className="cf-submit" onClick={onClose}>Close</button>
          </div>
        ) : (
          <form className="cf-form" onSubmit={handleSubmit} noValidate>
            {/* Category */}
            <div className="cf-field">
              <label className="cf-label">Category</label>
              <div className="cf-category-grid">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`cf-category-btn${category === c.value ? " cf-category-btn--active" : ""}`}
                    onClick={() => setCategory(c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Email */}
            <div className="cf-field">
              <label className="cf-label" htmlFor="cf-email">Your Email</label>
              <input
                id="cf-email"
                className="cf-input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {/* Message */}
            <div className="cf-field">
              <label className="cf-label" htmlFor="cf-message">Message</label>
              <textarea
                id="cf-message"
                className="cf-textarea"
                placeholder="Describe the issue or share your thoughts..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                required
              />
              <span className="cf-char-count">{message.length} / 1000</span>
            </div>

            {error && <p className="cf-error">{error}</p>}

            <button className="cf-submit" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send Message"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
