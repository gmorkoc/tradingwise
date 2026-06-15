import { useState, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { Tier, hasAccess } from "../services/supabase";
import { redirectToCheckout, PRICE_IDS } from "../services/stripeService";
import "../styles/AIQuotaWall.css";
import "../styles/MembershipGate.css";

const TIER_COLOR: Record<Tier, string> = {
  free:  "#94a3b8",
  pro:   "#38bdf8",
  elite: "#a78bfa",
};

interface Props {
  requiredTier: Tier;
  children: ReactNode;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  featureName?: string;
}

function CheckIcon({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  );
}

export const MembershipGate: React.FC<Props> = ({
  requiredTier, children, onOpenAuth, onOpenUpgrade, featureName,
}) => {
  const { t } = useTranslation();
  const { user, tier, loading } = useAuth();

  if (loading) return <div className="mg-loading">{t("membershipGate.loading")}</div>;

  if (!user) {
    const perks = t("membershipGate.signin.perks", { returnObjects: true }) as string[];
    return (
      <div className="mg-wall">
        <div className="mg-orb mg-orb--1" />
        <div className="mg-orb mg-orb--2" />
        <div className="mg-inner">
          <div className="mg-icon-wrap mg-icon-wrap--lock">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
          </div>
          <div className="mg-headline-block">
            <h3 className="mg-title">{t("membershipGate.signin.title")}</h3>
            <p className="mg-sub">{t("membershipGate.signin.sub", { feature: featureName ?? t("common.na") })}</p>
          </div>
          <div className="mg-free-perks">
            {perks.map(p => (
              <div key={p} className="mg-free-perk">
                <CheckIcon color="#22c55e" />
                <span>{p}</span>
              </div>
            ))}
          </div>
          <button className="mg-cta mg-cta--neutral" onClick={onOpenAuth}>
            {t("membershipGate.signin.cta")}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <p className="mg-trust">{t("membershipGate.signin.trust")}</p>
        </div>
      </div>
    );
  }

  if (!hasAccess(tier, requiredTier)) {
    const color = TIER_COLOR[requiredTier];
    const ns = requiredTier as "pro" | "elite";
    const features = t(`membershipGate.${ns}.features`, { returnObjects: true }) as Array<{ icon: string; title: string; desc: string }>;

    return (
      <div className="mg-wall">
        <div className="mg-orb mg-orb--1" />
        <div className="mg-orb mg-orb--2" />
        <div className="mg-inner">

          {/* Headline */}
          <div className="mg-headline-block">
            <h3 className="mg-title">{t(`membershipGate.${ns}.headline`)}</h3>
            <p className="mg-sub">{t(`membershipGate.${ns}.sub`)}</p>
          </div>

          {/* Feature cards */}
          <div className="mg-feature-grid">
            {features.map(f => (
              <div key={f.title} className="mg-feature-card">
                <span className="mg-feature-icon">{f.icon}</span>
                <div>
                  <p className="mg-feature-title">{f.title}</p>
                  <p className="mg-feature-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            className="mg-cta"
            style={{ "--mg-color": color } as React.CSSProperties}
            onClick={onOpenUpgrade}
          >
            {t(`membershipGate.${ns}.cta`)}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <p className="mg-trust">{t(`membershipGate.${ns}.trust`)}</p>

        </div>
      </div>
    );
  }

  return <>{children}</>;
};

/* ── BlurGate: renders content blurred with a floating upgrade card ───────── */
export const BlurGate: React.FC<Props> = ({ requiredTier, children, onOpenAuth }) => {
  const { t } = useTranslation();
  const { user, tier, loading } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState(false);

  if (loading) return <>{children}</>;
  if (user && hasAccess(tier, requiredTier)) return <>{children}</>;

  const handleUpgrade = async () => {
    setLoadingPlan(true);
    await redirectToCheckout(PRICE_IDS.elite);
    setLoadingPlan(false);
  };

  return (
    <div className="bg-root">
      <div className="bg-content" aria-hidden="true">
        {children}
      </div>
      <div className="bg-overlay">
        <div className="aiqw-plan bg-plan-card" style={{ "--plan-color": "#a78bfa" } as React.CSSProperties}>
          <div className="aiqw-plan-header">
            <span className="aiqw-plan-label" style={{ color: "#a78bfa" }}>{t("membershipGate.blurGate.planLabel")}</span>
            <span className="aiqw-plan-price">{t("membershipGate.blurGate.planPrice")}<span className="aiqw-plan-per">{t("membershipGate.blurGate.perMonth")}</span></span>
          </div>
          <ul className="aiqw-plan-features">
            {(t("membershipGate.blurGate.features", { returnObjects: true }) as string[]).map(f => (
              <li key={f}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                {f}
              </li>
            ))}
          </ul>
          <button
            className="aiqw-plan-btn"
            style={{ background: "linear-gradient(135deg, #a78bfacc, #a78bfa88)", borderColor: "#a78bfa55" }}
            onClick={!user ? onOpenAuth : handleUpgrade}
            disabled={loadingPlan}
          >
            {!user ? t("membershipGate.blurGate.signInBtn") : loadingPlan ? t("membershipGate.blurGate.redirecting") : t("membershipGate.blurGate.upgradeBtn")}
          </button>
          <p className="bg-card-trust">{t("membershipGate.blurGate.trust")}</p>
        </div>
      </div>
    </div>
  );
};
