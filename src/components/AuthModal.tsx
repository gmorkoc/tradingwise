import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { CoinHintzLogo } from "./CoinHintzLogo";
import { RiskDisclaimer } from "./RiskDisclaimer";
import "../styles/AuthModal.css";

type View = "welcome" | "magic" | "sent" | "login" | "signup" | "reset";

interface Props {
  onClose: () => void;
  initialView?: string;
}

const GOOGLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
);

const APPLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
    <path d="M16.365 1.43c0 1.14-.468 2.184-1.207 2.97-.836.9-2.16 1.593-3.348 1.494-.166-1.107.468-2.29 1.166-3.01.83-.87 2.28-1.526 3.39-1.454zM20.6 17.196c-.51 1.17-.75 1.69-1.4 2.72-.91 1.44-2.19 3.23-3.78 3.24-1.41.02-1.78-.92-3.7-.91-1.92.01-2.32.93-3.73.91-1.59-.02-2.8-1.63-3.72-3.07-2.55-3.97-2.82-8.64-1.24-11.12.99-1.55 2.55-2.46 4.03-2.46 1.5 0 2.44.92 3.68.92 1.2 0 1.94-.92 3.68-.92 1.32 0 2.72.72 3.72 1.96-3.27 1.79-2.74 6.45.28 7.75z"/>
  </svg>
);

const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);
const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const EyeOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);
const EyeOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

export const AuthModal: React.FC<Props> = ({ onClose, initialView }) => {
  const { t } = useTranslation();
  const { signIn, signUp, signInWithMagicLink, signInWithGoogle, signInWithApple, appleSignInAvailable, resetPassword } = useAuth();

  const [view, setView] = useState<View>(
    initialView === "signup" ? "signup" : initialView === "login" ? "login" : "welcome"
  );
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [confirm,     setConfirm]     = useState("");
  const [name,        setName]        = useState("");
  const [error,       setError]       = useState("");
  const [info,        setInfo]        = useState("");
  const [busy,        setBusy]        = useState(false);
  const [showPw,      setShowPw]      = useState(false);
  const [showCfm,     setShowCfm]     = useState(false);
  const alreadyAgreed = !!localStorage.getItem("terms_agreed_at");
  const [termsAgreed, setTermsAgreed] = useState(alreadyAgreed);
  const [termsShake,  setTermsShake]  = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const disclaimerRef = useRef<HTMLLabelElement>(null);

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

  const saveTerms = () => {
    if (termsAgreed && !alreadyAgreed)
      localStorage.setItem("terms_agreed_at", new Date().toISOString());
  };

  // Buttons that need agreement stay clickable (not disabled) so this can
  // actually fire and give feedback, instead of a submit silently doing
  // nothing — which is what a plain disabled attribute would do.
  const requireTerms = (): boolean => {
    if (termsAgreed) return true;
    setTermsShake(true);
    disclaimerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => setTermsShake(false), 650);
    return false;
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requireTerms()) return;
    setBusy(true); setError("");
    saveTerms();
    const err = await signInWithMagicLink(email);
    if (err) { setError(err); setBusy(false); }
    else { setView("sent"); setBusy(false); }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const err = await signIn(email, password);
    if (err) {
      setError(err.toLowerCase().includes("invalid login credentials")
        ? "no_account" : err);
    } else { onClose(); }
    setBusy(false);
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requireTerms()) return;
    if (password !== confirm) { setError(t("auth.errors.passwordMismatch")); return; }
    if (password.length < 6)  { setError(t("auth.errors.passwordTooShort")); return; }
    setBusy(true); setError("");
    saveTerms();
    const err = await signUp(email, password, name);
    if (err) {
      const isDupe = err.toLowerCase().includes("already registered")
        || err.toLowerCase().includes("already been registered")
        || err.toLowerCase().includes("user already exists");
      setError(isDupe ? "sso_exists" : err);
      setBusy(false);
    } else {
      onClose();
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const err = await resetPassword(email);
    if (err) setError(err);
    else setInfo(t("auth.reset.resetSent"));
    setBusy(false);
  };

  const handleGoogle = async () => {
    // Login never needs agreement (see the note further down) — every other
    // view can create a new account via Google, so it does.
    if (view !== "login" && !requireTerms()) return;
    setBusy(true); setError("");
    saveTerms();
    const err = await signInWithGoogle();
    if (err) { setError(err); setBusy(false); }
  };

  // Unlike Google's browser-redirect flow above, this resolves in place —
  // no app close/reopen in between — so it closes the modal itself on success.
  const handleApple = async () => {
    if (view !== "login" && !requireTerms()) return;
    setBusy(true); setError("");
    saveTerms();
    const err = await signInWithApple();
    if (err) { setError(err); setBusy(false); }
    else { onClose(); }
  };

  return (
    <div className="auth-backdrop" ref={backdropRef} onClick={handleBackdrop}>
      <div className="auth-card">
        <button className="auth-close" onClick={onClose}>✕</button>

        <div className="auth-logo">
          <CoinHintzLogo variant="nav" />
        </div>

        <div className="auth-card-body">

        {/* ── Welcome gateway (default when no specific intent was given) ── */}
        {view === "welcome" && (
          <div className="auth-welcome">
            <h2 className="auth-title">{t("auth.welcome.title")}</h2>
            <p className="auth-sub">{t("auth.welcome.sub")}</p>
            <button className="auth-submit" onClick={() => setView("signup")}>
              {t("auth.welcome.createAccount")}
            </button>
            <button className="auth-welcome-login" onClick={() => setView("login")}>
              {t("auth.welcome.haveAccount")}
            </button>
          </div>
        )}

        {/* ── Magic link (default) ── */}
        {view === "magic" && (
          <>
            <h2 className="auth-title">{t("auth.magic.title")}</h2>
            <p className="auth-sub">{t("auth.magic.sub")}</p>

            {!alreadyAgreed && (
              <RiskDisclaimer
                ref={disclaimerRef}
                checked={termsAgreed}
                onChange={setTermsAgreed}
                shake={termsShake}
              />
            )}

            <form className="auth-form" onSubmit={handleMagicLink}>
              <label className="auth-label">{t("auth.login.emailLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><MailIcon /></span>
                  <input className="auth-input auth-input--leading" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
                </div>
              </label>
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" disabled={busy}>
                {busy ? t("auth.magic.sending") : t("auth.magic.sendBtn")}
              </button>
            </form>

            <div className="auth-divider"><span>{t("auth.divider")}</span></div>
            {/* Apple first, not just equally styled — Guideline 4.8 reviews
                sometimes flag a third-party sign-in option that's positioned
                below Apple's, not just one that's styled smaller/lesser. */}
            {appleSignInAvailable && (
              <button className="auth-apple" type="button" onClick={handleApple} disabled={busy}>
                {APPLE_ICON} {t("auth.continueWithApple")}
              </button>
            )}
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              {GOOGLE_ICON} {t("auth.continueWithGoogle")}
            </button>

            <p className="auth-switch">
              {t("auth.magic.preferPassword")}{" "}
              <button className="auth-link-btn" onClick={() => setView("login")}>{t("auth.magic.signinWithPassword")}</button>
            </p>
          </>
        )}

        {/* ── Sent confirmation ── */}
        {view === "sent" && (
          <div className="auth-sent">
            <div className="auth-sent-icon">✉️</div>
            <h2 className="auth-title">{t("auth.sent.title")}</h2>
            <p className="auth-sub">
              {t("auth.sent.sub", { email }).replace("<1>", "").replace("</1>", "").split(email).map((part, i, arr) =>
                i < arr.length - 1 ? <span key={i}>{part}<strong>{email}</strong></span> : <span key={i}>{part}</span>
              )}
            </p>
            <p className="auth-sent-hint">
              {t("auth.sent.hint")}{" "}
              <button className="auth-link-btn" onClick={() => { setView("magic"); setError(""); }}>{t("auth.sent.tryAgain")}</button>
            </p>
            <button className="auth-close-btn" onClick={onClose}>{t("auth.sent.close")}</button>
          </div>
        )}

        {/* ── Password login ── */}
        {view === "login" && (
          <>
            <h2 className="auth-title">{t("auth.login.title")}</h2>
            <p className="auth-sub">{t("auth.login.sub")}</p>

            {/* Logging in means the account (and its terms agreement) already
                exists — unlike signup/magic-link, this is never a first-time
                acceptance, so no disclaimer here regardless of this device's
                own localStorage state. */}

            <form className="auth-form" onSubmit={handleLogin}>
              <label className="auth-label">{t("auth.login.emailLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><MailIcon /></span>
                  <input className="auth-input auth-input--leading" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
                </div>
              </label>
              <label className="auth-label">{t("auth.login.passwordLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><LockIcon /></span>
                  {/* current-password (not new-password) is what lets iOS
                      recognize this as a login form and offer the saved
                      credential via Face ID/Touch ID-gated Keychain autofill. */}
                  <input className="auth-input auth-input--leading" type={showPw ? "text" : "password"} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              <button type="button" className="auth-link-btn" onClick={() => setView("reset")}>{t("auth.login.forgotPassword")}</button>
              {error === "no_account" ? (
                <p className="auth-error">
                  {t("auth.login.noAccountFound")}{" "}
                  <button type="button" className="auth-link-btn" onClick={() => setView("signup")}>{t("auth.login.signupFreeArrow")}</button>
                </p>
              ) : error ? <p className="auth-error">{error}</p> : null}
              {info && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.login.signingIn") : t("auth.login.signinBtn")}</button>
            </form>

            <div className="auth-divider"><span>{t("auth.divider")}</span></div>
            {/* Apple first, not just equally styled — Guideline 4.8 reviews
                sometimes flag a third-party sign-in option that's positioned
                below Apple's, not just one that's styled smaller/lesser. */}
            {appleSignInAvailable && (
              <button className="auth-apple" type="button" onClick={handleApple} disabled={busy}>
                {APPLE_ICON} {t("auth.continueWithApple")}
              </button>
            )}
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              {GOOGLE_ICON} {t("auth.continueWithGoogle")}
            </button>

            <p className="auth-switch">
              <button className="auth-link-btn" onClick={() => setView("magic")}>{t("auth.login.useMagicLink")}</button>
              {" · "}
              <button className="auth-link-btn" onClick={() => setView("signup")}>{t("auth.login.createAccount")}</button>
            </p>
          </>
        )}

        {/* ── Password signup ── */}
        {view === "signup" && (
          <>
            <h2 className="auth-title">{t("auth.signup.title")}</h2>
            <p className="auth-sub">{t("auth.signup.sub")}</p>

            {!alreadyAgreed && (
              <RiskDisclaimer
                ref={disclaimerRef}
                checked={termsAgreed}
                onChange={setTermsAgreed}
                shake={termsShake}
              />
            )}

            <form className="auth-form" onSubmit={handleSignup}>
              <label className="auth-label">{t("auth.signup.fullNameLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><UserIcon /></span>
                  <input className="auth-input auth-input--leading" type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required autoFocus />
                </div>
              </label>
              <label className="auth-label">{t("auth.signup.emailLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><MailIcon /></span>
                  <input className="auth-input auth-input--leading" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
                </div>
              </label>
              <label className="auth-label">{t("auth.signup.passwordLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><LockIcon /></span>
                  {/* new-password (distinct from login's current-password) is
                      what makes iOS offer to generate a strong password and,
                      after a successful submit, offer to save it — the same
                      Keychain entry current-password reads back on login. */}
                  <input className="auth-input auth-input--leading" type={showPw ? "text" : "password"} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              <label className="auth-label">{t("auth.signup.confirmLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><LockIcon /></span>
                  <input className="auth-input auth-input--leading" type={showCfm ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowCfm(v => !v)} tabIndex={-1}>
                    {showCfm ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              {error === "sso_exists" ? (
                <p className="auth-error">
                  {t("auth.signup.ssoExists")}{" "}
                  <button type="button" className="auth-link-btn" onClick={handleGoogle} disabled={busy}>{t("auth.signup.signinWithGoogle")}</button>
                </p>
              ) : error ? <p className="auth-error">{error}</p> : null}
              {info && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.signup.creating") : t("auth.signup.createBtn")}</button>
            </form>

            <div className="auth-divider"><span>{t("auth.divider")}</span></div>
            {/* Apple first, not just equally styled — Guideline 4.8 reviews
                sometimes flag a third-party sign-in option that's positioned
                below Apple's, not just one that's styled smaller/lesser. */}
            {appleSignInAvailable && (
              <button className="auth-apple" type="button" onClick={handleApple} disabled={busy}>
                {APPLE_ICON} {t("auth.continueWithApple")}
              </button>
            )}
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              {GOOGLE_ICON} {t("auth.continueWithGoogle")}
            </button>

            <p className="auth-switch">
              {t("auth.signup.preferNoPassword")}{" "}
              <button className="auth-link-btn" onClick={() => setView("magic")}>{t("auth.signup.sendMagicLink")}</button>
              {" · "}
              {t("auth.signup.alreadyAccount")}{" "}
              <button className="auth-link-btn" onClick={() => setView("login")}>{t("auth.signup.signinLink")}</button>
            </p>
          </>
        )}

        {/* ── Password reset ── */}
        {view === "reset" && (
          <>
            <h2 className="auth-title">{t("auth.reset.title")}</h2>
            <p className="auth-sub">{t("auth.reset.sub")}</p>
            <form className="auth-form" onSubmit={handleReset}>
              <label className="auth-label">{t("auth.reset.emailLabel")}
                <div className="auth-input-wrap">
                  <span className="auth-input-leading-icon"><MailIcon /></span>
                  <input className="auth-input auth-input--leading" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
                </div>
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? t("auth.reset.sending") : t("auth.reset.sendBtn")}</button>
            </form>
            <p className="auth-switch">
              <button className="auth-link-btn" onClick={() => setView("login")}>{t("auth.reset.backToSignin")}</button>
            </p>
          </>
        )}

        </div>
      </div>
    </div>
  );
};
