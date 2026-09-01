import { useState, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import {
  supabase, saveAlertSound, saveNotificationPref, ALERT_SOUNDS, fetchAccountEvents, subscriptionProvider,
  type AlertSound, type AccountEvent, type NotificationPrefKey,
} from "../services/supabase";
import { playAlertSoundFile } from "../utils/alertSound";
import { redirectToBillingPortal } from "../services/stripeService";
import { isIAPAvailable, openManageSubscriptions } from "../services/revenuecat";
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
  free:  { tKey: "upgradeModal.plans.free.label",  color: "#94a3b8" },
  pro:   { tKey: "upgradeModal.plans.pro.label",   color: "#38bdf8" },
  elite: { tKey: "upgradeModal.plans.elite.label", color: "#a78bfa" },
};

const STATUS_CONFIG: Record<string, { tKey: string; color: string }> = {
  active:             { tKey: "profile.status.active",             color: "#4ade80" },
  past_due:           { tKey: "profile.status.past_due",           color: "#fb923c" },
  canceled:           { tKey: "profile.status.canceled",           color: "#f87171" },
  unpaid:             { tKey: "profile.status.unpaid",             color: "#f87171" },
  trialing:           { tKey: "profile.status.trialing",           color: "#38bdf8" },
  incomplete:         { tKey: "profile.status.incomplete",         color: "#94a3b8" },
  incomplete_expired: { tKey: "profile.status.incomplete_expired", color: "#f87171" },
};

type Tab = "overview" | "profile" | "security" | "notifications" | "activity" | "danger";

const NAV_ITEMS: { id: Tab; label: string; danger?: boolean }[] = [
  { id: "overview",      label: "Overview" },
  { id: "profile",       label: "Profile Info" },
  { id: "security",      label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "activity",      label: "Activity" },
  { id: "danger",        label: "Danger Zone", danger: true },
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "?";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const EVENT_TIER_RANK: Record<string, number> = { free: 0, pro: 1, elite: 2 };

function eventTierLabel(t: (k: string) => string, tier: string | null | undefined): string {
  if (!tier) return "";
  const conf = (TIER_CONFIG as Record<string, { tKey: string }>)[tier];
  return conf ? t(conf.tKey) : tier;
}

function eventIcon(ev: AccountEvent): string {
  switch (ev.type) {
    case "subscription_started": return "✦";
    case "tier_changed": {
      const up = (EVENT_TIER_RANK[ev.detail?.to] ?? 0) > (EVENT_TIER_RANK[ev.detail?.from] ?? 0);
      return up ? "⬆" : "⬇";
    }
    case "downgrade_scheduled":            return "⬇";
    case "subscription_cancel_scheduled":  return "⏳";
    case "subscription_reactivated":       return "↻";
    case "subscription_canceled":          return "⛔";
    case "payment_succeeded":              return "💳";
    case "payment_failed":                 return "⚠";
    default:                               return "•";
  }
}

function eventLabel(t: (k: string, opts?: Record<string, unknown>) => string, ev: AccountEvent): string {
  const d = ev.detail ?? {};
  switch (ev.type) {
    case "subscription_started":
      return t("profile.activity.subscriptionStarted", { tier: eventTierLabel(t, d.tier) });
    case "tier_changed":
      return t("profile.activity.tierChanged", { from: eventTierLabel(t, d.from), to: eventTierLabel(t, d.to) });
    case "downgrade_scheduled":
      return t("profile.activity.downgradeScheduled", { from: eventTierLabel(t, d.from), to: eventTierLabel(t, d.to) });
    case "subscription_cancel_scheduled":
      return t("profile.activity.subscriptionCancelScheduled");
    case "subscription_reactivated":
      return t("profile.activity.subscriptionReactivated");
    case "subscription_canceled":
      return t("profile.activity.subscriptionCanceled");
    case "payment_succeeded":
      return t("profile.activity.paymentSucceeded", { tier: eventTierLabel(t, d.tier) });
    case "payment_failed":
      return t("profile.activity.paymentFailed");
    default:
      return ev.type;
  }
}


export const ProfilePage: React.FC<ProfilePageProps> = ({ isOpen, onClose, onOpenUpgrade }) => {
  const { t } = useTranslation();
  const { user, profile: authProfile, tier, refreshProfile, session, signOut } = useAuth();
  const { used, limit, isPaid } = useAIQuota();

  // Stripe (web) and Apple IAP (iOS) are separate billing systems with no
  // visibility into each other — billing actions only work from the
  // platform that actually sold the subscription.
  const actualProvider = subscriptionProvider(authProfile, tier);
  const providerMismatch = isPaid && actualProvider !== null && (
    (actualProvider === "apple"  && !isIAPAvailable()) ||
    (actualProvider === "stripe" && isIAPAvailable())
  );

  const blankFromAuth = (): ProfileData => ({
    displayName: authProfile?.full_name || (user?.user_metadata?.full_name as string | undefined) || "",
    username: "",
    email: user?.email ?? "",
    bio: "",
  });

  const [tab, setTab] = useState<Tab>("overview");

  const [profile, setProfile] = useState<ProfileData>(blankFromAuth);
  const [draft,   setDraft]   = useState<ProfileData>(blankFromAuth);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");

  const [newPw,      setNewPw]      = useState("");
  const [confirmPw,  setConfirmPw]  = useState("");
  const [pwSaved,    setPwSaved]    = useState(false);
  const [pwError,    setPwError]    = useState("");
  const [showNew,    setShowNew]    = useState(false);
  const [showConfirm,setShowConfirm]= useState(false);

  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError,   setPortalError]   = useState("");

  const [deleteStep,    setDeleteStep]    = useState<"idle" | "confirm">("idle");
  const [deleteInput,   setDeleteInput]   = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError,   setDeleteError]   = useState("");

  const [events,        setEvents]        = useState<AccountEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Optimistic overrides for the notification toggles — refreshProfile()'s
  // round trip is otherwise the only thing that updates authProfile, so
  // without this the switch just sits unchanged (or visibly reverts) for
  // however long that request takes instead of flipping immediately on tap.
  // Cleared only once authProfile actually confirms the new value (see the
  // sync effect below), not right after the save call returns — WKWebView
  // can deliver a duplicate/ghost click shortly after a real tap, and since
  // the handler decides its next value from whatever's currently displayed,
  // clearing the override too early let that second phantom click read the
  // just-flipped value and immediately flip it right back.
  const [notifOverrides, setNotifOverrides] = useState<Partial<Record<NotificationPrefKey, boolean>>>({});
  const notifSavingRef = useRef<Partial<Record<NotificationPrefKey, boolean>>>({});

  const panelRef = useRef<HTMLDivElement>(null);

  // Full UI reset — only on a fresh open. This must NOT also depend on
  // authProfile/user: any background refreshProfile() call while the modal
  // is already open (saving an alert sound, flipping a notification toggle,
  // the Stripe-return poll, etc.) gives authProfile a new object reference,
  // and re-running this on every one of those bounced the user back to the
  // Overview tab mid-interaction — see the separate sync effect below for
  // keeping the form fields themselves up to date instead.
  useEffect(() => {
    if (!isOpen) return;
    setTab("overview");
    setProfileSaved(false); setProfileError("");
    setPwSaved(false); setPwError("");
    setNewPw(""); setConfirmPw("");
    setPortalError("");
    setDeleteStep("idle"); setDeleteInput(""); setDeleteError("");
  }, [isOpen]);

  // Keep the editable profile/draft fields synced with the latest server
  // profile — separate from the reset above so it doesn't touch tab/other
  // UI state on every refresh.
  useEffect(() => {
    if (!isOpen) return;
    const fresh = blankFromAuth();
    setProfile(fresh); setDraft(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authProfile, user]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || tab !== "activity" || !user) return;
    let cancelled = false;
    setEventsLoading(true);
    fetchAccountEvents(user.id).then((rows) => {
      if (!cancelled) { setEvents(rows); setEventsLoading(false); }
    });
    return () => { cancelled = true; };
  }, [isOpen, tab, user]);

  // Drop an override — and release the in-flight lock — only once
  // authProfile actually confirms it, never right after the save call
  // merely returns.
  useEffect(() => {
    setNotifOverrides(prev => {
      let changed = false;
      const next = { ...prev };
      (Object.keys(next) as NotificationPrefKey[]).forEach((key) => {
        if (authProfile?.[key] === next[key]) {
          delete next[key];
          notifSavingRef.current[key] = false;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [authProfile]);

  if (!isOpen) return null;

  const handleProfileSave = async () => {
    if (!draft.displayName.trim()) { setProfileError(t("profile.messages.displayNameRequired")); return; }
    if (!draft.email.trim()) { setProfileError(t("profile.messages.emailRequired")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) { setProfileError(t("profile.messages.invalidEmail")); return; }
    const updates: { email?: string; data?: { full_name: string } } = { data: { full_name: draft.displayName.trim() } };
    if (draft.email !== user?.email) updates.email = draft.email;
    const { error } = await supabase.auth.updateUser(updates);
    if (error) { setProfileError(error.message); return; }
    await refreshProfile();
    setProfile(draft); setProfileError("");
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handlePasswordChange = async () => {
    if (newPw.length < 6) { setPwError(t("profile.messages.passwordTooShort")); return; }
    if (newPw !== confirmPw) { setPwError(t("profile.messages.passwordMismatch")); return; }
    const { error } = await supabase.auth.updateUser({ password: newPw });
    if (error) { setPwError(error.message); return; }
    setPwError(""); setPwSaved(true);
    setNewPw(""); setConfirmPw("");
    setTimeout(() => setPwSaved(false), 2500);
  };

  const handleAlertSoundChange = async (sound: AlertSound) => {
    playAlertSoundFile(sound);
    if (user) { await saveAlertSound(user.id, sound); await refreshProfile(); }
  };

  const notifPrefValue = (key: NotificationPrefKey): boolean =>
    notifOverrides[key] ?? authProfile?.[key] ?? true;

  const handleNotifPrefChange = async (key: NotificationPrefKey, value: boolean) => {
    // A save for this key is already in flight and unconfirmed — ignore.
    // Without this, a WKWebView ghost/duplicate click firing while the
    // first save is still pending reads the already-flipped optimistic
    // value and immediately toggles it right back.
    if (notifSavingRef.current[key]) return;
    notifSavingRef.current[key] = true;
    setNotifOverrides(prev => ({ ...prev, [key]: value }));
    if (!user) { notifSavingRef.current[key] = false; return; }
    try {
      await saveNotificationPref(user.id, key, value);
      await refreshProfile();
    } catch {
      // Save failed — release the lock and drop the optimistic override so
      // the switch falls back to showing the real (unchanged) server value
      // instead of getting stuck forever on a value that never took effect.
      notifSavingRef.current[key] = false;
      setNotifOverrides(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleManageBilling = async () => {
    if (providerMismatch) return; // UI already blocks this — safety net only
    // Subscriptions bought via IAP have no Stripe customer at all — Apple
    // requires these be managed through the user's Apple ID, not our UI.
    if (isIAPAvailable()) { openManageSubscriptions(); return; }
    setPortalLoading(true); setPortalError("");
    try { await redirectToBillingPortal(); }
    catch (e: any) { setPortalError(e.message ?? t("upgradeModal.error")); setPortalLoading(false); }
  };

  const handleDeleteAccount = async () => {
    if (deleteInput !== "DELETE") return;
    setDeleteLoading(true); setDeleteError("");
    try {
      const token = session?.access_token;
      if (!token) throw new Error("Not authenticated");
      // The native app's WebView doesn't run from the coinhintz.io origin,
      // so a bare relative path resolves to nothing on-device — same fix
      // as coinglass.ts's BN_BASE.
      const apiBase = Capacitor.isNativePlatform() ? "https://www.coinhintz.io" : "";
      const res = await fetch(`${apiBase}/api/deleteAccount`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = "Failed to delete account";
        try { msg = JSON.parse(text).error ?? msg; } catch {}
        throw new Error(msg);
      }
      await signOut(); onClose();
    } catch (e: any) {
      setDeleteError(e.message ?? t("upgradeModal.error"));
      setDeleteLoading(false);
    }
  };

  const initials  = getInitials(profile.displayName || draft.displayName || "?");
  const isDirty   = JSON.stringify(draft) !== JSON.stringify(profile);
  const tierConf  = TIER_CONFIG[tier] ?? TIER_CONFIG.free;
  const tierLabel = t(tierConf.tKey);
  const subStatus = authProfile?.subscription_status ?? null;
  const statusConf = subStatus ? (STATUS_CONFIG[subStatus] ?? { tKey: "", color: "#94a3b8" }) : null;
  const renewsAt  = authProfile?.subscription_end_at ?? null;

  return (
    <div className="pp-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pp-modal" ref={panelRef}>

        {/* ── Header ─────────────────────────────────────── */}
        <div className="pp-header">
          <div className="pp-header-identity">
            <div className="pp-avatar"><span>{initials}</span></div>
            <div>
              <p className="pp-header-name">{profile.displayName || t("profile.actions.yourName")}</p>
              <p className="pp-header-email">{profile.email}</p>
            </div>
          </div>
          <button className="pp-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="pp-body">

          {/* Left nav */}
          <nav className="pp-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`pp-nav-item${tab === item.id ? " pp-nav-item--active" : ""}${item.danger ? " pp-nav-item--danger" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Right content */}
          <div className="pp-content">

            {/* ── Overview ─────────────────────────────── */}
            {tab === "overview" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title">Plan & Usage</h3>

                <div className="pp-stat-row">
                  <div className="pp-stat">
                    <span className="pp-stat-label">Current Plan</span>
                    <span className="pp-stat-value" style={{ color: tierConf.color }}>{tierLabel}</span>
                  </div>
                  {statusConf && (
                    <div className="pp-stat">
                      <span className="pp-stat-label">Status</span>
                      <span className="pp-stat-value" style={{ color: statusConf.color }}>
                        {statusConf.tKey ? t(statusConf.tKey) : subStatus}
                      </span>
                    </div>
                  )}
                  {isPaid && renewsAt && (
                    <div className="pp-stat">
                      <span className="pp-stat-label">{subStatus === "canceled" ? "Access until" : "Next billing"}</span>
                      <span className="pp-stat-value">{formatDate(renewsAt)}</span>
                    </div>
                  )}
                </div>

                <div className="pp-divider" />

                <h3 className="pp-pane-title">AI Usage</h3>
                {tier === "elite" ? (
                  <div className="pp-ai-unlimited">
                    <span>✦</span>
                    <span>{t("profile.aiUsage.unlimited")}</span>
                  </div>
                ) : tier === "free" ? (
                  <p className="pp-upgrade-hint">
                    {t("profile.aiUsage.locked")}{" "}
                    <button className="pp-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>{t("profile.aiUsage.upgradePro")}</button>
                    {t("profile.aiUsage.proHint")}
                  </p>
                ) : (
                  <>
                    <div className="pp-ai-row">
                      <span className="pp-ai-label"
                        dangerouslySetInnerHTML={{ __html: t("profile.aiUsage.requestsUsed", {
                          used: `<strong>${used}</strong>`, limit: `<strong>${limit}</strong>`,
                        }) }}
                      />
                      <span className="pp-ai-reset">{t("profile.aiUsage.resetsOn")}</span>
                    </div>
                    <div className="pp-ai-track">
                      <div className={`pp-ai-fill${used/limit >= 0.9 ? " pp-ai-fill--red" : used/limit >= 0.6 ? " pp-ai-fill--amber" : " pp-ai-fill--green"}`}
                        style={{ width: `${Math.min(100, (used/limit)*100)}%` }}
                      />
                    </div>
                    {isPaid && tier === "pro" && (
                      <p className="pp-upgrade-hint">
                        <button className="pp-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>{t("profile.aiUsage.upgradeElite")}</button>
                        {t("profile.aiUsage.eliteHint")}
                      </p>
                    )}
                  </>
                )}

                <div className="pp-divider" />

                {portalError && <p className="pp-msg pp-msg--error">{portalError}</p>}
                {isPaid && providerMismatch && (
                  <p className="pp-msg pp-msg--warning">
                    {actualProvider === "apple" ? t("upgradeModal.deviceMismatch.appleBody") : t("upgradeModal.deviceMismatch.webBody")}
                  </p>
                )}
                <div className="pp-actions">
                  {isPaid ? (
                    providerMismatch ? null : (
                      <button className="pp-btn pp-btn--ghost" onClick={handleManageBilling} disabled={portalLoading}>
                        {portalLoading
                          ? t("profile.subscription.loadingPortal")
                          : isIAPAvailable()
                          ? t("profile.subscription.manageAppleSubscription")
                          : t("profile.subscription.manageBilling")}
                      </button>
                    )
                  ) : (
                    <button className="pp-btn pp-btn--primary" onClick={() => { onClose(); onOpenUpgrade(); }}>
                      {t("profile.subscription.upgradePlan")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── Profile Info ──────────────────────────── */}
            {tab === "profile" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title">Profile Info</h3>

                <div className="pp-field-grid">
                  <div className="pp-field">
                    <label>{t("profile.info.displayName")}</label>
                    <input type="text" value={draft.displayName}
                      onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                      placeholder={t("profile.info.yourName")} />
                  </div>
                  <div className="pp-field">
                    <label>{t("profile.info.username")}</label>
                    <input type="text" value={draft.username}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value.replace(/\s/g, "") })}
                      placeholder={t("profile.info.yourUsername")} />
                  </div>
                  <div className="pp-field pp-field--full">
                    <label>{t("profile.info.email")}</label>
                    <input type="email" value={draft.email}
                      onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                      placeholder={t("profile.info.yourEmail")} />
                  </div>
                  <div className="pp-field pp-field--full">
                    <label>{t("profile.info.bio")}</label>
                    <textarea value={draft.bio}
                      onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                      placeholder={t("profile.info.yourBio")} rows={3} />
                  </div>
                </div>

                {profileError && <p className="pp-msg pp-msg--error">{profileError}</p>}
                {profileSaved && <p className="pp-msg pp-msg--success">{t("profile.messages.saved")}</p>}

                <div className="pp-actions">
                  <button className="pp-btn pp-btn--primary" onClick={handleProfileSave} disabled={!isDirty}>
                    {t("profile.actions.saveChanges")}
                  </button>
                  {isDirty && (
                    <button className="pp-btn pp-btn--ghost" onClick={() => { setDraft(profile); setProfileError(""); }}>
                      {t("profile.actions.discard")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── Security ──────────────────────────────── */}
            {tab === "security" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title">Change Password</h3>
                <p className="pp-pane-sub">{t("profile.security.sub")}</p>

                <div className="pp-field-grid">
                  <div className="pp-field">
                    <label>{t("profile.security.newPassword")}</label>
                    <div className="pp-pw-wrap">
                      <input type={showNew ? "text" : "password"} value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                        placeholder={t("profile.security.minChars")} autoComplete="new-password" />
                      <button className="pp-pw-eye" onClick={() => setShowNew(v => !v)}>{showNew ? "🙈" : "👁"}</button>
                    </div>
                  </div>
                  <div className="pp-field">
                    <label>{t("profile.security.confirmPassword")}</label>
                    <div className="pp-pw-wrap">
                      <input type={showConfirm ? "text" : "password"} value={confirmPw}
                        onChange={(e) => setConfirmPw(e.target.value)}
                        placeholder={t("profile.security.repeatPassword")} autoComplete="new-password" />
                      <button className="pp-pw-eye" onClick={() => setShowConfirm(v => !v)}>{showConfirm ? "🙈" : "👁"}</button>
                    </div>
                  </div>
                </div>

                {newPw && (
                  <div className="pp-pw-strength">
                    <div className={`pp-pw-bar${newPw.length >= 12 ? " strong" : newPw.length >= 8 ? " medium" : " weak"}`} />
                    <span>{newPw.length >= 12 ? t("profile.security.strength.strong") : newPw.length >= 8 ? t("profile.security.strength.medium") : t("profile.security.strength.weak")}</span>
                  </div>
                )}

                {pwError && <p className="pp-msg pp-msg--error">{pwError}</p>}
                {pwSaved && <p className="pp-msg pp-msg--success">{t("profile.messages.passwordUpdated")}</p>}

                <div className="pp-actions">
                  <button className="pp-btn pp-btn--primary" onClick={handlePasswordChange} disabled={!newPw || !confirmPw}>
                    {t("profile.security.changePassword")}
                  </button>
                </div>
              </div>
            )}

            {/* ── Notifications ─────────────────────────── */}
            {tab === "notifications" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title">{t("profile.notifications.title", "Notification Settings")}</h3>
                <p className="pp-pane-sub">{t("profile.notifications.sub", "Choose which push notifications you want to receive.")}</p>

                <div className="pp-notif-row">
                  <div>
                    <p className="pp-notif-label">{t("profile.notifications.dailyBrief.label", "Daily Market Brief")}</p>
                    <p className="pp-notif-desc">{t("profile.notifications.dailyBrief.desc", "A push when there's fresh market news in the daily brief.")}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={notifPrefValue("notify_daily_brief")}
                    className={`pp-switch${notifPrefValue("notify_daily_brief") ? " pp-switch--on" : ""}`}
                    onClick={() => handleNotifPrefChange("notify_daily_brief", !notifPrefValue("notify_daily_brief"))}>
                    <span className="pp-switch-thumb" />
                  </button>
                </div>

                <div className="pp-notif-row">
                  <div>
                    <p className="pp-notif-label">{t("profile.notifications.priceAlerts.label", "Price Alerts")}</p>
                    <p className="pp-notif-desc">{t("profile.notifications.priceAlerts.desc", "Big BTC market moves and any price alerts you set.")}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={notifPrefValue("notify_price_alerts")}
                    className={`pp-switch${notifPrefValue("notify_price_alerts") ? " pp-switch--on" : ""}`}
                    onClick={() => handleNotifPrefChange("notify_price_alerts", !notifPrefValue("notify_price_alerts"))}>
                    <span className="pp-switch-thumb" />
                  </button>
                </div>

                <div className="pp-notif-row">
                  <div>
                    <p className="pp-notif-label">{t("profile.notifications.upgradeReminders.label", "Upgrade Reminders")}</p>
                    <p className="pp-notif-desc">{t("profile.notifications.upgradeReminders.desc", "Occasional reminders about what Pro and Elite unlock.")}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={notifPrefValue("notify_upgrade_reminders")}
                    className={`pp-switch${notifPrefValue("notify_upgrade_reminders") ? " pp-switch--on" : ""}`}
                    onClick={() => handleNotifPrefChange("notify_upgrade_reminders", !notifPrefValue("notify_upgrade_reminders"))}>
                    <span className="pp-switch-thumb" />
                  </button>
                </div>

                <div className="pp-divider" />

                <h3 className="pp-pane-title">{t("profile.alertSound.title", "Alert Sound")}</h3>
                <p className="pp-upgrade-hint" style={{ marginBottom: 8 }}>
                  {t("profile.alertSound.hint", "Plays for price alerts — both in the app and in push notifications.")}
                </p>
                <div className="pp-stat-row">
                  {ALERT_SOUNDS.map((sound) => (
                    <button
                      key={sound}
                      className={`pp-btn${(authProfile?.alert_sound ?? "bell") === sound ? " pp-btn--primary" : " pp-btn--ghost"}`}
                      onClick={() => handleAlertSoundChange(sound)}
                    >
                      {(authProfile?.alert_sound ?? "bell") === sound ? "✓ " : ""}
                      {t(`profile.alertSound.${sound}`, sound.charAt(0).toUpperCase() + sound.slice(1))}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Activity ──────────────────────────────── */}
            {tab === "activity" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title">{t("profile.activity.title")}</h3>
                <p className="pp-pane-sub">{t("profile.activity.sub")}</p>

                <div className="pp-activity-list">
                  {eventsLoading && <p className="pp-upgrade-hint">{t("common.loading")}</p>}

                  {!eventsLoading && events.map((ev) => (
                    <div className="pp-activity-item" key={ev.id}>
                      <span className="pp-activity-icon">{eventIcon(ev)}</span>
                      <div className="pp-activity-body">
                        <span className="pp-activity-label">{eventLabel(t, ev)}</span>
                        <span className="pp-activity-date">{formatDate(ev.created_at)}</span>
                      </div>
                    </div>
                  ))}

                  {!eventsLoading && events.length === 0 && (
                    <p className="pp-upgrade-hint" style={{ marginBottom: 8 }}>{t("profile.activity.empty")}</p>
                  )}

                  <div className="pp-activity-item">
                    <span className="pp-activity-icon">🎉</span>
                    <div className="pp-activity-body">
                      <span className="pp-activity-label">{t("profile.activity.accountCreated")}</span>
                      <span className="pp-activity-date">{formatDate(user?.created_at ?? null)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Danger Zone ───────────────────────────── */}
            {tab === "danger" && (
              <div className="pp-pane">
                <h3 className="pp-pane-title pp-pane-title--danger">Danger Zone</h3>
                <p className="pp-pane-sub">{t("profile.deleteAccount.sub")}</p>

                <div className="pp-danger-card">
                  {deleteStep === "idle" ? (
                    <div className="pp-danger-row">
                      <div>
                        <p className="pp-danger-label">Delete Account</p>
                        <p className="pp-danger-desc">Permanently remove your account and all data.</p>
                      </div>
                      <button className="pp-btn pp-btn--danger"
                        onClick={() => { setDeleteStep("confirm"); setDeleteInput(""); setDeleteError(""); }}>
                        {t("profile.deleteAccount.button")}
                      </button>
                    </div>
                  ) : (
                    <div className="pp-delete-confirm">
                      <p className="pp-delete-warning">{t("profile.deleteAccount.warning")}</p>
                      <div className="pp-field" style={{ marginBottom: 14 }}>
                        <label>{t("profile.deleteAccount.typeToConfirm")}</label>
                        <input type="text" value={deleteInput}
                          onChange={(e) => setDeleteInput(e.target.value)}
                          placeholder="DELETE" autoFocus />
                      </div>
                      {deleteError && <p className="pp-msg pp-msg--error">{deleteError}</p>}
                      <div className="pp-actions">
                        <button className="pp-btn pp-btn--danger" onClick={handleDeleteAccount}
                          disabled={deleteInput !== "DELETE" || deleteLoading}>
                          {deleteLoading ? t("profile.deleteAccount.deleting") : t("profile.deleteAccount.confirmButton")}
                        </button>
                        <button className="pp-btn pp-btn--ghost"
                          onClick={() => { setDeleteStep("idle"); setDeleteInput(""); setDeleteError(""); }}
                          disabled={deleteLoading}>
                          {t("profile.actions.discard")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};
