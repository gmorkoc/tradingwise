import { useEffect, useState } from "react";
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
  kind:       FlowKind;
  planId:     string;
  planLabel:  string;
  priceId?:   string;
  color:      string;
  amountDue?: number;
  currency?:  string;
  lostFeatures: string[];
}

const PLANS = [
  {
    id:    "free",
    label: "Free",
    price: "$0",
    color: "#94a3b8",
    features: [
      "Live price charts",
      "Order book",
      "Watchlist",
      "Fear & Greed gauge",
      "Flash news banner",
    ],
  },
  {
    id:      "pro",
    label:   "Pro",
    price:   "$10.99",
    per:     "/mo",
    color:   "#38bdf8",
    popular: true,
    priceId: () => PRICE_IDS.pro,
    features: [
      "Everything in Free",
      "HTF Multi-Timeframe AI",
      "AI Market Intelligence",
      "On-Chain AI Analysis",
      "Price Prediction Chart",
      "Liquidation Heatmap AI",
      "35 AI requests / week",
    ],
  },
  {
    id:    "elite",
    label: "Elite",
    price: "$29.99",
    per:   "/mo",
    color: "#a78bfa",
    priceId: () => PRICE_IDS.elite,
    features: [
      "Everything in Pro — unlimited",
      "Gann Analysis AI",
      "Coinbase Premium AI",
      "Early access to new features",
    ],
  },
];

// Features exclusive to each tier (not inherited)
const EXCLUSIVE_FEATURES: Record<string, string[]> = {
  elite: ["Gann Analysis AI", "Coinbase Premium AI", "Everything in Pro — unlimited", "Early access to new features"],
  pro:   ["AI Market Intelligence", "On-Chain AI Analysis", "Price Prediction Chart", "Liquidation Heatmap AI", "35 AI requests / week"],
};

function lostFeaturesFor(currentTier: string, targetTier: string): string[] {
  const currentRank = TIER_RANK[currentTier as keyof typeof TIER_RANK] ?? 0;
  const targetRank  = TIER_RANK[targetTier  as keyof typeof TIER_RANK] ?? 0;
  if (targetRank >= currentRank) return [];
  const lost: string[] = [];
  if (currentRank >= 2 && targetRank < 2) lost.push(...EXCLUSIVE_FEATURES.elite);
  if (currentRank >= 1 && targetRank < 1) lost.push(...EXCLUSIVE_FEATURES.pro);
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

    const planRank   = TIER_RANK[plan.id as keyof typeof TIER_RANK] ?? 0;
    const kind: FlowKind =
      plan.id === "free"       ? "cancel"
      : planRank > currentRank ? "upgrade"
      :                          "downgrade";

    // Cancel flow — no preview needed, show static confirmation
    if (kind === "cancel") {
      setConfirm({
        kind, planId: "free", planLabel: "Free", color: "#94a3b8",
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
      catch (e: any) { setError(e.message ?? "Something went wrong"); setLoading(null); }
      return;
    }

    // Existing subscriber → fetch proration preview first
    setLoading(plan.id);
    try {
      const { amountDue, currency } = await previewUpgrade(priceId);
      setConfirm({
        kind, planId: plan.id, planLabel: plan.label, priceId, color: plan.color,
        amountDue, currency,
        lostFeatures: lostFeaturesFor(tier, plan.id),
      });
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
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
          message: "Plan cancelled",
          sub:     `You'll keep your ${tier === "elite" ? "Elite" : "Pro"} access until ${formatDate(accessUntil)}, then switch to Free.`,
        });
      } else {
        const { isUpgrade } = await upgradePlan(confirm.priceId!);
        if (isUpgrade) {
          setDone({
            message: `Welcome to ${confirm.planLabel}!`,
            sub:     "Your new features are active immediately. The prorated charge has been applied to your card.",
          });
        } else {
          setDone({
            message: `Switched to ${confirm.planLabel}`,
            sub:     "Your plan has been updated. A prorated credit will be applied to your next bill.",
          });
        }
      }
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      setConfirming(false);
    }
  };

  const handleManageBilling = async () => {
    setLoading("portal");
    setError("");
    try { await redirectToBillingPortal(); }
    catch (e: any) { setError(e.message ?? "Something went wrong"); setLoading(null); }
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
              Done
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
              {confirm.kind === "cancel"    ? `Cancel your ${tier === "elite" ? "Elite" : "Pro"} plan`
               : confirm.kind === "upgrade" ? `Upgrade to ${confirm.planLabel}`
               :                             `Switch to ${confirm.planLabel}`}
            </h2>

            {/* What happens */}
            {confirm.kind === "cancel" && (
              <>
                <p className="upgrade-sub">
                  Your subscription will be cancelled at the end of your current billing period.
                  You'll keep all your current features until then — no partial refund is issued.
                </p>
              </>
            )}
            {confirm.kind === "upgrade" && confirm.amountDue !== undefined && (
              <p className="upgrade-sub">
                You'll be charged{" "}
                <strong>{formatAmount(confirm.amountDue, confirm.currency!)}</strong>{" "}
                now — the prorated difference for the remaining days in your billing cycle.
                Your new features are available immediately.
              </p>
            )}
            {confirm.kind === "downgrade" && (
              <p className="upgrade-sub">
                {confirm.amountDue && confirm.amountDue > 0
                  ? <>A prorated credit of <strong>{formatAmount(confirm.amountDue, confirm.currency!)}</strong> will be applied to your next bill.</>
                  : <>A prorated credit will be applied to your next bill.</>
                }{" "}
                Your plan changes immediately.
              </p>
            )}

            {/* Features you'll lose */}
            {confirm.lostFeatures.length > 0 && (
              <div className="upgrade-lost-features">
                <div className="upgrade-lost-label">You'll lose access to:</div>
                <ul className="upgrade-lost-list">
                  {confirm.lostFeatures.map(f => (
                    <li key={f}><span className="upgrade-lost-x">✕</span>{f}</li>
                  ))}
                </ul>
              </div>
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
                {confirming ? "Processing…"
                  : confirm.kind === "cancel"    ? "Cancel plan"
                  : confirm.kind === "downgrade" ? `Switch to ${confirm.planLabel}`
                  : confirm.amountDue !== undefined
                    ? `Pay ${formatAmount(confirm.amountDue, confirm.currency!)} & Upgrade`
                    : `Upgrade to ${confirm.planLabel}`}
              </button>
              <button className="upgrade-manage-link" style={{ marginTop: 14 }} onClick={() => setConfirm(null)} disabled={confirming}>
                Go back
              </button>
            </div>

            {error && <p className="upgrade-error">{error}</p>}
          </div>
        ) : (
          /* ── Plan selection screen ── */
          <>
            <div className="upgrade-header">
              <h2 className="upgrade-title">
                {isPaid ? "Manage your plan" : "Choose your plan"}
              </h2>
              <p className="upgrade-sub">
                {isPaid
                  ? "Upgrades are charged immediately (prorated). Downgrades credit your next bill."
                  : "Unlock AI-powered insights and advanced analytics"}
              </p>
            </div>

            <div className="upgrade-plans">
              {PLANS.map(plan => {
                const isCurrent = tier === plan.id;
                const planRank  = TIER_RANK[plan.id as keyof typeof TIER_RANK] ?? 0;
                const isHigher  = planRank > currentRank;
                const isLower   = planRank < currentRank;

                let ctaLabel = "";
                if      (!isCurrent && !isPaid && plan.priceId) ctaLabel = `Upgrade to ${plan.label}`;
                else if (isHigher)  ctaLabel = `Upgrade to ${plan.label}`;
                else if (isLower && plan.id !== "free") ctaLabel = `Switch to ${plan.label}`;
                else if (isLower && plan.id === "free") ctaLabel = "Cancel plan";

                return (
                  <div
                    key={plan.id}
                    className={`upgrade-plan${plan.popular ? " upgrade-plan--popular" : ""}${isCurrent ? " upgrade-plan--current" : ""}`}
                    style={{ "--plan-color": plan.color } as any}
                  >
                    {plan.popular && !isCurrent && <div className="upgrade-popular-badge">Most Popular</div>}
                    {isCurrent                   && <div className="upgrade-popular-badge upgrade-current-badge">Your Plan</div>}

                    <div className="upgrade-plan-label" style={{ color: plan.color }}>{plan.label}</div>
                    <div className="upgrade-plan-price">
                      <span className="upgrade-plan-amount">{plan.price}</span>
                      {plan.per && <span className="upgrade-plan-per">{plan.per}</span>}
                    </div>
                    <ul className="upgrade-plan-features">
                      {plan.features.map(f => (
                        <li key={f}>
                          <span className="upgrade-plan-check" style={{ color: plan.color }}>✓</span>{f}
                        </li>
                      ))}
                    </ul>

                    {isCurrent ? (
                      <div className="upgrade-plan-current">Current Plan</div>
                    ) : ctaLabel ? (
                      <button
                        className={`upgrade-plan-cta${isLower ? " upgrade-plan-cta--down" : ""}`}
                        style={{ background: isLower && plan.id === "free" ? "#ef4444" : isLower ? "#f59e0b" : plan.color }}
                        disabled={loading === plan.id}
                        onClick={() => handlePlanClick(plan)}
                      >
                        {loading === plan.id ? "Loading…" : ctaLabel}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {error && <p className="upgrade-error">{error}</p>}

            <p className="upgrade-footer">
              {isPaid
                ? <>Plan switches are prorated · <button className="upgrade-manage-link" onClick={handleManageBilling} disabled={loading === "portal"}>{loading === "portal" ? "Loading…" : "Manage billing"}</button></>
                : "Cancel anytime"
              } · Secure payment via Stripe
            </p>
          </>
        )}
      </div>
    </div>
  );
};
