import { useState, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { Tier, hasAccess } from "../services/supabase";
import { redirectToCheckout, previewUpgrade, upgradePlan, PRICE_IDS } from "../services/stripeService";
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
  previewSrc?: string;
  className?: string;
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

function formatAmount(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/* ── BlurGate: shows static preview image blurred + upgrade card overlay ──── */
export const BlurGate: React.FC<Props> = ({ requiredTier, children, onOpenAuth, onOpenUpgrade, previewSrc, className }) => {
  const { t } = useTranslation();
  const { user, tier, loading } = useAuth();
  const [loadingPlan,     setLoadingPlan]     = useState(false);
  const [prorationData,   setProrationData]   = useState<{ amountDue: number; currency: string } | null>(null);
  const [upgrading,       setUpgrading]       = useState(false);
  const [upgraded,        setUpgraded]        = useState(false);

  if (loading) return <>{children}</>;
  if (user && hasAccess(tier, requiredTier)) return <>{children}</>;

  const isProGate  = requiredTier === "pro";
  const isProUser  = user !== null && tier === "pro";
  // A Pro user can only hit the Elite gate; that's the one case needing proration.
  const needsProration = isProUser && !isProGate;

  const priceId = isProGate ? PRICE_IDS.pro : PRICE_IDS.elite;

  const handleUpgrade = async () => {
    if (needsProration) {
      // Existing subscriber → fetch prorated amount, show inline confirm
      setLoadingPlan(true);
      try {
        const { amountDue, currency } = await previewUpgrade(priceId);
        setProrationData({ amountDue, currency });
      } catch {
        // If preview fails fall back to UpgradeModal which also handles proration
        onOpenUpgrade();
      } finally {
        setLoadingPlan(false);
      }
    } else {
      // New subscriber → create fresh checkout session
      setLoadingPlan(true);
      await redirectToCheckout(priceId);
      setLoadingPlan(false);
    }
  };

  const handleConfirmUpgrade = async () => {
    setUpgrading(true);
    try {
      await upgradePlan(priceId);
      setUpgraded(true);
      setTimeout(() => window.location.reload(), 1800);
    } catch {
      setProrationData(null);
      setUpgrading(false);
    }
  };

  const eliteFeatures = t("membershipGate.blurGate.features", { returnObjects: true }) as Array<{
    icon: string; title: string; desc: string;
  }>;
  const proFeatures = t("membershipGate.pro.features", { returnObjects: true }) as Array<{
    icon: string; title: string; desc: string;
  }>;
  const features = isProGate ? proFeatures : eliteFeatures;

  const planPrice = isProGate ? "$30.99" : t("membershipGate.blurGate.planPrice");

  let headline: string;
  let sub: string;
  let ctaLabel: string;
  let trustLine: string;

  if (isProGate) {
    headline = t("membershipGate.pro.headline");
    sub = t("membershipGate.pro.sub");
    ctaLabel = t("membershipGate.pro.cta");
    trustLine = t("membershipGate.pro.trust");
  } else if (isProUser) {
    headline = t("membershipGate.blurGate.pro_headline");
    sub = t("membershipGate.blurGate.pro_sub");
    ctaLabel = t("membershipGate.blurGate.pro_upgradeBtn");
    trustLine = t("membershipGate.blurGate.pro_trust");
  } else {
    headline = t("membershipGate.blurGate.free_headline");
    sub = t("membershipGate.blurGate.free_sub");
    ctaLabel = t("membershipGate.blurGate.upgradeBtn");
    trustLine = t("membershipGate.blurGate.trust");
  }

  return (
    <div className={`bg-root${className ? ` ${className}` : ""}`}>
      <div className="bg-content" aria-hidden="true">
        {previewSrc
          ? <img src={previewSrc} className="bg-preview-img" alt="" draggable={false} />
          : children}
      </div>
      <div className="bg-overlay">
        <div className={`bg-elite-card${isProGate ? " bg-elite-card--pro" : ""}`}>

          {/* Top bar: badge + price */}
          <div className="bg-elite-top">
            <div className={`bg-elite-badge${isProGate ? " bg-elite-badge--pro" : ""}`}>
              ✦ {isProGate ? "PRO" : "ELITE"}
            </div>
            <div className="bg-elite-price-wrap">
              <span className="bg-elite-price">{planPrice}</span>
              <span className="bg-elite-per">{t("membershipGate.blurGate.perMonth")}</span>
            </div>
          </div>

          {/* Headline */}
          <div className="bg-elite-headline">
            <h3>{headline}</h3>
            <p>{sub}</p>
          </div>

          {/* Pro user callout (only on Elite gate) */}
          {!isProGate && isProUser && (
            <div className="bg-elite-pro-banner">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
              <span>You're on <strong>Pro</strong> · $30.99/mo — all features carry over</span>
            </div>
          )}

          {/* Inline proration confirm — replaces feature grid + CTA for Pro→Elite */}
          {prorationData ? (
            <div className="bg-proration">
              {upgraded ? (
                <div className="bg-proration-success">
                  <span className="bg-proration-check">✓</span>
                  <p>You're now on <strong>Elite</strong>. Reloading…</p>
                </div>
              ) : (
                <>
                  <p className="bg-proration-body">
                    You'll be charged{" "}
                    <strong>{formatAmount(prorationData.amountDue, prorationData.currency)}</strong>{" "}
                    today — prorated for the rest of your billing period. Then{" "}
                    <strong>$59.99/mo</strong> on your normal renewal date.
                  </p>
                  <button
                    className="bg-elite-cta"
                    onClick={handleConfirmUpgrade}
                    disabled={upgrading}
                  >
                    {upgrading
                      ? t("membershipGate.blurGate.redirecting")
                      : `Pay ${formatAmount(prorationData.amountDue, prorationData.currency)} & Upgrade to Elite`}
                    {!upgrading && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M12 5l7 7-7 7"/>
                      </svg>
                    )}
                  </button>
                  <button
                    className="bg-proration-back"
                    onClick={() => setProrationData(null)}
                    disabled={upgrading}
                  >
                    ← Go back
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Feature grid */}
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
                className={`bg-elite-cta${isProGate ? " bg-elite-cta--pro" : ""}`}
                onClick={!user ? onOpenAuth : handleUpgrade}
                disabled={loadingPlan}
              >
                {!user
                  ? t("membershipGate.blurGate.signInBtn")
                  : loadingPlan
                    ? t("membershipGate.blurGate.redirecting")
                    : ctaLabel}
                {!loadingPlan && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>
                )}
              </button>

              <p className="bg-card-trust">{trustLine}</p>
            </>
          )}

        </div>
      </div>
    </div>
  );
};
