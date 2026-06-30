import { useState, useRef, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { CoinHintzLogo } from "./CoinHintzLogo";
import "../styles/AuthModal.css";

type View = "magic" | "sent" | "login" | "signup" | "reset";

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
  const { signIn, signUp, signInWithMagicLink, signInWithGoogle, resetPassword } = useAuth();

  const [view, setView] = useState<View>(
    initialView === "signup" ? "signup" : initialView === "login" ? "login" : "magic"
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

  const saveTerms = () => {
    if (termsAgreed && !alreadyAgreed)
      localStorage.setItem("terms_agreed_at", new Date().toISOString());
  };

  const canSubmit = termsAgreed && !busy;

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
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
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (password.length < 6)  { setError("Password must be at least 6 characters"); return; }
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
    else setInfo("Password reset link sent — check your inbox.");
    setBusy(false);
  };

  const handleGoogle = async () => {
    setBusy(true); setError("");
    saveTerms();
    const err = await signInWithGoogle();
    if (err) { setError(err); setBusy(false); }
  };

  const Disclaimer = () => (
    <div className="auth-disclaimer">
      <div className="auth-disclaimer-scroll">
        <p className="auth-disclaimer-heading">⚠️ Risk Disclaimer &amp; Terms of Use</p>

        <p className="auth-disclaimer-section">Market &amp; Platform Risk</p>
        <p>coinhintz provides market data, analytical tools, and AI-generated signals for <strong>informational and educational purposes only</strong>. Nothing on this platform constitutes financial, investment, legal, or tax advice of any kind.</p>
        <p><strong>Cryptocurrency trading involves substantial risk of loss.</strong> Digital asset markets are highly volatile and largely unregulated. You may lose some or all of your invested capital. Never invest money you cannot afford to lose.</p>
        <p>All AI predictions, signals, funding rate analyses, and market insights are generated algorithmically and are <strong>not guaranteed to be accurate, complete, or timely</strong>. Past performance does not guarantee future results.</p>
        <p>Market data may be delayed, incomplete, or inaccurate. coinhintz makes no representations regarding data accuracy and is not liable for errors or omissions.</p>
        <p><strong>You are solely responsible for any financial decisions you make.</strong> coinhintz bears no liability for any losses or damages arising from your use of this platform.</p>
        <p>This platform is for users of legal age who are legally permitted to engage with cryptocurrency services in their jurisdiction.</p>

        <p className="auth-disclaimer-section">Billing &amp; Subscription Policy</p>
        <p><strong>Subscriptions auto-renew</strong> monthly at the listed price until cancelled. By subscribing you authorise coinhintz to charge your payment method on a recurring basis.</p>
        <p><strong>No refunds.</strong> All payments are final and non-refundable. We do not issue partial or full refunds for any reason, including unused time, dissatisfaction, or accidental purchases.</p>
        <p><strong>Cancellation.</strong> You may cancel your subscription at any time. Cancellation takes effect at the end of your current billing period — you retain full access to your plan features until that date, after which your account reverts to the Free tier. No credit or refund is issued for the remaining unused days.</p>
        <p><strong>Plan upgrades</strong> take effect immediately. Only the prorated difference for the remaining billing period is charged; your renewal date does not change.</p>
        <p><strong>Plan downgrades</strong> are scheduled to take effect at the end of your current billing period. You keep your higher-tier access until then. No refund or credit is issued for the difference.</p>
        <p>coinhintz reserves the right to change pricing with reasonable notice. Continued use of the service after a price change constitutes acceptance of the new price.</p>
      </div>
      <label className="auth-terms-check">
        <input type="checkbox" checked={termsAgreed} onChange={e => setTermsAgreed(e.target.checked)} />
        <span>I have read and agree to the Risk Disclaimer, Terms of Use, and Billing Policy above</span>
      </label>
    </div>
  );

  return (
    <div className="auth-backdrop" ref={backdropRef} onClick={handleBackdrop}>
      <div className="auth-card">
        <button className="auth-close" onClick={onClose}>✕</button>

        <div className="auth-logo">
          <CoinHintzLogo variant="nav" />
        </div>

        {/* ── Magic link (default) ── */}
        {view === "magic" && (
          <>
            <h2 className="auth-title">Sign in or create account</h2>
            <p className="auth-sub">No password needed — we'll email you a magic link</p>

            {!alreadyAgreed && <Disclaimer />}

            <button className="auth-google" type="button" onClick={handleGoogle} disabled={!canSubmit}>
              {GOOGLE_ICON} Continue with Google
            </button>
            <div className="auth-divider"><span>or</span></div>
            <form className="auth-form" onSubmit={handleMagicLink}>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
              </label>
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" disabled={!canSubmit}>
                {busy ? "Sending…" : "Send Magic Link ✉"}
              </button>
            </form>
            <p className="auth-switch">
              Prefer a password?{" "}
              <button className="auth-link-btn" onClick={() => setView("login")}>Sign in with password</button>
            </p>
          </>
        )}

        {/* ── Sent confirmation ── */}
        {view === "sent" && (
          <div className="auth-sent">
            <div className="auth-sent-icon">✉️</div>
            <h2 className="auth-title">Check your inbox</h2>
            <p className="auth-sub">
              We sent a magic link to <strong>{email}</strong>.
              Click it to sign in instantly — no password needed.
            </p>
            <p className="auth-sent-hint">
              Don't see it? Check your spam folder or{" "}
              <button className="auth-link-btn" onClick={() => { setView("magic"); setError(""); }}>try again</button>
            </p>
            <button className="auth-close-btn" onClick={onClose}>Close</button>
          </div>
        )}

        {/* ── Password login ── */}
        {view === "login" && (
          <>
            <h2 className="auth-title">Sign in</h2>
            <p className="auth-sub">Welcome back</p>
            <button className="auth-google" type="button" onClick={handleGoogle} disabled={busy}>
              {GOOGLE_ICON} Continue with Google
            </button>
            <div className="auth-divider"><span>or</span></div>
            <form className="auth-form" onSubmit={handleLogin}>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">Password
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              <button type="button" className="auth-link-btn" onClick={() => setView("reset")}>Forgot password?</button>
              {error === "no_account" ? (
                <p className="auth-error">
                  No account found.{" "}
                  <button type="button" className="auth-link-btn" onClick={() => setView("signup")}>Sign up free →</button>
                </p>
              ) : error ? <p className="auth-error">{error}</p> : null}
              {info && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
            </form>
            <p className="auth-switch">
              <button className="auth-link-btn" onClick={() => setView("magic")}>← Use magic link instead</button>
              {" · "}
              <button className="auth-link-btn" onClick={() => setView("signup")}>Create account</button>
            </p>
          </>
        )}

        {/* ── Password signup ── */}
        {view === "signup" && (
          <>
            <h2 className="auth-title">Create account</h2>
            <p className="auth-sub">Start with a free plan — upgrade anytime</p>

            {!alreadyAgreed && <Disclaimer />}

            <button className="auth-google" type="button" onClick={handleGoogle} disabled={!canSubmit}>
              {GOOGLE_ICON} Continue with Google
            </button>
            <div className="auth-divider"><span>or</span></div>
            <form className="auth-form" onSubmit={handleSignup}>
              <label className="auth-label">Full name
                <input className="auth-input" type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
              </label>
              <label className="auth-label">Password
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                    {showPw ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              <label className="auth-label">Confirm password
                <div className="auth-input-wrap">
                  <input className="auth-input" type={showCfm ? "text" : "password"} value={confirm} onChange={e => setConfirm(e.target.value)} required />
                  <button type="button" className="auth-eye" onClick={() => setShowCfm(v => !v)} tabIndex={-1}>
                    {showCfm ? <EyeOn /> : <EyeOff />}
                  </button>
                </div>
              </label>
              {error === "sso_exists" ? (
                <p className="auth-error">
                  This email is linked to a Google account.{" "}
                  <button type="button" className="auth-link-btn" onClick={handleGoogle}>Sign in with Google →</button>
                </p>
              ) : error ? <p className="auth-error">{error}</p> : null}
              {info && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={!canSubmit}>{busy ? "Creating…" : "Create Account"}</button>
            </form>
            <p className="auth-switch">
              Prefer no password?{" "}
              <button className="auth-link-btn" onClick={() => setView("magic")}>Send magic link instead</button>
              {" · "}
              Already have an account?{" "}
              <button className="auth-link-btn" onClick={() => setView("login")}>Sign in</button>
            </p>
          </>
        )}

        {/* ── Password reset ── */}
        {view === "reset" && (
          <>
            <h2 className="auth-title">Reset password</h2>
            <p className="auth-sub">We'll send you a reset link</p>
            <form className="auth-form" onSubmit={handleReset}>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? "Sending…" : "Send Reset Link"}</button>
            </form>
            <p className="auth-switch">
              <button className="auth-link-btn" onClick={() => setView("login")}>← Back to sign in</button>
            </p>
          </>
        )}

      </div>
    </div>
  );
};
