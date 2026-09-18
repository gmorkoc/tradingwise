import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { Avatar } from "./Avatar";
import "../styles/AccountMenu.css";

interface Props {
  onOpenAuth: () => void;
  // Kept in the prop list even though this component no longer calls it
  // itself — ProfilePage (opened below) is what actually triggers upgrades
  // now, and callers still pass their own onOpenUpgrade through to it.
  onOpenUpgrade: () => void;
  onOpenProfile?: () => void;
  // News ticker (desktop web) wants a generic person icon when there's no
  // profile photo, instead of the letter-initial fallback used everywhere
  // else this component renders (nav drawer, mobile nav).
  iconFallback?: boolean;
}

// Used to be a dropdown (profile/upgrade/settings/sign-out) opened from the
// avatar — removed in favor of going straight to the Profile page, which
// already covers all of that (upgrade buttons, sign out, account settings/
// delete account) without a menu in between.
export const AccountMenu: React.FC<Props> = ({
  onOpenAuth,
  onOpenProfile,
  iconFallback,
}) => {
  const { t } = useTranslation();
  const { user, profile } = useAuth();

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

  return (
    <div className="acct-wrap">
      <button className="acct-avatar" onClick={onOpenProfile}>
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
        <span className="icon-strip-label">{firstName}</span>
      </button>
    </div>
  );
};
