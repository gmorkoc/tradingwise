import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { redirectToCheckout, previewUpgrade, upgradePlan, PRICE_IDS } from "../services/stripeService";
import { isIAPAvailable, getIAPPlans, purchaseIAPPlan, syncIAPEntitlement, type IAPPlan } from "../services/revenuecat";
import "../styles/MembershipGate.css";

interface Props {
  onClose: () => void;
  onOpenAuth: () => void;
}

function formatAmount(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// Single-plan Elite upsell — shown when a non-elite user taps a feature
// that's elite-only (currently just Agent Ready), instead of the generic
// multi-tier UpgradeModal. Reuses the exact .bg-elite-card markup/CSS
// BlurGate already renders inline for elite-gated page sections, just
// popped up as a standalone centered modal (its own backdrop below) since
// Agent Ready is a floating trigger, not a page section with content to
// blur behind it.
export function EliteUpsellModal({ onClose, onOpenAuth }: Props) {
  const { t } = useTranslation();
  const { user, tier, refreshProfile } = useAuth();
  const [loadingPlan,   setLoadingPlan]   = useState(false);
  const [prorationData, setProrationData] = useState<{ amountDue: number; currency: string } | null>(null);
  const [upgrading,     setUpgrading]     = useState(false);
  const [upgraded,      setUpgraded]      = useState(false);
  const [iapPlans,      setIapPlans]      = useState<IAPPlan[]>([]);
  const iap = isIAPAvailable();

  useEffect(() => {
    if (!iap) return;
    getIAPPlans().then(setIapPlans);
  }, [iap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isProUser = user !== null && tier === "pro";
  const iapPlan = iapPlans.find(p => p.tier === "elite");
  const planPrice = iap ? (iapPlan?.priceString ?? "$59.99") : "$59.99";

  const handleUpgrade = async () => {
    if (!user) { onOpenAuth(); return; }

    // StoreKit's own purchase sheet, not Stripe — same reasoning as
    // UpgradeModal.tsx (Apple requires IAP for digital subscriptions).
    // Handles both a brand-new purchase and an existing Pro subscriber
    // crossgrading — RevenueCat/StoreKit handle that automatically within
    // the subscription group.
    if (iap) {
      if (!iapPlan) return;
      setLoadingPlan(true);
      const result = await purchaseIAPPlan(iapPlan);
      if (result.cancelled || !result.success) { setLoadingPlan(false); return; }
      await syncIAPEntitlement();
      await refreshProfile();
      setLoadingPlan(false);
      setUpgraded(true);
      return;
    }

    if (isProUser) {
      // Existing Stripe subscriber → prorated preview, same as BlurGate's
      // own Pro→Elite path.
      setLoadingPlan(true);
      try {
        const { amountDue, currency } = await previewUpgrade(PRICE_IDS.elite);
        setProrationData({ amountDue, currency });
      } catch {
        await redirectToCheckout(PRICE_IDS.elite);
      } finally {
        setLoadingPlan(false);
      }
    } else {
      setLoadingPlan(true);
      await redirectToCheckout(PRICE_IDS.elite);
      setLoadingPlan(false);
    }
  };

  const handleConfirmUpgrade = async () => {
    setUpgrading(true);
    try {
      await upgradePlan(PRICE_IDS.elite);
      setUpgraded(true);
      setTimeout(() => window.location.reload(), 1800);
    } catch {
      setProrationData(null);
      setUpgrading(false);
    }
  };

  const features = t("membershipGate.blurGate.features", { returnObjects: true }) as Array<{
    icon: string; title: string; desc: string;
  }>;

  const headline = isProUser ? t("membershipGate.blurGate.pro_headline") : t("membershipGate.blurGate.free_headline");
  const sub      = isProUser ? t("membershipGate.blurGate.pro_sub")      : t("membershipGate.blurGate.free_sub");
  const ctaLabel = isProUser ? t("membershipGate.blurGate.pro_upgradeBtn") : t("membershipGate.blurGate.upgradeBtn");
  const trustLine= isProUser ? t("membershipGate.blurGate.pro_trust")    : t("membershipGate.blurGate.trust");

  return (
    <div className="bg-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-elite-card bg-elite-card--modal">
        <button className="bg-modal-close" onClick={onClose} aria-label="Close">✕</button>

        <div className="bg-elite-top">
          <div className="bg-elite-badge">✦ ELITE</div>
          <div className="bg-elite-price-wrap">
            <span className="bg-elite-price">{planPrice}</span>
            <span className="bg-elite-per">{t("membershipGate.blurGate.perMonth")}</span>
          </div>
        </div>

        {upgraded ? (
          <div className="bg-proration-success">
            <span className="bg-proration-check">✓</span>
            <p>You're now on <strong>Elite</strong>.</p>
            <button className="bg-elite-cta" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="bg-elite-headline">
              <h3>{headline}</h3>
              <p>{sub}</p>
            </div>

            {isProUser && (
              <div className="bg-elite-pro-banner">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
                <span>You're on <strong>Pro</strong> · all features carry over</span>
              </div>
            )}

            {prorationData ? (
              <div className="bg-proration">
                <p className="bg-proration-body">
                  You'll be charged{" "}
                  <strong>{formatAmount(prorationData.amountDue, prorationData.currency)}</strong>{" "}
                  today — prorated for the rest of your billing period. Then{" "}
                  <strong>$59.99/mo</strong> on your normal renewal date.
                </p>
                <button className="bg-elite-cta" onClick={handleConfirmUpgrade} disabled={upgrading}>
                  {upgrading
                    ? t("membershipGate.blurGate.redirecting")
                    : `Pay ${formatAmount(prorationData.amountDue, prorationData.currency)} & Upgrade to Elite`}
                  {!upgrading && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  )}
                </button>
                <button className="bg-proration-back" onClick={() => setProrationData(null)} disabled={upgrading}>
                  ← Go back
                </button>
              </div>
            ) : (
              <>
                <div className="bg-elite-features">
                  {features.map(f => (
                    <div key={f.title} className="bg-elite-feature">
                      <span className="bg-elite-feat-icon">
                        {f.icon === "agentOrb" ? <span className="ta-trigger-orb" /> : f.icon}
                      </span>
                      <div>
                        <p className="bg-elite-feat-title">{f.title}</p>
                        <p className="bg-elite-feat-desc">{f.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <button className="bg-elite-cta" onClick={handleUpgrade} disabled={loadingPlan}>
                  {loadingPlan ? t("membershipGate.blurGate.redirecting") : ctaLabel}
                  {!loadingPlan && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  )}
                </button>

                <p className="bg-card-trust">{trustLine}</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
