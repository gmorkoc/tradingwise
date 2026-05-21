import { useState, useRef, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import "../styles/AuthModal.css";

type View = "login" | "signup" | "reset";

interface Props {
  onClose: () => void;
  initialView?: View;
}

export const AuthModal: React.FC<Props> = ({ onClose, initialView = "login" }) => {
  const { signIn, signUp, resetPassword } = useAuth();
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
    if (password !== confirm) { setError("Passwords do not match"); return; }
    if (password.length < 6)  { setError("Password must be at least 6 characters"); return; }
    setBusy(true); setError("");
    const err = await signUp(email, password, name);
    if (err) setError(err);
    else setInfo("Check your email to confirm your account, then sign in.");
    setBusy(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const err = await resetPassword(email);
    if (err) setError(err);
    else setInfo("Password reset link sent — check your inbox.");
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
          <span className="auth-logo-text">TradingWise<span>.ai</span></span>
        </div>

        {view === "login" && (
          <>
            <h2 className="auth-title">Welcome back</h2>
            <p className="auth-sub">Sign in to your account</p>
            <form className="auth-form" onSubmit={handleLogin}>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">Password
                <input className="auth-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </label>
              <button type="button" className="auth-link-btn" onClick={() => setView("reset")}>Forgot password?</button>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
            </form>
            <p className="auth-switch">Don't have an account? <button className="auth-link-btn" onClick={() => setView("signup")}>Sign up free</button></p>
          </>
        )}

        {view === "signup" && (
          <>
            <h2 className="auth-title">Create account</h2>
            <p className="auth-sub">Start with a free plan — upgrade anytime</p>
            <form className="auth-form" onSubmit={handleSignup}>
              <label className="auth-label">Full name
                <input className="auth-input" type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
              </label>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
              </label>
              <label className="auth-label">Password
                <input className="auth-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </label>
              <label className="auth-label">Confirm password
                <input className="auth-input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? "Creating account…" : "Create Account"}</button>
            </form>
            <p className="auth-switch">Already have an account? <button className="auth-link-btn" onClick={() => setView("login")}>Sign in</button></p>
          </>
        )}

        {view === "reset" && (
          <>
            <h2 className="auth-title">Reset password</h2>
            <p className="auth-sub">We'll send a reset link to your email</p>
            <form className="auth-form" onSubmit={handleReset}>
              <label className="auth-label">Email
                <input className="auth-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </label>
              {error && <p className="auth-error">{error}</p>}
              {info  && <p className="auth-info">{info}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? "Sending…" : "Send Reset Link"}</button>
            </form>
            <p className="auth-switch"><button className="auth-link-btn" onClick={() => setView("login")}>← Back to sign in</button></p>
          </>
        )}

      </div>
    </div>
  );
};
