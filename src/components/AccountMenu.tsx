import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { useAIQuota } from "../hooks/useAIQuota";
import { Avatar } from "./Avatar";
import "../styles/AccountMenu.css";

const TIER_META: Record<
  string,
  { text: string; bg: string; icon: string; label: string }
> = {
  free: {
    text: "#94a3b8",
    bg: "rgba(148,163,184,0.12)",
    icon: "◈",
    label: "Free",
  },
  pro: {
    text: "#38bdf8",
    bg: "rgba(56,189,248,0.12)",
    icon: "⬡",
    label: "Pro",
  },
  elite: {
    text: "#a78bfa",
    bg: "rgba(167,139,250,0.12)",
    icon: "✦",
    label: "Elite",
  },
};

interface Props {
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  onOpenProfile?: () => void;
  // Only wired/used when dropdown is true (desktop top bar) — the mobile
  // drawer already has its own separate Settings row, so its AccountMenu
  // call (no dropdown prop) never needs this.
  onOpenSettings?: () => void;
  // News ticker (desktop web) wants a generic person icon when there's no
  // profile photo, instead of the letter-initial fallback used everywhere
  // else this component renders (nav drawer, mobile nav).
  iconFallback?: boolean;
  // Desktop top bar (.top-nav-icons): clicking the avatar opens a Google-
  // account-style dropdown (profile/upgrade/settings/sign-out) instead of
  // going straight to the Profile page — replaces what used to be 3
  // separate icon buttons there. Mobile's icon-strip-acct usage leaves
  // this off and keeps going straight to Profile (unchanged) since the
  // drawer it's already inside has its own separate Settings/Sign out rows.
  dropdown?: boolean;
}

export const AccountMenu: React.FC<Props> = ({
  onOpenAuth,
  onOpenUpgrade,
  onOpenProfile,
  onOpenSettings,
  iconFallback,
  dropdown,
}) => {
  const { t } = useTranslation();
  const { user, profile, tier, signOut } = useAuth();
  const { used, limit, exceeded, isPaid } = useAIQuota();
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    if (!dropdown) {
      onOpenProfile?.();
      return;
    }
    if (avatarRef.current) {
      const r = avatarRef.current.getBoundingClientRect();
      const vh = window.innerHeight;
      const DROPDOWN_W = 240;
      const DROPDOWN_H = 280;

      let left = r.right - DROPDOWN_W;
      let top = r.bottom + 10;

      if (left < 8) left = 8;
      if (top + DROPDOWN_H > vh - 8) top = Math.max(8, vh - DROPDOWN_H - 8);

      setDropPos({ top, left });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!dropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        avatarRef.current &&
        !avatarRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdown]);

  if (!user) {
    return (
      <button className="acct-signin-btn" onClick={onOpenAuth}>
        {t("account.signin")}
      </button>
    );
  }

  const firstName = (() => {
    // Some signup flows default full_name to the raw email — never show
    // the full address (with domain) as the display name.
    if (profile?.full_name && !profile.full_name.includes("@")) {
      return profile.full_name.trim().split(/\s+/)[0];
    }
    return user.email?.split("@")[0] ?? "Account";
  })();
  const firstInitial = firstName[0].toUpperCase();

  const tm = TIER_META[tier] ?? TIER_META.free;
  const quotaPct = isPaid ? 100 : Math.min(100, (used / limit) * 100);

  return (
    <div className="acct-wrap">
      <button
        className={`acct-avatar${dropdown ? " acct-avatar--circle" : ""}`}
        ref={avatarRef}
        onClick={openMenu}
      >
        <span className="nav-icon-wrap">
          {iconFallback && !profile?.avatar_url ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          ) : (
            <Avatar url={profile?.avatar_url} fallback={firstInitial} className="acct-initial-icon" />
          )}
        </span>
        {!dropdown && <span className="icon-strip-label">{firstName}</span>}
      </button>

      {dropdown && open &&
        createPortal(
          <div
            className="acct-dropdown acct-dropdown--portal"
            ref={menuRef}
            style={{ top: dropPos.top, left: dropPos.left }}
          >
            {/* User info header */}
            <div className="acct-dd-header">
              <div className="acct-dd-name">
                {profile?.full_name || t("account.myAccount")}
              </div>
              <div className="acct-dd-email">{user.email}</div>
              <span
                className="acct-dd-tier-badge"
                style={{ color: tm.text, background: tm.bg }}
              >
                {t("account.tierPlan", { tier: tm.label })}
              </span>
            </div>

            <div className="acct-dd-divider" />

            {/* Profile item — tier icon + quota on the right */}
            <button
              className="acct-dd-item acct-dd-profile"
              onClick={() => {
                setOpen(false);
                onOpenProfile?.();
              }}
            >
              <span className="acct-dd-profile-left">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {t("account.profile")}
              </span>
              <span className="acct-dd-profile-right">
                <span
                  className="acct-dd-tier-chip"
                  style={{ color: tm.text, background: tm.bg }}
                >
                  {tm.icon} {tm.label}
                </span>
                <span
                  className={`acct-dd-quota-tag${exceeded ? " exceeded" : ""}`}
                >
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
              <button
                className="acct-dd-item acct-dd-item--upgrade"
                onClick={() => {
                  setOpen(false);
                  onOpenUpgrade();
                }}
              >
                <span>{t("account.upgradePlan")}</span>
              </button>
            )}

            <button
              className="acct-dd-item"
              onClick={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
            >
              <span>{t("account.accountSettings")}</span>
            </button>

            <div className="acct-dd-divider" />

            <button
              className="acct-dd-item acct-dd-item--danger"
              onClick={() => {
                setOpen(false);
                signOut();
              }}
            >
              {t("account.signout")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
};
