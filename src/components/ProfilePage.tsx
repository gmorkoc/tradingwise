import { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
import { redirectToBillingPortal } from "../services/stripeService";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/ProfilePage.css";

interface ProfilePageProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenUpgrade: () => void;
}

interface ProfileData {
  displayName: string;
  username: string;
  email: string;
  bio: string;
}

const TIER_CONFIG = {
  free:  { label: "Free",  color: "#94a3b8" },
  pro:   { label: "Pro",   color: "#38bdf8" },
  elite: { label: "Elite", color: "#a78bfa" },
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  active:            { text: "Active",       color: "#4ade80" },
  past_due:          { text: "Past due",     color: "#fb923c" },
  canceled:          { text: "Canceled",     color: "#f87171" },
  unpaid:            { text: "Unpaid",       color: "#f87171" },
  trialing:          { text: "Trial",        color: "#38bdf8" },
  incomplete:        { text: "Incomplete",   color: "#94a3b8" },
  incomplete_expired:{ text: "Expired",      color: "#f87171" },
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "?";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function getNextMonday(): string {
  const now  = new Date();
  const day  = now.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + diff);
  return next.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const ProfilePage: React.FC<ProfilePageProps> = ({ isOpen, onClose, onOpenUpgrade }) => {
  const { user, profile: authProfile, tier, refreshProfile } = useAuth();
  const { used, limit, isPaid } = useAIQuota();

  const blankFromAuth = (): ProfileData => ({
    displayName: authProfile?.full_name
      || (user?.user_metadata?.full_name as string | undefined)
      || "",
    username: "",
    email:    user?.email ?? "",
    bio:      "",
  });

  const [profile, setProfile] = useState<ProfileData>(blankFromAuth);
  const [draft, setDraft]     = useState<ProfileData>(blankFromAuth);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");

  const [newPw, setNewPw]         = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaved, setPwSaved]     = useState(false);
  const [pwError, setPwError]     = useState("");
  const [showNew, setShowNew]     = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError]     = useState("");

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const fresh = blankFromAuth();
    setProfile(fresh);
    setDraft(fresh);
    setProfileSaved(false);
    setProfileError("");
    setPwSaved(false);
    setPwError("");
    setNewPw(""); setConfirmPw("");
    setPortalError("");
  }, [isOpen, authProfile, user]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleProfileSave = async () => {
    if (!draft.displayName.trim()) { setProfileError("Display name is required."); return; }
    if (!draft.email.trim()) { setProfileError("Email is required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) { setProfileError("Enter a valid email address."); return; }

    const updates: { email?: string; data?: { full_name: string } } = {
      data: { full_name: draft.displayName.trim() },
    };
    if (draft.email !== user?.email) updates.email = draft.email;

    const { error } = await supabase.auth.updateUser(updates);
    if (error) { setProfileError(error.message); return; }

    await refreshProfile();
    setProfile(draft);
    setProfileError("");
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handlePasswordChange = async () => {
    if (newPw.length < 6) { setPwError("New password must be at least 6 characters."); return; }
    if (newPw !== confirmPw) { setPwError("Passwords do not match."); return; }

    const { error } = await supabase.auth.updateUser({ password: newPw });
    if (error) { setPwError(error.message); return; }

    setPwError("");
    setPwSaved(true);
    setNewPw(""); setConfirmPw("");
    setTimeout(() => setPwSaved(false), 2500);
  };

  const handleManageBilling = async () => {
    setPortalLoading(true);
    setPortalError("");
    try {
      await redirectToBillingPortal();
    } catch (e: any) {
      setPortalError(e.message ?? "Could not open billing portal");
      setPortalLoading(false);
    }
  };

  const initials   = getInitials(profile.displayName || draft.displayName || "?");
  const isDirty    = JSON.stringify(draft) !== JSON.stringify(profile);
  const tierConf   = TIER_CONFIG[tier] ?? TIER_CONFIG.free;
  const subStatus  = authProfile?.subscription_status ?? null;
  const statusConf = subStatus ? (STATUS_LABEL[subStatus] ?? { text: subStatus, color: "#94a3b8" }) : null;
  const renewsAt   = authProfile?.subscription_end_at ?? null;

  return (
    <div className="profile-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="profile-modal" ref={panelRef}>

        {/* Header */}
        <div className="profile-modal-header">
          <span className="profile-modal-title">Profile</span>
          <button className="profile-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="profile-modal-body">

          {/* Avatar hero */}
          <div className="profile-hero">
            <div className="profile-avatar"><span>{initials}</span></div>
            <div className="profile-hero-text">
              <p className="profile-hero-name">{profile.displayName || "Your Name"}</p>
              <p className="profile-hero-sub">{profile.email || "no email set"}</p>
            </div>
            <span className="profile-tier-badge" style={{ color: tierConf.color, borderColor: tierConf.color }}>
              {tierConf.label}
            </span>
          </div>

          {/* Subscription */}
          <section className="profile-section">
            <h4 className="profile-section-title">Subscription</h4>

            <div className="profile-sub-grid">
              <div className="profile-sub-item">
                <span className="profile-sub-label">Current plan</span>
                <span className="profile-sub-value" style={{ color: tierConf.color }}>{tierConf.label}</span>
              </div>

              {statusConf && (
                <div className="profile-sub-item">
                  <span className="profile-sub-label">Status</span>
                  <span className="profile-sub-value" style={{ color: statusConf.color }}>{statusConf.text}</span>
                </div>
              )}

              {isPaid && renewsAt && (
                <div className="profile-sub-item">
                  <span className="profile-sub-label">
                    {subStatus === "canceled" ? "Access until" : "Next billing"}
                  </span>
                  <span className="profile-sub-value">{formatDate(renewsAt)}</span>
                </div>
              )}
            </div>

            {portalError && <p className="profile-msg profile-msg--error">{portalError}</p>}

            <div className="profile-actions" style={{ marginTop: 14 }}>
              {isPaid ? (
                <button
                  className="profile-btn profile-btn--ghost"
                  onClick={handleManageBilling}
                  disabled={portalLoading}
                >
                  {portalLoading ? "Loading…" : "Manage billing / Cancel"}
                </button>
              ) : (
                <button
                  className="profile-btn profile-btn--primary"
                  onClick={() => { onClose(); onOpenUpgrade(); }}
                >
                  ⚡ Upgrade Plan
                </button>
              )}
            </div>
          </section>

          {/* AI Usage */}
          <section className="profile-section">
            <h4 className="profile-section-title">AI Usage</h4>

            {tier === "elite" ? (
              <div className="profile-ai-unlimited">
                <span className="profile-ai-unlimited-icon">✦</span>
                <span>Unlimited AI requests</span>
              </div>
            ) : (
              <>
                <div className="profile-ai-usage-row">
                  <span className="profile-ai-usage-label">
                    <strong>{used}</strong> of <strong>{limit}</strong> requests used this week
                  </span>
                  <span className="profile-ai-reset">Resets {getNextMonday()}</span>
                </div>
                <div className="profile-ai-bar-track">
                  <div
                    className={`profile-ai-bar-fill ${
                      used / limit >= 0.9 ? "profile-ai-bar-fill--red"
                      : used / limit >= 0.6 ? "profile-ai-bar-fill--amber"
                      : "profile-ai-bar-fill--green"
                    }`}
                    style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
                  />
                </div>
                {!isPaid && (
                  <p className="profile-ai-upgrade-hint">
                    <button className="profile-ai-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>
                      Upgrade to Pro
                    </button>
                    {" "}for 50 requests/week, or Elite for unlimited.
                  </p>
                )}
                {isPaid && tier === "pro" && (
                  <p className="profile-ai-upgrade-hint">
                    <button className="profile-ai-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>
                      Upgrade to Elite
                    </button>
                    {" "}for unlimited AI requests.
                  </p>
                )}
              </>
            )}
          </section>

          {/* Profile Info */}
          <section className="profile-section">
            <h4 className="profile-section-title">Profile Info</h4>

            <div className="profile-field-grid">
              <div className="profile-field">
                <label>Display Name</label>
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  placeholder="Your full name"
                />
              </div>

              <div className="profile-field">
                <label>Username</label>
                <input
                  type="text"
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value.replace(/\s/g, "") })}
                  placeholder="@username"
                />
              </div>

              <div className="profile-field profile-field--full">
                <label>Email</label>
                <input
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  placeholder="you@example.com"
                />
              </div>

              <div className="profile-field profile-field--full">
                <label>Bio</label>
                <textarea
                  value={draft.bio}
                  onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                  placeholder="A short bio…"
                  rows={3}
                />
              </div>
            </div>

            {profileError && <p className="profile-msg profile-msg--error">{profileError}</p>}
            {profileSaved && <p className="profile-msg profile-msg--success">✓ Profile saved</p>}

            <div className="profile-actions">
              <button
                className="profile-btn profile-btn--primary"
                onClick={handleProfileSave}
                disabled={!isDirty}
              >
                Save Changes
              </button>
              {isDirty && (
                <button className="profile-btn profile-btn--ghost" onClick={() => { setDraft(profile); setProfileError(""); }}>
                  Discard
                </button>
              )}
            </div>
          </section>

          {/* Security */}
          <section className="profile-section">
            <h4 className="profile-section-title">Security</h4>
            <p className="profile-section-sub">Set a new password for your account.</p>

            <div className="profile-field-grid">
              <div className="profile-field">
                <label>New Password</label>
                <div className="profile-pw-wrap">
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="Min. 6 characters"
                    autoComplete="new-password"
                  />
                  <button className="profile-pw-eye" onClick={() => setShowNew((v) => !v)}>
                    {showNew ? "🙈" : "👁"}
                  </button>
                </div>
              </div>

              <div className="profile-field">
                <label>Confirm New Password</label>
                <div className="profile-pw-wrap">
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    placeholder="Repeat new password"
                    autoComplete="new-password"
                  />
                  <button className="profile-pw-eye" onClick={() => setShowConfirm((v) => !v)}>
                    {showConfirm ? "🙈" : "👁"}
                  </button>
                </div>
              </div>
            </div>

            {newPw && (
              <div className="profile-pw-strength">
                <div className={`profile-pw-bar ${newPw.length >= 12 ? "strong" : newPw.length >= 8 ? "medium" : "weak"}`} />
                <span>{newPw.length >= 12 ? "Strong" : newPw.length >= 8 ? "Medium" : "Weak"}</span>
              </div>
            )}

            {pwError && <p className="profile-msg profile-msg--error">{pwError}</p>}
            {pwSaved && <p className="profile-msg profile-msg--success">✓ Password updated</p>}

            <div className="profile-actions">
              <button
                className="profile-btn profile-btn--primary"
                onClick={handlePasswordChange}
                disabled={!newPw || !confirmPw}
              >
                Change Password
              </button>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};
