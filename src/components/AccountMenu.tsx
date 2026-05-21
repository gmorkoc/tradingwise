import { useState, useRef, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/AccountMenu.css";

const TIER_META: Record<string, { text: string; bg: string; icon: string; label: string }> = {
  free:  { text: "#94a3b8", bg: "rgba(148,163,184,0.12)", icon: "◈", label: "Free"  },
  pro:   { text: "#38bdf8", bg: "rgba(56,189,248,0.12)",  icon: "⬡", label: "Pro"   },
  elite: { text: "#a78bfa", bg: "rgba(167,139,250,0.12)", icon: "✦", label: "Elite" },
};

interface Props {
  onOpenAuth:    () => void;
  onOpenUpgrade: () => void;
  onOpenProfile?: () => void;
}

export const AccountMenu: React.FC<Props> = ({ onOpenAuth, onOpenUpgrade, onOpenProfile }) => {
  const { user, profile, tier, signOut } = useAuth();
  const { used, limit, exceeded, isPaid } = useAIQuota();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (!user) {
    return (
      <button className="acct-signin-btn" onClick={onOpenAuth}>
        Sign In
      </button>
    );
  }

  const initials = (() => {
    if (profile?.full_name) {
      const parts = profile.full_name.trim().split(/\s+/);
      return parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : parts[0][0].toUpperCase();
    }
    return (user.email?.[0] ?? "U").toUpperCase();
  })();

  const tm = TIER_META[tier] ?? TIER_META.free;
  const quotaPct = isPaid ? 100 : Math.min(100, (used / limit) * 100);

  return (
    <div className="acct-wrap" ref={menuRef}>
      <button className="acct-avatar" onClick={() => setOpen(v => !v)}>
        <span className="acct-initials">{initials}</span>
      </button>

      {open && (
        <div className="acct-dropdown">
          {/* User info header */}
          <div className="acct-dd-header">
            <div className="acct-dd-name">{profile?.full_name || "My Account"}</div>
            <div className="acct-dd-email">{user.email}</div>
            <span className="acct-dd-tier-badge" style={{ color: tm.text, background: tm.bg }}>
              {tm.label} Plan
            </span>
          </div>

          <div className="acct-dd-divider" />

          {/* Profile item — tier icon + quota on the right */}
          <button
            className="acct-dd-item acct-dd-profile"
            onClick={() => { setOpen(false); onOpenProfile?.(); }}
          >
            <span className="acct-dd-profile-left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              Profile
            </span>
            <span className="acct-dd-profile-right">
              <span className="acct-dd-tier-chip" style={{ color: tm.text, background: tm.bg }}>
                {tm.icon} {tm.label}
              </span>
              <span className={`acct-dd-quota-tag${exceeded ? " exceeded" : ""}`}>
                {isPaid ? "∞" : `${used}/${limit}`}
              </span>
            </span>
          </button>

          {/* Quota bar (only for free) */}
          {!isPaid && (
            <div className="acct-dd-quota-bar-wrap">
              <div
                className={`acct-dd-quota-bar-fill${exceeded ? " exceeded" : ""}`}
                style={{ width: `${quotaPct}%` }}
              />
            </div>
          )}

          <div className="acct-dd-divider" />

          {tier !== "elite" && (
            <button className="acct-dd-item acct-dd-item--upgrade" onClick={() => { setOpen(false); onOpenUpgrade(); }}>
              <span>⚡ Upgrade Plan</span>
            </button>
          )}

          <button className="acct-dd-item" onClick={() => { setOpen(false); }}>
            <span>⚙ Account Settings</span>
          </button>

          <div className="acct-dd-divider" />

          <button className="acct-dd-item acct-dd-item--danger" onClick={() => { setOpen(false); signOut(); }}>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
};
