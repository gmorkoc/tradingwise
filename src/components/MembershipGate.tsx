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
    const isPro = tier === "pro" && ns === "elite";

    return (
      <div className="mg-wall">
        <div className="mg-orb mg-orb--1" />
        <div className="mg-orb mg-orb--2" />
        <div className="mg-inner">

          {/* Headline */}
          <div className="mg-headline-block">
            <h3 className="mg-title">
              {isPro ? t("membershipGate.elite.pro_headline") : t(`membershipGate.${ns}.headline`)}
            </h3>
            <p className="mg-sub">
              {isPro ? t("membershipGate.elite.pro_sub") : t(`membershipGate.${ns}.sub`)}
            </p>
          </div>

          {/* Pro callout banner */}
          {isPro && (
            <div className="mg-pro-callout">
              <CheckIcon color="#38bdf8" />
              <span>You're on <strong>Pro</strong> — all your current features carry over</span>
            </div>
          )}

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
            {isPro ? t("membershipGate.elite.pro_cta") : t(`membershipGate.${ns}.cta`)}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <p className="mg-trust">
            {isPro ? t("membershipGate.elite.pro_trust") : t(`membershipGate.${ns}.trust`)}
          </p>

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

  const isPro = user !== null && tier === "pro";

  const handleUpgrade = async () => {
    setLoadingPlan(true);
    await redirectToCheckout(PRICE_IDS.elite);
    setLoadingPlan(false);
  };

  const features = t("membershipGate.blurGate.features", { returnObjects: true }) as Array<{
    icon: string; title: string; desc: string;
  }>;

  return (
    <div className="bg-root">
      <div className="bg-content" aria-hidden="true">
        {children}
      </div>
      <div className="bg-overlay">
        <div className="bg-elite-card">

          {/* Top bar: badge + price */}
          <div className="bg-elite-top">
            <div className="bg-elite-badge">✦ ELITE</div>
            <div className="bg-elite-price-wrap">
              <span className="bg-elite-price">{t("membershipGate.blurGate.planPrice")}</span>
              <span className="bg-elite-per">{t("membershipGate.blurGate.perMonth")}</span>
            </div>
          </div>

          {/* Headline */}
          <div className="bg-elite-headline">
            <h3>{isPro ? t("membershipGate.blurGate.pro_headline") : t("membershipGate.blurGate.free_headline")}</h3>
            <p>{isPro ? t("membershipGate.blurGate.pro_sub") : t("membershipGate.blurGate.free_sub")}</p>
          </div>

          {/* Pro user callout */}
          {isPro && (
            <div className="bg-elite-pro-banner">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
              <span>You're on <strong>Pro</strong> · $30.99/mo — all features carry over</span>
            </div>
          )}

          {/* 8-feature grid */}
          <div className="bg-elite-features">
            {features.map(f => (
              <div key={f.title} className="bg-elite-feature">
                <span className="bg-elite-feat-icon">{f.icon}</span>
                <div>
                  <p className="bg-elite-feat-title">{f.title}</p>
                  <p className="bg-elite-feat-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* CTA button */}
          <button
            className="bg-elite-cta"
            onClick={!user ? onOpenAuth : handleUpgrade}
            disabled={loadingPlan}
          >
            {!user
              ? t("membershipGate.blurGate.signInBtn")
              : loadingPlan
                ? t("membershipGate.blurGate.redirecting")
                : isPro
                  ? t("membershipGate.blurGate.pro_upgradeBtn")
                  : t("membershipGate.blurGate.upgradeBtn")}
            {!loadingPlan && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            )}
          </button>

          <p className="bg-card-trust">
            {isPro ? t("membershipGate.blurGate.pro_trust") : t("membershipGate.blurGate.trust")}
          </p>

        </div>
      </div>
    </div>
  );
};
