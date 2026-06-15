import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import "../styles/AuthModal.css";

type View = "login" | "signup" | "reset";

interface Props {
  onClose: () => void;
  initialView?: View;
}

export const AuthModal: React.FC<Props> = ({ onClose, initialView = "login" }) => {
  const { t } = useTranslation();
  const { signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const [view,     setView]     = useState<View>(initialView);
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [name,     setName]     = useState("");
  const [error,    setError]    = useState("");
  const [info,     setInfo]     = useState("");
  const [busy,     setBusy]     = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setError(""); setInfo("");
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const err = await signIn(email, password);
    if (err) setError(err);
    else onClose();
    setBusy(false);
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError(t("auth.errors.passwordMismatch")); return; }
    if (password.length < 6)  { setError(t("auth.errors.passwordTooShort")); return; }
    setBusy(true); setError("");
    const err = await signUp(email, password, name);
    if (err) setError(err);
    else setInfo(t("auth.signup.confirmEmail"));
    setBusy(false);
  };

  const handleGoogle = async () => {
    setBusy(true); setError("");
    const err = await signInWithGoogle();
    if (err) { setError(err); setBusy(false); }
    // on success the page redirects — no need to setBusy(false)
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const err = await resetPassword(email);
    if (err) setError(err);
    else setInfo(t("auth.reset.resetSent"));
    setBusy(false);
  };

  return (
    <div className="auth-backdrop" ref={backdropRef} onClick={handleBackdrop}>
      <div className="auth-card">

        <button className="auth-close" onClick={onClose}>✕</button>

        <div className="auth-logo">
          <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
            <polyline points="5,9 11,27 18,13 25,27 31,9" stroke="url(#aml-g)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <line x1="25" y1="27" x2="31" y2="9" stroke="#4ade80" strokeWidth="2.6" strokeLinecap="round"/>
            <circle cx="18" cy="13" r="3" fill="#0284c7"/>
            <circle cx="31" cy="9"  r="3" fill="#4ade80"/>
            <defs>
              <linearGradient id="aml-g" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stopColor="#4f46e5"/>
                <stop offset="100%" stopColor="#0284c7"/>
              </linearGradient>
            </defs>
          </svg>
          <span className="auth-logo-text">{t("auth.logoText")}<span>.ai</span></span>
        </div>

        {view === "login" && (
          <>
            <h2 className="auth-title">{t("auth.login.title")}</h2>
            <p className="auth-sub">{t("auth.login.sub")}</p>
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              {t("auth.continueWithGoogle")}
            </button>
            <div className="auth-divider"><span>{t("auth.divider")}</span></div>
            <form className="auth-form" onSubmit={handleLogin}>
              <label className="auth-label">{t("auth.login.emailLabel")}
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">{t("auth.login.passwordLabel")}
                <input className="auth-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </label>
              <button type="button" className="auth-link-btn" onClick={() => setView("reset")}>{t("auth.login.forgotPassword")}</button>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.login.signingIn") : t("auth.login.signinBtn")}</button>
            </form>
            <p className="auth-switch">{t("auth.login.noAccount")} <button className="auth-link-btn" onClick={() => setView("signup")}>{t("auth.login.signupFree")}</button></p>
          </>
        )}

        {view === "signup" && (
          <>
            <h2 className="auth-title">{t("auth.signup.title")}</h2>
            <p className="auth-sub">{t("auth.signup.sub")}</p>
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              {t("auth.continueWithGoogle")}
            </button>
            <div className="auth-divider"><span>{t("auth.divider")}</span></div>
            <form className="auth-form" onSubmit={handleSignup}>
              <label className="auth-label">{t("auth.signup.fullNameLabel")}
                <input className="auth-input" type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">{t("auth.signup.emailLabel")}
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
              </label>
              <label className="auth-label">{t("auth.signup.passwordLabel")}
                <input className="auth-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </label>
              <label className="auth-label">{t("auth.signup.confirmLabel")}
                <input className="auth-input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.signup.creating") : t("auth.signup.createBtn")}</button>
            </form>
            <p className="auth-switch">{t("auth.signup.alreadyAccount")} <button className="auth-link-btn" onClick={() => setView("login")}>{t("auth.signup.signinLink")}</button></p>
          </>
        )}

        {view === "reset" && (
          <>
            <h2 className="auth-title">{t("auth.reset.title")}</h2>
            <p className="auth-sub">{t("auth.reset.sub")}</p>
            <form className="auth-form" onSubmit={handleReset}>
              <label className="auth-label">{t("auth.reset.emailLabel")}
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.reset.sending") : t("auth.reset.sendBtn")}</button>
            </form>
            <p className="auth-switch"><button className="auth-link-btn" onClick={() => setView("login")}>{t("auth.reset.backToSignin")}</button></p>
          </>
        )}

      </div>
    </div>
  );
};
