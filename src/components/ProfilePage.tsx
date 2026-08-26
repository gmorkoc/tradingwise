import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
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

type Tab = "overview" | "profile" | "security" | "danger";

const NAV_ITEMS: { id: Tab; label: string; danger?: boolean }[] = [
  { id: "overview",  label: "Overview" },
  { id: "profile",   label: "Profile Info" },
  { id: "security",  label: "Security" },
  { id: "danger",    label: "Danger Zone", danger: true },
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


export const ProfilePage: React.FC<ProfilePageProps> = ({ isOpen, onClose, onOpenUpgrade }) => {
  const { t } = useTranslation();
  const { user, profile: authProfile, tier, refreshProfile, session, signOut } = useAuth();
  const { used, limit, isPaid } = useAIQuota();

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

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const fresh = blankFromAuth();
    setProfile(fresh); setDraft(fresh);
    setTab("overview");
    setProfileSaved(false); setProfileError("");
    setPwSaved(false); setPwError("");
    setNewPw(""); setConfirmPw("");
    setPortalError("");
    setDeleteStep("idle"); setDeleteInput(""); setDeleteError("");
  }, [isOpen, authProfile, user]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

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

  const handleManageBilling = async () => {
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
      const res = await fetch("/api/deleteAccount", {
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
                    {!isPaid && (
                      <p className="pp-upgrade-hint">
                        <button className="pp-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>{t("profile.aiUsage.upgradePro")}</button>
                        {t("profile.aiUsage.proHint")}
                      </p>
                    )}
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
                <div className="pp-actions">
                  {isPaid ? (
                    <button className="pp-btn pp-btn--ghost" onClick={handleManageBilling} disabled={portalLoading}>
                      {portalLoading
                        ? t("profile.subscription.loadingPortal")
                        : isIAPAvailable()
                        ? t("profile.subscription.manageAppleSubscription")
                        : t("profile.subscription.manageBilling")}
                    </button>
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
