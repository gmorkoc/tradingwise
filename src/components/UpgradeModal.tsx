import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import {
  redirectToCheckout,
  redirectToBillingPortal,
  previewUpgrade,
  upgradePlan,
  cancelSubscription,
  PRICE_IDS,
} from "../services/stripeService";
import { TIER_RANK } from "../services/supabase";
import "../styles/UpgradeModal.css";

interface Props {
  onClose:    () => void;
  onOpenAuth: () => void;
}

type FlowKind = "upgrade" | "downgrade" | "cancel";

interface ConfirmState {
  kind:         FlowKind;
  planId:       string;
  planLabel:    string;
  priceId?:     string;
  color:        string;
  amountDue?:   number;
  currency?:    string;
  scheduledAt?: string;
  lostFeatures: string[];
}

const PLANS = [
  {
    id:    "free",
    price: "$0",
    color: "#94a3b8",
  },
  {
    id:      "pro",
    price:   "$30.99",
    per:     "/mo",
    color:   "#38bdf8",
    popular: true,
    priceId: () => PRICE_IDS.pro,
  },
  {
    id:    "elite",
    price: "$59.99",
    per:   "/mo",
    color: "#a78bfa",
    priceId: () => PRICE_IDS.elite,
  },
];

// Feature locale keys exclusive to each tier (used for "you'll lose" confirmation list)
const EXCLUSIVE_FEATURE_KEYS: Record<string, string[]> = {
  elite: ["upgradeModal.lf.elitePro", "upgradeModal.lf.gann", "upgradeModal.lf.coinbase", "upgradeModal.lf.earlyAccess"],
  pro:   ["upgradeModal.lf.aiMkt", "upgradeModal.lf.onchain", "upgradeModal.lf.predChart", "upgradeModal.lf.liqHeatmap", "upgradeModal.lf.aiReqs"],
};

function lostFeaturesFor(currentTier: string, targetTier: string): string[] {
  const currentRank = TIER_RANK[currentTier as keyof typeof TIER_RANK] ?? 0;
  const targetRank  = TIER_RANK[targetTier  as keyof typeof TIER_RANK] ?? 0;
  if (targetRank >= currentRank) return [];
  const lost: string[] = [];
  if (currentRank >= 2 && targetRank < 2) lost.push(...EXCLUSIVE_FEATURE_KEYS.elite);
  if (currentRank >= 1 && targetRank < 1) lost.push(...EXCLUSIVE_FEATURE_KEYS.pro);
  return lost;
}

function formatAmount(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export const UpgradeModal: React.FC<Props> = ({ onClose, onOpenAuth }) => {
  const { t } = useTranslation();
  const { user, tier } = useAuth();
  const [loading,    setLoading]    = useState<string | null>(null);
  const [error,      setError]      = useState("");
  const [confirm,    setConfirm]    = useState<ConfirmState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done,       setDone]       = useState<{ message: string; sub: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (done)    { onClose(); return; }
      if (confirm) { setConfirm(null); return; }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirm, done]);

  const isPaid     = tier === "pro" || tier === "elite";
  const currentRank = TIER_RANK[tier as keyof typeof TIER_RANK] ?? 0;

  const handlePlanClick = async (plan: typeof PLANS[number]) => {
    if (!user) { onClose(); onOpenAuth(); return; }
    setError("");

    const planLabel  = t(`upgradeModal.plans.${plan.id}.label`);
    const planRank   = TIER_RANK[plan.id as keyof typeof TIER_RANK] ?? 0;
    const kind: FlowKind =
      plan.id === "free"       ? "cancel"
      : planRank > currentRank ? "upgrade"
      :                          "downgrade";

    // Cancel flow — no preview needed, show static confirmation
    if (kind === "cancel") {
      setConfirm({
        kind, planId: "free", planLabel: t("upgradeModal.plans.free.label"), color: "#94a3b8",
        lostFeatures: lostFeaturesFor(tier, "free"),
      });
      return;
    }

    const priceId = plan.priceId?.();
    if (!priceId) return;

    // New subscriber → straight to Stripe Checkout
    if (!isPaid) {
      setLoading(plan.id);
      try { await redirectToCheckout(priceId); }
      catch (e: any) { setError(e.message ?? t("upgradeModal.error")); setLoading(null); }
      return;
    }

    // Existing subscriber → fetch proration preview first
    setLoading(plan.id);
    try {
      const { amountDue, currency, scheduledAt } = await previewUpgrade(priceId);
      setConfirm({
        kind, planId: plan.id, planLabel, priceId, color: plan.color,
        amountDue, currency, scheduledAt,
        lostFeatures: lostFeaturesFor(tier, plan.id),
      });
    } catch (e: any) {
      setError(e.message ?? t("upgradeModal.error"));
    } finally {
      setLoading(null);
    }
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    setConfirming(true);
    setError("");

    try {
      if (confirm.kind === "cancel") {
        const { accessUntil } = await cancelSubscription();
        setDone({
          message: t("upgradeModal.success.cancelMessage"),
          sub:     t("upgradeModal.success.cancelSub", {
            plan: tier === "elite" ? t("upgradeModal.plans.elite.label") : t("upgradeModal.plans.pro.label"),
            date: formatDate(accessUntil),
          }),
        });
      } else {
        const { isUpgrade, scheduledAt } = await upgradePlan(confirm.priceId!);
        if (isUpgrade) {
          setDone({
            message: t("upgradeModal.success.upgradeMessage", { plan: confirm.planLabel }),
            sub:     t("upgradeModal.success.upgradeSub"),
          });
        } else {
          setDone({
            message: t("upgradeModal.success.downgradeMessage", { plan: confirm.planLabel }),
            sub:     t("upgradeModal.success.downgradeSub", {
              date:    formatDate(scheduledAt!),
              newPlan: confirm.planLabel,
            }),
          });
        }
      }
    } catch (e: any) {
      setError(e.message ?? t("upgradeModal.error"));
      setConfirming(false);
    }
  };

  const handleManageBilling = async () => {
    setLoading("portal");
    setError("");
    try { await redirectToBillingPortal(); }
    catch (e: any) { setError(e.message ?? t("upgradeModal.error")); setLoading(null); }
  };

  const backdropClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (done)    { onClose(); return; }
    if (confirm) { setConfirm(null); return; }
    onClose();
  };

  const closeOrBack = () => {
    if (done)    { onClose(); return; }
    if (confirm) { setConfirm(null); return; }
    onClose();
  };

  return (
    <div className="upgrade-backdrop" onClick={backdropClick}>
      <div className="upgrade-card">
        <button className="upgrade-close" onClick={closeOrBack}>
          {(confirm || done) ? "←" : "✕"}
        </button>

        {/* ── Success screen ── */}
        {done ? (
          <div className="upgrade-confirm">
            <div className="upgrade-confirm-icon" style={{ color: "#4ade80", fontSize: "2.8rem" }}>✓</div>
            <h2 className="upgrade-title">{done.message}</h2>
            <p className="upgrade-sub">{done.sub}</p>
            <button className="upgrade-plan-cta" style={{ background: "#4ade80", maxWidth: 260, marginTop: 16 }} onClick={onClose}>
              {t("upgradeModal.success.done")}
            </button>
          </div>
        ) : confirm ? (
          /* ── Confirmation screen ── */
          <div className="upgrade-confirm">
            {/* Direction icon */}
            <div className="upgrade-confirm-icon" style={{ color: confirm.color }}>
              {confirm.kind === "cancel"    ? "⊘"
               : confirm.kind === "upgrade" ? "↑"
               :                             "↓"}
            </div>

            <h2 className="upgrade-title">
              {confirm.kind === "cancel"
                ? t("upgradeModal.confirm.cancelTitle", { plan: tier === "elite" ? t("upgradeModal.plans.elite.label") : t("upgradeModal.plans.pro.label") })
                : confirm.kind === "upgrade"
                ? t("upgradeModal.confirm.upgradeTitle", { plan: confirm.planLabel })
                : t("upgradeModal.confirm.downgradeTitle", { plan: confirm.planLabel })}
            </h2>

            {/* What happens */}
            {confirm.kind === "cancel" && (
              <p className="upgrade-sub">{t("upgradeModal.confirm.cancelBody")}</p>
            )}
            {confirm.kind === "upgrade" && confirm.amountDue !== undefined && (
              <p className="upgrade-sub"
                dangerouslySetInnerHTML={{ __html: t("upgradeModal.confirm.upgradeBody", {
                  amount: `<strong>${formatAmount(confirm.amountDue, confirm.currency!)}</strong>`,
                }) }}
              />
            )}
            {confirm.kind === "downgrade" && (
              <p className="upgrade-sub"
                dangerouslySetInnerHTML={{ __html:
                  t("upgradeModal.confirm.downgradeBodyScheduled", {
                    date: `<strong>${formatDate(confirm.scheduledAt!)}</strong>`,
                    newPlan: confirm.planLabel,
                  })
                }}
              />
            )}

            {/* Features you'll lose */}
            {confirm.lostFeatures.length > 0 && (
              <div className="upgrade-lost-features">
                <div className="upgrade-lost-label">{t("upgradeModal.confirm.lostFeaturesLabel")}</div>
                <ul className="upgrade-lost-list">
                  {confirm.lostFeatures.map(f => (
                    <li key={f}><span className="upgrade-lost-x">✕</span>{t(f)}</li>
                  ))}
                </ul>
              </div>
            )}

            {confirm.kind === "upgrade" && (
              <p className="upgrade-footer upgrade-footer--policy" style={{ marginBottom: 8 }}>{t("upgradeModal.footer.noRefundNote")}</p>
            )}

            <div className="upgrade-confirm-actions">
              <button
                className="upgrade-plan-cta"
                style={{
                  background: confirm.kind === "cancel" ? "#ef4444"
                    : confirm.kind === "downgrade"      ? "#f59e0b"
                    :                                     confirm.color,
                  flex: 1,
                }}
                onClick={handleConfirm}
                disabled={confirming}
              >
                {confirming ? t("upgradeModal.confirm.processing")
                  : confirm.kind === "cancel"    ? t("upgradeModal.cta.cancelPlan")
                  : confirm.kind === "downgrade" ? t("upgradeModal.cta.switchTo", { plan: confirm.planLabel })
                  : confirm.amountDue !== undefined
                    ? t("upgradeModal.confirm.payAndUpgrade", { amount: formatAmount(confirm.amountDue, confirm.currency!) })
                    : t("upgradeModal.cta.upgradeTo", { plan: confirm.planLabel })}
              </button>
              <button className="upgrade-manage-link" style={{ marginTop: 14 }} onClick={() => setConfirm(null)} disabled={confirming}>
                {t("upgradeModal.confirm.goBack")}
              </button>
            </div>

            {error && <p className="upgrade-error">{error}</p>}
          </div>
        ) : (
          /* ── Plan selection screen ── */
          <>
            <div className="upgrade-header">
              <h2 className="upgrade-title">
                {isPaid ? t("upgradeModal.titleManage") : t("upgradeModal.titleChoose")}
              </h2>
              <p className="upgrade-sub">
                {isPaid ? t("upgradeModal.subManage") : t("upgradeModal.subChoose")}
              </p>
            </div>

            <div className="upgrade-plans">
              {PLANS.map(plan => {
                const planLabel = t(`upgradeModal.plans.${plan.id}.label`);
                const planFeatures = t(`upgradeModal.plans.${plan.id}.features`, { returnObjects: true }) as string[];
                const isCurrent = tier === plan.id;
                const planRank  = TIER_RANK[plan.id as keyof typeof TIER_RANK] ?? 0;
                const isHigher  = planRank > currentRank;
                const isLower   = planRank < currentRank;

                let ctaLabel = "";
                if      (!isCurrent && !isPaid && plan.priceId) ctaLabel = t("upgradeModal.cta.upgradeTo", { plan: planLabel });
                else if (isHigher)  ctaLabel = t("upgradeModal.cta.upgradeTo", { plan: planLabel });
                else if (isLower && plan.id !== "free") ctaLabel = t("upgradeModal.cta.switchTo", { plan: planLabel });

                return (
                  <div
                    key={plan.id}
                    className={`upgrade-plan${plan.popular ? " upgrade-plan--popular" : ""}${isCurrent ? " upgrade-plan--current" : ""}`}
                    style={{ "--plan-color": plan.color } as any}
                  >
                    {plan.popular && !isCurrent && <div className="upgrade-popular-badge">{t("upgradeModal.badges.mostPopular")}</div>}
                    {isCurrent                   && <div className="upgrade-popular-badge upgrade-current-badge">{t("upgradeModal.badges.yourPlan")}</div>}

                    <div className="upgrade-plan-label" style={{ color: plan.color }}>{planLabel}</div>
                    <div className="upgrade-plan-price">
                      <span className="upgrade-plan-amount">{plan.price}</span>
                      {plan.per && <span className="upgrade-plan-per">{t("upgradeModal.perMonth")}</span>}
                    </div>
                    <ul className="upgrade-plan-features">
                      {planFeatures.map(f => (
                        <li key={f}>
                          <span className="upgrade-plan-check" style={{ color: plan.color }}>✓</span>{f}
                        </li>
                      ))}
                    </ul>

                    {isCurrent ? (
                      <div className="upgrade-plan-current">{t("upgradeModal.cta.currentPlan")}</div>
                    ) : ctaLabel ? (
                      <button
                        className={`upgrade-plan-cta${isLower ? " upgrade-plan-cta--down" : ""}`}
                        style={{ background: isLower && plan.id === "free" ? "#ef4444" : isLower ? "#f59e0b" : plan.color }}
                        disabled={loading === plan.id}
                        onClick={() => handlePlanClick(plan)}
                      >
                        {loading === plan.id ? t("upgradeModal.cta.loading") : ctaLabel}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {error && <p className="upgrade-error">{error}</p>}

            <p className="upgrade-footer">
              {isPaid
                ? <>{t("upgradeModal.footer.proratedNote")}<button className="upgrade-manage-link" onClick={handleManageBilling} disabled={loading === "portal"}>{loading === "portal" ? t("upgradeModal.footer.loadingPortal") : t("upgradeModal.footer.manageBilling")}</button></>
                : t("upgradeModal.footer.cancelAnytime")
              }{t("upgradeModal.footer.securePayment")}
            </p>
            <p className="upgrade-footer upgrade-footer--policy">{t("upgradeModal.footer.noRefundNote")}</p>
            {isPaid && (
              <p className="upgrade-footer upgrade-footer--cancel">
                Want to cancel?{" "}
                <button
                  className="upgrade-manage-link upgrade-manage-link--danger"
                  onClick={() => handlePlanClick(PLANS[0])}
                >
                  Cancel subscription
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
