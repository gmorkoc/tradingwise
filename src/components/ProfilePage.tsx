import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { user, profile: authProfile, tier, refreshProfile, session, signOut } = useAuth();
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

  const [deleteStep,    setDeleteStep]    = useState<"idle" | "confirm">("idle");
  const [deleteInput,   setDeleteInput]   = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError,   setDeleteError]   = useState("");

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
    if (!draft.displayName.trim()) { setProfileError(t("profile.messages.displayNameRequired")); return; }
    if (!draft.email.trim()) { setProfileError(t("profile.messages.emailRequired")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) { setProfileError(t("profile.messages.invalidEmail")); return; }

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
    if (newPw.length < 6) { setPwError(t("profile.messages.passwordTooShort")); return; }
    if (newPw !== confirmPw) { setPwError(t("profile.messages.passwordMismatch")); return; }

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
      setPortalError(e.message ?? t("upgradeModal.error"));
      setPortalLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteInput !== "DELETE") return;
    setDeleteLoading(true);
    setDeleteError("");
    try {
      const token = session?.access_token;
      if (!token) throw new Error("Not authenticated");
      const res = await fetch("/api/delete-account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to delete account");
      }
      await signOut();
      onClose();
    } catch (e: any) {
      setDeleteError(e.message ?? t("upgradeModal.error"));
      setDeleteLoading(false);
    }
  };

  const initials   = getInitials(profile.displayName || draft.displayName || "?");
  const isDirty    = JSON.stringify(draft) !== JSON.stringify(profile);
  const tierConf   = TIER_CONFIG[tier] ?? TIER_CONFIG.free;
  const tierLabel  = t(tierConf.tKey);
  const subStatus  = authProfile?.subscription_status ?? null;
  const statusConf = subStatus ? (STATUS_CONFIG[subStatus] ?? { tKey: "", color: "#94a3b8", text: subStatus }) : null;
  const renewsAt   = authProfile?.subscription_end_at ?? null;

  return (
    <div className="profile-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="profile-modal" ref={panelRef}>

        {/* Header */}
        <div className="profile-modal-header">
          <span className="profile-modal-title">{t("profile.title")}</span>
          <button className="profile-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="profile-modal-body">

          {/* Avatar hero */}
          <div className="profile-hero">
            <div className="profile-avatar"><span>{initials}</span></div>
            <div className="profile-hero-text">
              <p className="profile-hero-name">{profile.displayName || t("profile.actions.yourName")}</p>
              <p className="profile-hero-sub">{profile.email || t("profile.actions.noEmail")}</p>
            </div>
            <span className="profile-tier-badge" style={{ color: tierConf.color, borderColor: tierConf.color }}>
              {tierLabel}
            </span>
          </div>

          {/* Subscription */}
          <section className="profile-section">
            <h4 className="profile-section-title">{t("profile.sections.subscription")}</h4>

            <div className="profile-sub-grid">
              <div className="profile-sub-item">
                <span className="profile-sub-label">{t("profile.subscription.currentPlan")}</span>
                <span className="profile-sub-value" style={{ color: tierConf.color }}>{tierLabel}</span>
              </div>

              {statusConf && (
                <div className="profile-sub-item">
                  <span className="profile-sub-label">{t("profile.subscription.status")}</span>
                  <span className="profile-sub-value" style={{ color: statusConf.color }}>{statusConf.tKey ? t(statusConf.tKey) : subStatus}</span>
                </div>
              )}

              {isPaid && renewsAt && (
                <div className="profile-sub-item">
                  <span className="profile-sub-label">
                    {subStatus === "canceled" ? t("profile.subscription.accessUntil") : t("profile.subscription.nextBilling")}
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
                  {portalLoading ? t("profile.subscription.loadingPortal") : t("profile.subscription.manageBilling")}
                </button>
              ) : (
                <button
                  className="profile-btn profile-btn--primary"
                  onClick={() => { onClose(); onOpenUpgrade(); }}
                >
                  {t("profile.subscription.upgradePlan")}
                </button>
              )}
            </div>
          </section>

          {/* AI Usage */}
          <section className="profile-section">
            <h4 className="profile-section-title">{t("profile.sections.aiUsage")}</h4>

            {tier === "elite" ? (
              <div className="profile-ai-unlimited">
                <span className="profile-ai-unlimited-icon">✦</span>
                <span>{t("profile.aiUsage.unlimited")}</span>
              </div>
            ) : (
              <>
                <div className="profile-ai-usage-row">
                  <span className="profile-ai-usage-label"
                    dangerouslySetInnerHTML={{ __html: t("profile.aiUsage.requestsUsed", {
                      used: `<strong>${used}</strong>`,
                      limit: `<strong>${limit}</strong>`,
                    }) }}
                  />
                  <span className="profile-ai-reset">{t("profile.aiUsage.resetsOn", { date: getNextMonday() })}</span>
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
                      {t("profile.aiUsage.upgradePro")}
                    </button>
                    {t("profile.aiUsage.proHint")}
                  </p>
                )}
                {isPaid && tier === "pro" && (
                  <p className="profile-ai-upgrade-hint">
                    <button className="profile-ai-upgrade-link" onClick={() => { onClose(); onOpenUpgrade(); }}>
                      {t("profile.aiUsage.upgradeElite")}
                    </button>
                    {t("profile.aiUsage.eliteHint")}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Profile Info */}
          <section className="profile-section">
            <h4 className="profile-section-title">{t("profile.sections.profileInfo")}</h4>

            <div className="profile-field-grid">
              <div className="profile-field">
                <label>{t("profile.info.displayName")}</label>
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  placeholder={t("profile.info.yourName")}
                />
              </div>

              <div className="profile-field">
                <label>{t("profile.info.username")}</label>
                <input
                  type="text"
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value.replace(/\s/g, "") })}
                  placeholder={t("profile.info.yourUsername")}
                />
              </div>

              <div className="profile-field profile-field--full">
                <label>{t("profile.info.email")}</label>
                <input
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  placeholder={t("profile.info.yourEmail")}
                />
              </div>

              <div className="profile-field profile-field--full">
                <label>{t("profile.info.bio")}</label>
                <textarea
                  value={draft.bio}
                  onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                  placeholder={t("profile.info.yourBio")}
                  rows={3}
                />
              </div>
            </div>

            {profileError && <p className="profile-msg profile-msg--error">{profileError}</p>}
            {profileSaved && <p className="profile-msg profile-msg--success">{t("profile.messages.saved")}</p>}

            <div className="profile-actions">
              <button
                className="profile-btn profile-btn--primary"
                onClick={handleProfileSave}
                disabled={!isDirty}
              >
                {t("profile.actions.saveChanges")}
              </button>
              {isDirty && (
                <button className="profile-btn profile-btn--ghost" onClick={() => { setDraft(profile); setProfileError(""); }}>
                  {t("profile.actions.discard")}
                </button>
              )}
            </div>
          </section>

          {/* Security */}
          <section className="profile-section">
            <h4 className="profile-section-title">{t("profile.sections.security")}</h4>
            <p className="profile-section-sub">{t("profile.security.sub")}</p>

            <div className="profile-field-grid">
              <div className="profile-field">
                <label>{t("profile.security.newPassword")}</label>
                <div className="profile-pw-wrap">
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder={t("profile.security.minChars")}
                    autoComplete="new-password"
                  />
                  <button className="profile-pw-eye" onClick={() => setShowNew((v) => !v)}>
                    {showNew ? "🙈" : "👁"}
                  </button>
                </div>
              </div>

              <div className="profile-field">
                <label>{t("profile.security.confirmPassword")}</label>
                <div className="profile-pw-wrap">
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    placeholder={t("profile.security.repeatPassword")}
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
                <span>{newPw.length >= 12 ? t("profile.security.strength.strong") : newPw.length >= 8 ? t("profile.security.strength.medium") : t("profile.security.strength.weak")}</span>
              </div>
            )}

            {pwError && <p className="profile-msg profile-msg--error">{pwError}</p>}
            {pwSaved && <p className="profile-msg profile-msg--success">{t("profile.messages.passwordUpdated")}</p>}

            <div className="profile-actions">
              <button
                className="profile-btn profile-btn--primary"
                onClick={handlePasswordChange}
                disabled={!newPw || !confirmPw}
              >
                {t("profile.security.changePassword")}
              </button>
            </div>
          </section>

          {/* Danger Zone */}
          <section className="profile-section profile-section--danger">
            <h4 className="profile-section-title profile-section-title--danger">{t("profile.sections.dangerZone")}</h4>
            <p className="profile-section-sub">{t("profile.deleteAccount.sub")}</p>

            {deleteStep === "idle" ? (
              <button
                className="profile-btn profile-btn--danger"
                onClick={() => { setDeleteStep("confirm"); setDeleteInput(""); setDeleteError(""); }}
              >
                {t("profile.deleteAccount.button")}
              </button>
            ) : (
              <div className="profile-delete-confirm">
                <p className="profile-delete-warning">{t("profile.deleteAccount.warning")}</p>
                <div className="profile-field" style={{ marginBottom: 12 }}>
                  <label>{t("profile.deleteAccount.typeToConfirm")}</label>
                  <input
                    type="text"
                    value={deleteInput}
                    onChange={(e) => setDeleteInput(e.target.value)}
                    placeholder="DELETE"
                    autoFocus
                  />
                </div>
                {deleteError && <p className="profile-msg profile-msg--error">{deleteError}</p>}
                <div className="profile-actions">
                  <button
                    className="profile-btn profile-btn--danger"
                    onClick={handleDeleteAccount}
                    disabled={deleteInput !== "DELETE" || deleteLoading}
                  >
                    {deleteLoading ? t("profile.deleteAccount.deleting") : t("profile.deleteAccount.confirmButton")}
                  </button>
                  <button
                    className="profile-btn profile-btn--ghost"
                    onClick={() => { setDeleteStep("idle"); setDeleteInput(""); setDeleteError(""); }}
                    disabled={deleteLoading}
                  >
                    {t("profile.actions.discard")}
                  </button>
                </div>
              </div>
            )}
          </section>

        </div>
      </div>
    </div>
  );
};
