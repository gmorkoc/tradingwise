import { useState } from "react";
import { redirectToCheckout, PRICE_IDS } from "../services/stripeService";
import { useAuth } from "../contexts/AuthContext";
import "../styles/AIQuotaWall.css";

interface Props {
  used: number;
  limit: number;
  onOpenUpgrade: () => void;
  onOpenAuth: () => void;
}

const PLANS = [
  {
    id: "pro",
    label: "Pro",
    price: "$9",
    per: "/mo",
    color: "#38bdf8",
    popular: true,
    priceId: () => PRICE_IDS.pro,
    features: ["AI Market Intelligence", "On-Chain AI Analysis", "Price Prediction Chart", "Liquidation Heatmap"],
  },
  {
    id: "elite",
    label: "Elite",
    price: "$29",
    per: "/mo",
    color: "#a78bfa",
    popular: false,
    priceId: () => PRICE_IDS.elite,
    features: ["Everything in Pro", "Gann Analysis", "Priority AI responses", "Advanced scenario planning"],
  },
];

export const AIQuotaWall: React.FC<Props> = ({ used, limit, onOpenAuth }) => {
  const { user } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const isFreeBlock = limit === 0;

  const handleUpgrade = async (plan: typeof PLANS[number]) => {
    if (!user) { onOpenAuth(); return; }
    setLoadingPlan(plan.id);
    await redirectToCheckout(plan.priceId());
    setLoadingPlan(null);
  };

  return (
    <div className="aiqw-root">
      <div className="aiqw-bg-orb aiqw-bg-orb--1" />
      <div className="aiqw-bg-orb aiqw-bg-orb--2" />

      <div className="aiqw-inner">
        {/* Header */}
        <div className="aiqw-top">
          <div className="aiqw-icon-wrap">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            </svg>
          </div>
          <div className="aiqw-text">
            {isFreeBlock ? (
              <>
                <h3 className="aiqw-title">AI features require a paid plan</h3>
                <p className="aiqw-desc">
                  Upgrade to unlock AI-powered market analysis, predictions, and insights across every section.
                </p>
              </>
            ) : (
              <>
                <h3 className="aiqw-title">Weekly AI limit reached</h3>
                <p className="aiqw-desc">
                  You've used <strong>{used}/{limit}</strong> AI requests this week. Upgrade for unlimited access.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Usage pips — only shown for paid tiers that hit their cap */}
        {!isFreeBlock && (
          <div className="aiqw-usage">
            {Array.from({ length: limit }).map((_, i) => (
              <span key={i} className={`aiqw-pip ${i < used ? "aiqw-pip--used" : ""}`} />
            ))}
            <span className="aiqw-usage-label">{used}/{limit} used · resets Monday</span>
          </div>
        )}

        {/* Plan cards */}
        <div className="aiqw-plans">
          {PLANS.map(plan => (
            <div key={plan.id} className={`aiqw-plan${plan.popular ? " aiqw-plan--popular" : ""}`} style={{ "--plan-color": plan.color } as React.CSSProperties}>
              {plan.popular && <span className="aiqw-plan-badge">Most Popular</span>}
              <div className="aiqw-plan-header">
                <span className="aiqw-plan-label" style={{ color: plan.color }}>{plan.label}</span>
                <span className="aiqw-plan-price">
                  {plan.price}<span className="aiqw-plan-per">{plan.per}</span>
                </span>
              </div>
              <ul className="aiqw-plan-features">
                {plan.features.map(f => (
                  <li key={f}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                className="aiqw-plan-btn"
                style={{ background: `linear-gradient(135deg, ${plan.color}cc, ${plan.color}88)`, borderColor: `${plan.color}55` }}
                onClick={() => handleUpgrade(plan)}
                disabled={loadingPlan === plan.id}
              >
                {loadingPlan === plan.id ? "Redirecting…" : `Get ${plan.label}`}
              </button>
            </div>
          ))}
        </div>

        {/* Sign in link */}
        <button className="aiqw-signin" onClick={onOpenAuth}>
          Already have a plan? Sign in
        </button>
      </div>
    </div>
  );
};
