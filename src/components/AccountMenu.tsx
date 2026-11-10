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
  /** Theme row (Light / Dark / System) in the dropdown. */
  onSetTheme?: (t: "dark" | "light" | "system") => void;
}

// Languages the app ships (src/locales).
const LANGS = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "tr", label: "Türkçe" },
  { code: "it", label: "Italiano" },
];
const readThemeMode = (): "light" | "dark" | "system" => {
  try {
    const s = localStorage.getItem("theme");
    return s === "light" || s === "dark" ? s : "system";
  } catch { return "system"; }
};

export const AccountMenu: React.FC<Props> = ({
  onOpenAuth,
  onOpenUpgrade,
  onOpenProfile,
  onOpenSettings,
  iconFallback,
  dropdown,
  onSetTheme,
}) => {
  const { t, i18n } = useTranslation();
  const [langOpen, setLangOpen] = useState(false);
  const [themeMode, setThemeMode] = useState(readThemeMode);
  const pickTheme = (m: "light" | "dark" | "system") => {
    setThemeMode(m);
    onSetTheme?.(m);
  };
  const pickLang = (code: string) => {
    i18n.changeLanguage(code);
    try { localStorage.setItem("lang", code); } catch { /* ignore */ }
    setLangOpen(false);
  };
  const curLang = LANGS.find((l) => i18n.language?.startsWith(l.code)) ?? LANGS[0];
  const { user, profile, tier, signOut } = useAuth();
  const { used, limit, exceeded, isPaid } = useAIQuota();
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, arrowX: 0, arrowY: 0 });
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
      const DROPDOWN_W = 280;
      const DROPDOWN_H = 440;

      // Centred under the avatar, kept 8px inside the window; the pointer
      // (`arrowX`) aims at the avatar's centre wherever the menu lands.
      const vw = window.innerWidth;
      const cx = r.left + r.width / 2;
      let left = Math.round(cx - DROPDOWN_W / 2);
      let top = r.bottom + 12;

      left = Math.min(Math.max(8, left), vw - DROPDOWN_W - 8);
      if (top + DROPDOWN_H > vh - 8) top = Math.max(8, vh - DROPDOWN_H - 8);

      setDropPos({ top, left, arrowX: Math.round(cx), arrowY: top });
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
    // Desktop top bar: an icon button like its neighbours (person outline).
    if (dropdown) {
      return (
        <button
          type="button"
          className="mch-search-btn acct-signin-icon"
          onClick={onOpenAuth}
          aria-label={t("account.signin")}
          title={t("account.signin")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </button>
      );
    }
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
    return user.email?.split("@")[0] ?? t("accountMenu.account");
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
          <>
          {/* Pointer above the menu, aimed at the avatar (separate element —
              the menu itself scrolls, so a child arrow would be clipped). */}
          <span className="acct-dd-arrow" aria-hidden="true" style={{ top: dropPos.arrowY - 6, left: dropPos.arrowX - 6 }} />
          <div
            className="acct-dropdown acct-dropdown--portal"
            ref={menuRef}
            style={{ top: dropPos.top, left: dropPos.left }}
          >
            {/* User info header */}
            {/* Name + email — the email only once (some sign-ups save it as
                the name too). The plan shows on the Profile row below. */}
            <div className="acct-dd-header">
              {(() => {
                const name = profile?.full_name?.trim();
                const hasName = !!name && !name.includes("@") && name !== user.email;
                return (
                  <>
                    <div className="acct-dd-name">{hasName ? name : (user.email ?? t("account.myAccount"))}</div>
                    {hasName && user.email && <div className="acct-dd-email">{user.email}</div>}
                  </>
                );
              })()}
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
                  {tm.icon} {tm.label === "Free" ? t("accountMenu.free") : tm.label}
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

            {/* Preferences: Language · Currency · Theme */}
            <div className="acct-dd-pref">
              <button type="button" className="acct-dd-pref-row" onClick={() => setLangOpen((v) => !v)} aria-expanded={langOpen}>
                <span>{t("accountMenu.language")}</span>
                <span className="acct-dd-pref-val">
                  {curLang.label}
                  <svg className={`acct-dd-chev${langOpen ? " acct-dd-chev--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </span>
              </button>
              {langOpen && (
                <div className="acct-dd-langs" role="listbox" aria-label={t("accountMenu.language")}>
                  {LANGS.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      role="option"
                      aria-selected={l.code === curLang.code}
                      className={`acct-dd-lang${l.code === curLang.code ? " acct-dd-lang--on" : ""}`}
                      onClick={() => pickLang(l.code)}
                    >
                      {l.label}
                      {l.code === curLang.code && <span aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
              {/* Prices are in US dollars everywhere for now. */}
              <div className="acct-dd-pref-row acct-dd-pref-row--static" title={t("accountMenu.currencyTip")}>
                <span>{t("accountMenu.currency")}</span>
                <span className="acct-dd-pref-val">
                  <span className="acct-dd-usd" aria-hidden="true">$</span>
                  USD
                </span>
              </div>
              {onSetTheme && (
                <div className="acct-dd-pref-row acct-dd-pref-row--static">
                  <span>{t("accountMenu.theme")}</span>
                  <div className="acct-dd-seg" role="radiogroup" aria-label={t("accountMenu.theme")}>
                    {(["light", "dark", "system"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={themeMode === m}
                        className={`acct-dd-seg-btn${themeMode === m ? " acct-dd-seg-btn--on" : ""}`}
                        onClick={() => pickTheme(m)}
                      >
                        {t(`accountMenu.themes.${m}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

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
          </div>
          </>,
          document.body,
        )}
    </div>
  );
};
