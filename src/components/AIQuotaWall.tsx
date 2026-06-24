import { useState } from "react";
import { useTranslation } from "react-i18next";
import { redirectToCheckout, PRICE_IDS } from "../services/stripeService";
import { useAuth } from "../contexts/AuthContext";
import "../styles/AIQuotaWall.css";

interface Props {
  used: number;
  limit: number;
  onOpenUpgrade: () => void;
  onOpenAuth: () => void;
  planId?: "pro" | "elite";
  featureTitle?: string;
  featureDesc?: string;
}

const PLANS = [
  {
    id: "pro",
    label: "Pro",
    price: "$30.99",
    per: "/mo",
    color: "#38bdf8",
    popular: true,
    priceId: () => PRICE_IDS.pro,
    features: ["AI Market Intelligence", "On-Chain AI Analysis", "Price Prediction Chart", "Liquidation Heatmap AI", "35 AI requests / week"],
  },
  {
    id: "elite",
    label: "Elite",
    price: "$59.99",
    per: "/mo",
    color: "#a78bfa",
    popular: false,
    priceId: () => PRICE_IDS.elite,
    features: ["Everything in Pro — unlimited", "Gann Analysis AI", "Coinbase Premium AI", "Early access to features"],
  },
];

export const AIQuotaWall: React.FC<Props> = ({ used, limit, onOpenAuth, planId, featureTitle, featureDesc }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const isFreeBlock = limit === 0;
  const visiblePlans = planId ? PLANS.filter(p => p.id === planId) : PLANS;

  const handleUpgrade = async (plan: typeof PLANS[number]) => {
    if (!user) { onOpenAuth(); return; }
    setLoadingPlan(plan.id);
    await redirectToCheckout(plan.priceId());
    setLoadingPlan(null);
  };

  /* ── Gate mode: single horizontal banner ── */
  if (planId) {
    const plan = visiblePlans[0];
    return (
      <div className="aiqw-gate-row" style={{ "--gate-color": plan.color } as React.CSSProperties}>
        <div className="aiqw-gate-left">
          <div className="aiqw-gate-info">
            <div className="aiqw-gate-title-row">
              <span className="aiqw-gate-ai-badge">AI</span>
              <span className="aiqw-gate-title">{featureTitle}</span>
              <span className="aiqw-gate-tier-badge" style={{ color: plan.color, borderColor: `${plan.color}55`, background: `${plan.color}18` }}>
                {plan.label.toUpperCase()}
              </span>
              <span className="aiqw-live-badge">
                <span className="aiqw-live-dot" />
                LIVE
              </span>
            </div>
            {featureDesc && <span className="aiqw-gate-desc">{featureDesc}</span>}
            <div className="aiqw-gate-features">
              {plan.features.map(f => (
                <span key={f} className="aiqw-gate-feature">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  {f}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="aiqw-gate-right">
          <span className="aiqw-gate-price">
            {plan.price}<span className="aiqw-gate-per">{plan.per}</span>
          </span>
          <button
            className="aiqw-gate-btn"
            style={{ background: plan.color, borderColor: plan.color }}
            onClick={() => handleUpgrade(plan)}
            disabled={loadingPlan === plan.id}
          >
            {loadingPlan === plan.id ? t("quotaWall.redirecting") : t("quotaWall.getBtn", { plan: plan.label })}
          </button>
        </div>
      </div>
    );
  }

  /* ── Full quota wall (multi-plan) ── */
  return (
    <div className="aiqw-root">
      <div className="aiqw-bg-orb aiqw-bg-orb--1" />
      <div className="aiqw-bg-orb aiqw-bg-orb--2" />

      <div className="aiqw-inner">
        <div className="aiqw-top">
          <div className="aiqw-icon-wrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            </svg>
          </div>
          <div className="aiqw-text">
            {isFreeBlock ? (
              <>
                <h3 className="aiqw-title">{t("quotaWall.freeTitle")}</h3>
                <p className="aiqw-desc">{t("quotaWall.freeDesc")}</p>
              </>
            ) : (
              <>
                <h3 className="aiqw-title">{t("quotaWall.capTitle")}</h3>
                <p className="aiqw-desc"
                  dangerouslySetInnerHTML={{ __html: t("quotaWall.capDesc", { used, limit }) }}
                />
              </>
            )}
          </div>
        </div>

        {!isFreeBlock && (
          <div className="aiqw-usage">
            {Array.from({ length: limit }).map((_, i) => (
              <span key={i} className={`aiqw-pip ${i < used ? "aiqw-pip--used" : ""}`} />
            ))}
            <span className="aiqw-usage-label">{t("quotaWall.usagePips", { used, limit })}</span>
          </div>
        )}

        <div className="aiqw-plans">
          {PLANS.map(plan => (
            <div key={plan.id} className="aiqw-plan" style={{ "--plan-color": plan.color } as React.CSSProperties}>
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
                {loadingPlan === plan.id ? t("quotaWall.redirecting") : t("quotaWall.getBtn", { plan: plan.label })}
              </button>
            </div>
          ))}
        </div>

        <button className="aiqw-signin" onClick={onOpenAuth}>
          {t("quotaWall.signin")}
        </button>
      </div>
    </div>
  );
};
