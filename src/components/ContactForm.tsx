import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
import { BottomSheet } from "./BottomSheet";
import "../styles/ContactForm.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

// `label` (English) is what the forwarded support email uses; the form
// shows contactForm.categories.<value> instead.
const CATEGORIES = [
  { value: "bug",      icon: "🐛", label: "🐛  Bug Report" },
  { value: "feature",  icon: "✨", label: "✨  Feature Request" },
  { value: "feedback", icon: "💬", label: "💬  General Feedback" },
  { value: "other",    icon: "📬", label: "📬  Other" },
];

export const ContactForm: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const backdropRef = useRef<HTMLDivElement>(null);
  const catRef = useRef<HTMLDivElement>(null);
  const [catOpen, setCatOpen] = useState(false);
  useEffect(() => {
    if (!catOpen) return;
    const away = (e: PointerEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [catOpen]);
  useEffect(() => { if (!isOpen) setCatOpen(false); }, [isOpen]);
  const [isPhone, setIsPhone] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setIsPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

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
    if (!message.trim()) { setError(t("contactForm.errMessage")); return; }
    if (!email.trim())   { setError(t("contactForm.errEmail")); return; }

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
      setError(t("contactForm.errGeneric"));
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
          subject:     `[coinhintz] ${categoryLabel} from ${email.trim()}`,
          from_name:   "coinhintz Contact Form",
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

  const body = sent ? (
          <div className="cf-success">
            <span className="cf-success-icon">✅</span>
            <p className="cf-success-title">{t("contactForm.sentTitle")}</p>
            <p className="cf-success-body">{t("contactForm.sentBody")}</p>
            <button className="cf-submit" onClick={onClose}>{t("contactForm.close")}</button>
          </div>
        ) : (
          <form className="cf-form" onSubmit={handleSubmit} noValidate>
            {/* Category */}
            <div className="cf-field">
              <label className="cf-label" htmlFor="cf-category">{t("contactForm.category")}</label>
              {isPhone ? (
                <div className="cf-select-wrap" ref={catRef}>
                  <button
                    type="button"
                    id="cf-category"
                    className={`cf-input cf-select${catOpen ? " cf-select--open" : ""}`}
                    aria-haspopup="listbox"
                    aria-expanded={catOpen}
                    onClick={() => setCatOpen((v) => !v)}
                  >
                    {(() => { const c = CATEGORIES.find((x) => x.value === category) ?? CATEGORIES[0];
                      return <>{c.icon}  {t(`contactForm.categories.${c.value}`)}</>; })()}
                  </button>
                  <svg className="cf-select-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                  {catOpen && (
                    <ul className="cf-select-list" role="listbox">
                      {CATEGORIES.map((c) => (
                        <li key={c.value}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={category === c.value}
                            className={`cf-select-opt${category === c.value ? " cf-select-opt--on" : ""}`}
                            onClick={() => { setCategory(c.value); setCatOpen(false); }}
                          >
                            <span>{c.icon}  {t(`contactForm.categories.${c.value}`)}</span>
                            {category === c.value && (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
              <div className="cf-category-grid">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`cf-category-btn${category === c.value ? " cf-category-btn--active" : ""}`}
                    onClick={() => setCategory(c.value)}
                  >
                    {c.icon}  {t(`contactForm.categories.${c.value}`)}
                  </button>
                ))}
              </div>
              )}
            </div>

            {/* Email */}
            <div className="cf-field">
              <label className="cf-label" htmlFor="cf-email">{t("contactForm.yourEmail")}</label>
              <input
                id="cf-email"
                className="cf-input"
                type="email"
                placeholder={t("contactForm.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {/* Message */}
            <div className="cf-field">
              <label className="cf-label" htmlFor="cf-message">{t("contactForm.message")}</label>
              <textarea
                id="cf-message"
                className="cf-textarea"
                placeholder={t("contactForm.messagePlaceholder")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                required
              />
              <span className="cf-char-count">{message.length} / 1000</span>
            </div>

            {error && <p className="cf-error">{error}</p>}

            <button className="cf-submit" type="submit" disabled={busy}>
              {busy ? t("contactForm.sending") : t("contactForm.send")}
            </button>
          </form>
        );

  // Phones and the iOS app get the shared bottom sheet; desktop keeps the modal.
  if (isPhone) {
    return (
      <BottomSheet
        open={isOpen}
        onClose={onClose}
        title={t("contactForm.title")}
        className="cf-sheet"
        bodyClassName="cf-sheet-body"
        ariaLabel={t("contactForm.title")}
      >
        <p className="cf-subtitle cf-sheet-subtitle">{t("contactForm.subtitle")}</p>
        {body}
      </BottomSheet>
    );
  }

  if (!isOpen) return null;

  return (
    <div className="cf-overlay" ref={backdropRef} onClick={handleBackdrop}>
      <div className="cf-panel" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="cf-header">
          <div>
            <h2 className="cf-title">{t("contactForm.title")}</h2>
            <p className="cf-subtitle">{t("contactForm.subtitle")}</p>
          </div>
          <button className="cf-close" onClick={onClose} aria-label={t("contactForm.close")}>✕</button>
        </div>

        {body}
      </div>
    </div>
  );
};
