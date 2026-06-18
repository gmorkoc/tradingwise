import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { CoinHintzLogo } from "./CoinHintzLogo";
import "../styles/AuthModal.css";

type View = "login" | "signup" | "reset";

interface Props {
  onClose: () => void;
  initialView?: View;
}

export const AuthModal: React.FC<Props> = ({ onClose, initialView = "login" }) => {
  const { t } = useTranslation();
  const { signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const [view,         setView]         = useState<View>(initialView);
  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [confirm,      setConfirm]      = useState("");
  const [name,         setName]         = useState("");
  const [error,        setError]        = useState("");
  const [info,         setInfo]         = useState("");
  const [busy,         setBusy]         = useState(false);
  const [showPw,       setShowPw]       = useState(false);
  const [showCfm,      setShowCfm]      = useState(false);
  const [termsAgreed,  setTermsAgreed]  = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setError(""); setInfo(""); setTermsAgreed(false);
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
    if (err) {
      const isNotFound = err.toLowerCase().includes("invalid login credentials");
      setError(isNotFound ? "no_account" : err);
    } else {
      onClose();
    }
    setBusy(false);
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError(t("auth.errors.passwordMismatch")); return; }
    if (password.length < 6)  { setError(t("auth.errors.passwordTooShort")); return; }
    setBusy(true); setError("");
    const err = await signUp(email, password, name);
    if (err) {
      const isDuplicate = err.toLowerCase().includes("already registered")
        || err.toLowerCase().includes("already been registered")
        || err.toLowerCase().includes("user already exists");
      setError(isDuplicate ? "sso_exists" : err);
    } else {
      localStorage.setItem("terms_agreed_at", new Date().toISOString());
      setInfo(t("auth.signup.confirmEmail"));
    }
    setBusy(false);
  };

  const handleGoogle = async () => {
    setBusy(true); setError("");
    if (view === "signup") {
      localStorage.setItem("terms_agreed_at", new Date().toISOString());
    }
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
          <CoinHintzLogo variant="nav" />
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
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw
                      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </label>
              <button type="button" className="auth-link-btn" onClick={() => setView("reset")}>{t("auth.login.forgotPassword")}</button>
              {error === "no_account" ? (
                <p className="auth-error">
                  No account found with this email.{" "}
                  <button type="button" className="auth-link-btn" onClick={() => setView("signup")}>Sign up free →</button>
                </p>
              ) : error ? (
                <p className="auth-error">{error}</p>
              ) : null}
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

            <div className="auth-disclaimer">
              <div className="auth-disclaimer-scroll">
                <p className="auth-disclaimer-heading">⚠️ Risk Disclaimer &amp; Terms of Use</p>
                <p>CoinHintz provides market data, analytical tools, and AI-generated signals for <strong>informational and educational purposes only</strong>. Nothing on this platform constitutes financial, investment, legal, or tax advice of any kind.</p>
                <p><strong>Cryptocurrency trading involves substantial risk of loss.</strong> Digital asset markets are highly volatile and largely unregulated. You may lose some or all of your invested capital. Never invest money you cannot afford to lose.</p>
                <p>All AI predictions, signals, funding rate analyses, and market insights are generated algorithmically and are <strong>not guaranteed to be accurate, complete, or timely</strong>. Past performance of any signal or strategy does not guarantee future results.</p>
                <p>Market data displayed may be delayed, incomplete, or inaccurate. CoinHintz makes no representations or warranties regarding data accuracy, and is not liable for any errors or omissions in the information provided.</p>
                <p><strong>You are solely responsible for any financial decisions you make.</strong> CoinHintz and its operators bear no liability for any financial losses, missed opportunities, or damages of any kind arising from your use of this platform.</p>
                <p>This platform is intended for users who are of legal age and legally permitted to engage with cryptocurrency services in their jurisdiction. By creating an account you confirm both conditions.</p>
                <p>CoinHintz reserves the right to update these terms at any time. Continued use of the platform constitutes acceptance of any revised terms.</p>
              </div>
              <label className="auth-terms-check">
                <input
                  type="checkbox"
                  checked={termsAgreed}
                  onChange={e => setTermsAgreed(e.target.checked)}
                />
                <span>I have read and agree — I understand this is not financial advice and I trade entirely at my own risk</span>
              </label>
            </div>

            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy || !termsAgreed}>
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
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw
                      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </label>
              <label className="auth-label">{t("auth.signup.confirmLabel")}
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showCfm ? "text" : "password"} value={confirm} onChange={e => setConfirm(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowCfm(v => !v)} tabIndex={-1}>
                    {showCfm
                      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </label>
              {error === "sso_exists" ? (
                <p className="auth-error">
                  This email is already linked to a Google account.{" "}
                  <button type="button" className="auth-link-btn" onClick={handleGoogle}>Sign in with Google →</button>
                </p>
              ) : error ? (
                <p className="auth-error">{error}</p>
              ) : null}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy || !termsAgreed}>{busy ? t("auth.signup.creating") : t("auth.signup.createBtn")}</button>
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
