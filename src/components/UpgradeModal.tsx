import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import {
  redirectToCheckout,
  redirectToBillingPortal,
  previewUpgrade,
  upgradePlan,
  cancelSubscription,
  reactivateSubscription,
  PRICE_IDS,
} from "../services/stripeService";
import {
  isIAPAvailable,
  getIAPPlans,
  purchaseIAPPlan,
  restorePurchases,
  syncIAPEntitlement,
  type IAPPlan,
} from "../services/revenuecat";
import { TIER_RANK, fetchProfile, subscriptionProvider, type Tier } from "../services/supabase";
import "../styles/UpgradeModal.css";

// Fallback only — syncIAPEntitlement() (called right after a purchase or
// restore) verifies against RevenueCat directly and writes profiles.tier
// synchronously, so normally there's nothing left to wait for. This poll
// only matters if that call itself failed transiently and the passive
// webhook ends up landing a little later instead.
async function waitForTier(userId: string, expectedTier: Tier, maxAttempts = 8): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const p = await fetchProfile(userId);
    if (p && TIER_RANK[p.tier] >= TIER_RANK[expectedTier]) return true;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

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

// Feature-list icons — line style, picked by keywords in the (English)
// feature text; anything unmatched gets a plain check.
const FEATURE_ICONS: { match: RegExp; d: string[] }[] = [
  { match: /unlimited/i,                d: ["M18.2 8.2a5.5 5.5 0 100 7.6L12 12l-6.2-3.8a5.5 5.5 0 100 7.6L12 12z"] },
  { match: /requests/i,                 d: ["M13 2L3 14h9l-1 8 10-12h-9l1-8z"] },
  { match: /early access/i,             d: ["M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 00-2.9-.1z", "M12 15l-3-3a22 22 0 012-3.9A12.9 12.9 0 0122 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 01-4 2z", "M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0", "M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"] },
  { match: /signals/i,                  d: ["M3 17l6-6 4 4 8-8", "M14 7h7v7"] },
  { match: /candle/i,                   d: ["M8 4v16", "M16 4v16", "M6 8h4v7H6z", "M14 6h4v9h-4z"] },
  { match: /analyze a chart|screenshot/i, d: ["M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z", "M12 17a4 4 0 100-8 4 4 0 000 8z"] },
  { match: /charts|drawing/i,           d: ["M3 3v18h18", "M7 14l4-4 4 4 5-6"] },
  { match: /indicator/i,                d: ["M15 4V2", "M15 16v-2", "M8 9h2", "M20 9h2", "M17.8 11.8L19 13", "M15 9h.01", "M17.8 6.2L19 5", "M3 21l9-9", "M12.2 6.2L11 5"] },
  { match: /alt analysis|options|correlation/i, d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"] },
  { match: /strategy alerts|alerts/i,   d: ["M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9", "M13.7 21a2 2 0 01-3.4 0"] },
  { match: /prediction/i,               d: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M12 18a6 6 0 100-12 6 6 0 000 12z", "M12 14a2 2 0 100-4 2 2 0 000 4z"] },
  { match: /coinbase|premium/i,         d: ["M12 1v22", "M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"] },
  { match: /^ai on|htf|on-chain ai/i,   d: ["M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9z"] },
  { match: /markets|watchlist/i,        d: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M2 12h20", "M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"] },
  { match: /order book|order flow|heatmap/i, d: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"] },
  { match: /on-chain|funding|long\/short/i, d: ["M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7", "M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"] },
  { match: /traders|calculator/i,       d: ["M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2", "M9 11a4 4 0 100-8 4 4 0 000 8z", "M23 21v-2a4 4 0 00-3-3.9", "M16 3.1a4 4 0 010 7.8"] },
  { match: /news|whale/i,               d: ["M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a2 2 0 01-2 2zm0 0a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h2", "M18 14h-8", "M15 18h-5", "M10 6h8v4h-8z"] },
  { match: /paper trading/i,            d: ["M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z", "M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"] },
];
function FeatureIcon({ text }: { text: string }) {
  const d = FEATURE_ICONS.find((f) => f.match.test(text))?.d ?? ["M20 6L9 17l-5-5"];
  return (
    <svg className="upgrade-plan-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

// One-line pitch under each plan name (fallbacks for the locale keys).
const PLAN_TAGLINES: Record<string, string> = {
  free:  "Explore the markets and practice trading.",
  pro:   "AI insights and signals for active traders.",
  elite: "Unlimited AI plus your own trading agent.",
};

// Feature locale keys exclusive to each tier (used for "you'll lose" confirmation
// list). Elite no longer has its own feature set — pro now includes everything
// elite used to exclusively offer (Buy & Sell Signals, Inside the Candle,
// Coinbase Premium AI), so the only things left to lose by dropping from elite
// are the uncapped AI quota, early access, and Agent Ready (the live chat
// agent — kept elite-only since it burns through the AI quota far faster
// than any other feature, so it'd blow through pro's weekly cap in minutes).
const EXCLUSIVE_FEATURE_KEYS: Record<string, string[]> = {
  elite: ["upgradeModal.lf.elitePro", "upgradeModal.lf.agentReady", "upgradeModal.lf.earlyAccess"],
  pro:   ["upgradeModal.lf.buySignals", "upgradeModal.lf.candleai", "upgradeModal.lf.coinbase", "upgradeModal.lf.aiMkt", "upgradeModal.lf.onchain", "upgradeModal.lf.predChart", "upgradeModal.lf.liqHeatmap", "upgradeModal.lf.aiReqs"],
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

const LOCALIZED_LEGAL_LANGS = ["es", "it", "tr"];

// Counts a "$30.99"-style price up from 0 when the picker opens. Anything
// that isn't a plain $ amount (e.g. a localized App Store price) shows as-is.
function AnimatedPrice({ value, delay = 0 }: { value: string; delay?: number }) {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(value);
  const target = m ? parseFloat(m[1]) : null;
  const decimals = m && m[1].includes(".") ? m[1].split(".")[1].length : 0;
  const [shown, setShown] = useState(target === null ? value : `$${(0).toFixed(decimals)}`);
  useEffect(() => {
    if (target === null) { setShown(value); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || target === 0) {
      setShown(value); return;
    }
    let raf = 0;
    const start = performance.now() + delay;
    const dur = 900;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / dur));
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(`$${(target * eased).toFixed(decimals)}`);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, target, decimals, delay]);
  return <>{shown}</>;
}

// Pointer-follow tilt + glass highlight for a plan card (fine pointers
// only — touch just gets the press effect from CSS).
function tiltHandlers() {
  const fine = typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduce) return {};
  return {
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      el.style.setProperty("--mx", `${x * 100}%`);
      el.style.setProperty("--my", `${y * 100}%`);
      el.style.setProperty("--rx", `${(0.5 - y) * 6}deg`);
      el.style.setProperty("--ry", `${(x - 0.5) * 8}deg`);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    },
  };
}

export const UpgradeModal: React.FC<Props> = ({ onClose, onOpenAuth }) => {
  const { t, i18n } = useTranslation();
  const legalSuffix = LOCALIZED_LEGAL_LANGS.includes(i18n.language) ? `.${i18n.language}` : "";
  const { user, tier, profile, refreshProfile } = useAuth();
  const subStatus = profile?.subscription_status ?? "none";
  const isCanceling = subStatus === "canceling";
  const isPastDue   = subStatus === "past_due";
  const [loading,    setLoading]    = useState<string | null>(null);
  const [error,      setError]      = useState("");
  const [confirm,    setConfirm]    = useState<ConfirmState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done,       setDone]       = useState<{ message: string; sub: string } | null>(null);
  const [iapPlans,   setIapPlans]   = useState<IAPPlan[]>([]);
  // Which card is "in focus" — tap/click a card to bring it forward.
  // Starts on the most useful next step: Pro, or Elite for Pro members.
  const [focusPlan, setFocusPlan] = useState<string>(() => (tier === "pro" ? "elite" : tier === "elite" ? "elite" : "pro"));
  const plansRef = useRef<HTMLDivElement>(null);
  const iap = isIAPAvailable();

  // StoreKit's own purchase sheet replaces Stripe Checkout on iOS — Apple
  // requires digital subscriptions to go through In-App Purchase, not an
  // external processor. Fetched for any iOS user, not just free tier —
  // an existing Pro subscriber switching to Elite goes through this same
  // purchase sheet too (StoreKit/RevenueCat handle the proration/crossgrade
  // automatically within a subscription group); it's not Stripe-only.
  useEffect(() => {
    if (!iap) return;
    getIAPPlans().then(setIapPlans);
  }, [iap]);

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

  // A subscription can only be changed or cancelled from the platform that
  // actually sold it — Stripe (web) and Apple IAP (iOS) have no visibility
  // into each other. If the user is viewing from the *other* platform, block
  // every plan action here instead of letting them hit a confusing failure
  // (or, worse for an upgrade, end up buying a second, separate subscription).
  const actualProvider = subscriptionProvider(profile, tier);
  const providerMismatch = isPaid && actualProvider !== null && (
    (actualProvider === "apple"  && !iap) ||
    (actualProvider === "stripe" && iap)
  );

  const handlePlanClick = async (plan: typeof PLANS[number]) => {
    if (!user) { onClose(); onOpenAuth(); return; }
    if (providerMismatch) return; // UI already blocks this — safety net only
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

    // iOS → StoreKit's native purchase sheet, not Stripe's proration-preview
    // flow below (which requires a Stripe customer that an IAP subscriber
    // never has). This covers both a brand-new purchase and an existing
    // subscriber switching tiers — StoreKit/RevenueCat handle the
    // proration or scheduled crossgrade automatically within a
    // subscription group, the same way Apple's own Settings UI would.
    if (iap) {
      const iapPlan = iapPlans.find(p => p.tier === plan.id);
      if (!iapPlan) {
        setError("This plan isn't available for purchase right now. Please try again shortly.");
        return;
      }
      setLoading(plan.id);
      const result = await purchaseIAPPlan(iapPlan);
      if (result.cancelled) { setLoading(null); return; }
      if (!result.success) { setLoading(null); setError(result.error ?? t("upgradeModal.error")); return; }
      // Keep the loading state through this — the purchase sheet already
      // closed, so without it the modal would sit with no feedback.
      // Verify against RevenueCat directly rather than trusting the webhook
      // to have landed (or to land at all).
      const sync = await syncIAPEntitlement();
      if (!sync.tier) await waitForTier(user!.id, result.tier ?? (plan.id as Tier));
      await refreshProfile();
      setLoading(null);
      if (isPaid) {
        setDone(kind === "upgrade"
          ? { message: t("upgradeModal.success.upgradeMessage", { plan: planLabel }), sub: t("upgradeModal.success.iapUpgradeSub") }
          : { message: t("upgradeModal.success.downgradeMessage"), sub: t("upgradeModal.success.iapDowngradeSub") }
        );
      } else {
        onClose();
      }
      return;
    }

    const priceId = plan.priceId?.();
    if (!priceId) return;

    // New subscriber (web) → Stripe Checkout
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
        const { isUpgrade, scheduledAt, paymentSucceeded } = await upgradePlan(confirm.priceId!);
        if (isUpgrade && paymentSucceeded === false) {
          setDone({
            message: "Payment failed — your plan was not upgraded.",
            sub:     "Please update your payment method in billing settings and try again.",
          });
        } else if (isUpgrade) {
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
    if (providerMismatch) return; // UI already blocks this — safety net only
    // Apple subscriptions are managed in the OS, not this app — Stripe's
    // billing portal has no visibility into a StoreKit purchase at all.
    if (iap) {
      window.open("https://apps.apple.com/account/subscriptions", "_blank");
      return;
    }
    setLoading("portal");
    setError("");
    try { await redirectToBillingPortal(); }
    catch (e: any) { setError(e.message ?? t("upgradeModal.error")); setLoading(null); }
  };

  const handleRestorePurchases = async () => {
    setLoading("restore");
    setError("");
    const result = await restorePurchases();
    if (!result.success) { setLoading(null); setError(result.error ?? "Nothing to restore."); return; }
    const sync = await syncIAPEntitlement();
    if (!sync.tier && result.tier) await waitForTier(user!.id, result.tier);
    await refreshProfile();
    setLoading(null);
    setDone({
      message: "Purchases restored",
      sub: `Your ${result.tier === "elite" ? "Elite" : "Pro"} subscription is active again.`,
    });
  };

  const handleReactivate = async () => {
    if (providerMismatch) return; // UI already blocks this — safety net only
    setLoading("reactivate");
    setError("");
    try {
      await reactivateSubscription();
      setDone({
        message: t("upgradeModal.success.reactivateMessage"),
        sub:     t("upgradeModal.success.reactivateSub"),
      });
    } catch (e: any) {
      setError(e.message ?? t("upgradeModal.error"));
    } finally {
      setLoading(null);
    }
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

        {/* ── Wrong-platform screen: this subscription belongs to the other
              billing system (Stripe web vs Apple IAP) — block every plan
              action rather than risk a failed cancel or a second, duplicate
              subscription from an upgrade attempt. ── */}
        {providerMismatch ? (
          <div className="upgrade-confirm">
            <div className="upgrade-confirm-icon" style={{ color: "#38bdf8", fontSize: "2.8rem" }}>📱</div>
            <h2 className="upgrade-title">{t("upgradeModal.deviceMismatch.title")}</h2>
            <p className="upgrade-sub">
              {actualProvider === "apple" ? t("upgradeModal.deviceMismatch.appleBody") : t("upgradeModal.deviceMismatch.webBody")}
            </p>
            <button className="upgrade-plan-cta" style={{ maxWidth: 260, marginTop: 16 }} onClick={onClose}>
              {t("upgradeModal.deviceMismatch.gotIt")}
            </button>
          </div>
        ) : /* ── Success screen ── */
        done ? (
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

            <div className="upgrade-plans" ref={plansRef}>
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

                const planIndex = PLANS.indexOf(plan);
                return (
                  <div
                    key={plan.id}
                    className={`upgrade-plan${plan.popular ? " upgrade-plan--popular" : ""}${isCurrent ? " upgrade-plan--current" : ""}${focusPlan === plan.id ? " upgrade-plan--focus" : ""}`}
                    style={{ "--plan-color": plan.color, "--i": planIndex } as any}
                    onClick={() => setFocusPlan(plan.id)}
                    {...tiltHandlers()}
                  >
                    <span className="upgrade-plan-sheen" aria-hidden="true" />

                    {/* Name + one-line pitch */}
                    <div className="upgrade-plan-head">
                      <div className="upgrade-plan-label" style={{ color: plan.color }}>{planLabel}</div>
                      <p className="upgrade-plan-tagline">{t(`upgradeModal.plans.${plan.id}.tagline`, PLAN_TAGLINES[plan.id])}</p>
                    </div>

                    {/* Price, with the action right under it */}
                    <div className="upgrade-plan-price">
                      {/* Apple sets/rounds prices to its own tiers and requires
                          accurate display — show the real StoreKit price on
                          iOS when it's loaded, not the Stripe web price. */}
                      <span className="upgrade-plan-amount">
                        <AnimatedPrice
                          value={iap ? (iapPlans.find(p => p.tier === plan.id)?.priceString ?? plan.price) : plan.price}
                          delay={150 + planIndex * 90}
                        />
                      </span>
                      {plan.per && <span className="upgrade-plan-per">{t("upgradeModal.perMonth")}</span>}
                      {/* Status pill sits inside the card, beside the price. */}
                      {isCurrent ? (
                        <span className="upgrade-plan-pill upgrade-plan-pill--current">{t("upgradeModal.badges.yourPlan")}</span>
                      ) : plan.popular ? (
                        <span className="upgrade-plan-pill">{t("upgradeModal.badges.mostPopular")}</span>
                      ) : null}
                    </div>

                    {isCurrent ? (
                      <div className="upgrade-plan-current">{t("upgradeModal.cta.currentPlan")}</div>
                    ) : ctaLabel ? (
                      <button
                        className={`upgrade-plan-cta${isLower ? " upgrade-plan-cta--down" : ""}`}
                        style={isLower ? { background: plan.id === "free" ? "#ef4444" : "#f59e0b" } : undefined}
                        disabled={loading === plan.id}
                        onClick={() => handlePlanClick(plan)}
                      >
                        {loading === plan.id ? t("upgradeModal.cta.loading") : ctaLabel}
                      </button>
                    ) : <div className="upgrade-plan-cta-spacer" aria-hidden="true" />}

                    {plan.id === "elite" && (
                      <div className="upgrade-agent-callout">
                        <span className="upgrade-agent-callout-icon">
                          <span className="ta-trigger-orb" />
                        </span>
                        <div className="upgrade-agent-callout-text">
                          {/* "Agent Ready — Unlimited AI Trading Chat" →
                              small purple name above a plain headline. */}
                          {(() => {
                            const [name, rest] = t("upgradeModal.eliteCallout.title").split(" — ");
                            return (
                              <>
                                {rest && <span className="upgrade-agent-callout-name">{name}</span>}
                                <p className="upgrade-agent-callout-title">{rest ?? name}</p>
                              </>
                            );
                          })()}
                          <p className="upgrade-agent-callout-desc">{t("upgradeModal.eliteCallout.desc")}</p>
                        </div>
                      </div>
                    )}

                    {/* What's included — "Everything in X" becomes the
                        list's heading instead of a bullet. */}
                    <div className="upgrade-plan-divider" aria-hidden="true" />
                    {(() => {
                      const inherits = planFeatures[0]?.startsWith("Everything in") ? planFeatures[0] : null;
                      const items = inherits ? planFeatures.slice(1) : planFeatures;
                      return (
                        <>
                          <p className="upgrade-plan-includes">
                            {inherits ? `${inherits.split(" — ")[0]}, plus:` : "Includes:"}
                          </p>
                          <ul className="upgrade-plan-features">
                            {inherits && inherits.includes(" — ") && (
                              <li>
                                <span className="upgrade-plan-check"><FeatureIcon text={inherits.split(" — ")[1]} /></span>
                                {inherits.split(" — ")[1].replace(/^./, (c) => c.toUpperCase())}
                              </li>
                            )}
                            {items.map((f, fi) => (
                              <li key={f} style={{ "--fi": fi + (inherits && inherits.includes(" — ") ? 1 : 0) } as any}>
                                <span className="upgrade-plan-check"><FeatureIcon text={f} /></span>{f}
                              </li>
                            ))}
                          </ul>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>

            {isPastDue && (
              <div className="upgrade-pastdue-banner">
                <span>⚠️ {t("upgradeModal.pastDue.message")}</span>
                <button
                  className="upgrade-pastdue-btn"
                  onClick={handleManageBilling}
                  disabled={loading === "portal"}
                >
                  {loading === "portal" ? t("upgradeModal.footer.loadingPortal") : t("upgradeModal.pastDue.cta")}
                </button>
              </div>
            )}

            {error && <p className="upgrade-error">{error}</p>}


            <p className="upgrade-footer">
              {isPaid
                ? (iap
                    ? <button className="upgrade-manage-link" onClick={handleManageBilling}>Manage in App Store</button>
                    : <>{t("upgradeModal.footer.proratedNote")}<button className="upgrade-manage-link" onClick={handleManageBilling} disabled={loading === "portal"}>{loading === "portal" ? t("upgradeModal.footer.loadingPortal") : t("upgradeModal.footer.manageBilling")}</button></>)
                : t("upgradeModal.footer.cancelAnytime")
              }{iap ? t("upgradeModal.footer.securePaymentApple") : t("upgradeModal.footer.securePayment")}
              {/* Plain-text trust note (was its own icon row above the cards). */}
              {!isPaid && " · Instant access"}
              {/* Refund note and the subscription terms on the same line,
                  not their own paragraphs. */}
              {" · "}{t("upgradeModal.footer.noRefundNote")}
              {!isPaid && (
                <>
                  {" "}{iap ? t("upgradeModal.footer.subscriptionTermsApple") : t("upgradeModal.footer.subscriptionTermsWeb")}{" "}
                  <a href={`https://coinhintz.io/terms${legalSuffix}.html`} target="_blank" rel="noopener noreferrer" className="upgrade-manage-link">{t("upgradeModal.footer.termsLink")}</a>
                  {" · "}
                  <a href={`https://coinhintz.io/privacy${legalSuffix}.html`} target="_blank" rel="noopener noreferrer" className="upgrade-manage-link">{t("upgradeModal.footer.privacyLink")}</a>
                </>
              )}
            </p>
            {/* Required subscription disclosure (Apple Guideline 3.1.2 /
                Schedule 2): title, length, price, and auto-renewal terms are
                already shown above per-plan — this covers the rest, plus the
                Terms/Privacy links, directly on the purchase screen itself
                rather than only inside StoreKit's own sheet. */}

            {/* Apple subscriptions cancel/renew through the OS, not Stripe —
                this app has no visibility to drive that flow itself. */}
            {isPaid && iap && (
              <p className="upgrade-footer upgrade-footer--cancel">
                Cancel or change your plan any time in the App Store's subscription settings.
              </p>
            )}
            {isPaid && !iap && (
              isCanceling ? (
                <p className="upgrade-footer upgrade-footer--cancel">
                  {t("upgradeModal.canceling.note")}{" "}
                  <button
                    className="upgrade-manage-link"
                    style={{ color: "#4ade80" }}
                    onClick={handleReactivate}
                    disabled={loading === "reactivate"}
                  >
                    {loading === "reactivate" ? t("upgradeModal.cta.loading") : t("upgradeModal.canceling.reactivate")}
                  </button>
                </p>
              ) : (
                <p className="upgrade-footer upgrade-footer--cancel">
                  {t("upgradeModal.footer.wantToCancel")}{" "}
                  <button
                    className="upgrade-manage-link upgrade-manage-link--danger"
                    onClick={() => handlePlanClick(PLANS[0])}
                  >
                    {t("upgradeModal.footer.cancelLink")}
                  </button>
                </p>
              )
            )}
            {!isPaid && iap && (
              <p className="upgrade-footer upgrade-footer--cancel">
                Already subscribed on this Apple ID?{" "}
                <button
                  className="upgrade-manage-link"
                  onClick={handleRestorePurchases}
                  disabled={loading === "restore"}
                >
                  {loading === "restore" ? t("upgradeModal.cta.loading") : "Restore purchases"}
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
