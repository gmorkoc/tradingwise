// Full-screen plan screen for phones (iOS app and mobile web): ✕ top-left,
// logo, two-line headline, a card with the benefits list (Pro | Elite tabs
// for the tiers), and the price, button and legal text pinned to the
// bottom. Used for the Pro/Elite promos (TierPlanSheet) and ProVision
// (ProVisionPaywall).
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { useStorePrices } from "../hooks/useStorePrices";
import { PRICE_IDS, redirectToCheckout } from "../services/stripeService";
import { getIAPPlans, isIAPAvailable, purchaseIAPPlan, restorePurchases, syncIAPEntitlement } from "../services/revenuecat";
import "../styles/PlanSheet.css";

const LEGAL_LANGS = ["es", "it", "tr"];

/** True on phone-width screens (where the plan screen is used). */
export function usePhoneWidth(): boolean {
  const q = "(max-width: 900px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

// Line icons for the benefits list (24×24, stroke).
const ICONS: Record<string, ReactNode> = {
  candle: <><path d="M9 4v3M9 17v3M15 2v4M15 14v4" /><rect x="6.5" y="7" width="5" height="10" rx="1" /><rect x="12.5" y="6" width="5" height="8" rx="1" /></>,
  spark: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />,
  trend: <><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h5v5" /></>,
  chain: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" />,
  camera: <><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13.5" r="3.5" /><path d="M8 7l1.5-3h5L16 7" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  options: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  gauge: <><path d="M12 14l4-4" /><path d="M3.3 17a10 10 0 1 1 17.4 0" /></>,
  orb: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>,
  infinity: <path d="M7 8.5c-2 0-3.5 1.6-3.5 3.5S5 15.5 7 15.5c3.5 0 6.5-7 10-7 2 0 3.5 1.6 3.5 3.5S19 15.5 17 15.5c-3.5 0-6.5-7-10-7z" />,
  rocket: <><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" /><path d="M9 15l-3-3c1-4 4.5-9 13-9 0 8.5-5 12-9 13z" /><circle cx="15" cy="9" r="1.5" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  arrows: <><path d="M7 17V7M17 7v10" /><path d="m4 10 3-3 3 3M14 14l3 3 3-3" /></>,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  band: <><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 12h10" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  bars: <><path d="M4 20V12M10 20V6M16 20v-9M2 20h20" /></>,
};

export interface PlanFeature { key: string; icon: keyof typeof ICONS; label: string }
export interface PlanPrice { amount: string; period: string; sub?: string; badge?: string }

interface ShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTab?: (id: string) => void;
  intro: string;
  benefits: string;
  features: PlanFeature[];
  price: PlanPrice;
  cta: { label: string; onClick: () => void; disabled?: boolean };
  /** Small link under the button (e.g. "Or go Elite"). */
  secondary?: ReactNode;
  error?: string | null;
  /** Text after "you agree to the Terms of Use and Privacy Policy". */
  legalTail: string;
  onRestore?: () => void;
  busy?: boolean;
  /** "pro" | "elite" | "pv" — the plan's colours (pill, price card, button). */
  tone: string;
  /** Plan name at the top, e.g. "Elite Plan" (shown in capitals). */
  badgeLabel: string;
}

export function PlanSheet(p: ShellProps) {
  const { t, i18n } = useTranslation();
  const legalSuffix = LEGAL_LANGS.includes(i18n.language) ? `.${i18n.language}` : "";
  const { onClose } = p;
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("ps-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("ps-open");
    };
  }, [p.open, onClose]);
  if (!p.open) return null;

  return createPortal(
    <div className={`ps-root ps-root--${p.tone}`} role="dialog" aria-modal="true" aria-label={p.title}>
      <div className="ps-top">
        <button type="button" className="ps-close" onClick={p.onClose} aria-label={t("planSheet.close")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <span className="ps-tier-name">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z" />
          </svg>
          <span className="ps-tier-word">{p.badgeLabel}</span>
        </span>
        <span aria-hidden="true" />
      </div>
      <h2 className="ps-title">{p.title}</h2>

      <div className="ps-card">
        {p.tabs && p.tabs.length > 1 && (
          <div className="ps-tabs" role="tablist">
            {p.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={p.activeTab === tab.id}
                className={`ps-tab${p.activeTab === tab.id ? " ps-tab--on" : ""}`}
                onClick={() => p.onTab?.(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div className="ps-scroll">
          <p className="ps-intro">{p.intro}</p>
          <p className="ps-benefits"><span className="ps-benefits-mark">✦</span> {p.benefits}</p>
          <ul className="ps-list">
            {p.features.map((f) => (
              <li key={f.key}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS[f.icon]}
                </svg>
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="ps-bottom">
        <div className="ps-price" aria-current="true">
          <div>
            <span className="ps-amount">{p.price.amount}</span>
            <span className="ps-period"> {p.price.period}</span>
          </div>
          {(p.price.sub || p.price.badge) && (
            <div className="ps-price-sub">
              {p.price.sub && <span>{p.price.sub}</span>}
              {p.price.badge && <span className="ps-badge">{p.price.badge}</span>}
            </div>
          )}
        </div>
        <button type="button" className="ps-cta" onClick={p.cta.onClick} disabled={p.cta.disabled || p.busy}>
          {p.busy ? t("planSheet.working") : p.cta.label}
        </button>
        {p.secondary}
        {p.error && <p className="ps-error" role="alert">{p.error}</p>}
        <p className="ps-legal">
          {t("planSheet.legalPre", { cta: p.cta.label })}
          <a href={`https://coinhintz.io/terms${legalSuffix}.html`} target="_blank" rel="noopener noreferrer">{t("planSheet.terms")}</a>
          {t("planSheet.and")}
          <a href={`https://coinhintz.io/privacy${legalSuffix}.html`} target="_blank" rel="noopener noreferrer">{t("planSheet.privacy")}</a>
          {p.legalTail}
          {p.onRestore && (
            <>
              {" "}
              <button type="button" className="ps-restore" onClick={p.onRestore} disabled={p.busy}>{t("planSheet.restore")}</button>
            </>
          )}
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ── Pro / Elite ──────────────────────────────────────────────────────────

const PRO_FEATURES: PlanFeature["key"][] = [
  "candleInsights", "aiAnalysis", "predictions", "onchain", "assistant",
  "altAnalysis", "options", "correlation", "strategyAlerts", "pvCoins", "aiQuota",
];
const PRO_ICONS: Record<string, PlanFeature["icon"]> = {
  candleInsights: "candle", aiAnalysis: "spark", predictions: "trend", onchain: "chain",
  assistant: "chat", analyzeChart: "camera", altAnalysis: "layers", options: "options",
  correlation: "grid", strategyAlerts: "bell", pvCoins: "eye", aiQuota: "gauge",
};
const ELITE_FEATURES: [string, PlanFeature["icon"]][] = [
  ["agent", "orb"], ["unlimitedAi", "infinity"], ["unlimitedPv", "eye"],
  ["earlyAccess", "rocket"], ["everythingPro", "check"],
];

type TierTab = "pro" | "elite";

/**
 * Pro | Elite plan screen. Opens on the plan being promoted (its tab
 * first); the other plan is one tap away.
 */
export function TierPlanSheet({ open, onClose, promoted, onOpenAuth, withAnalyzeChart }: {
  open: boolean;
  onClose: () => void;
  promoted: TierTab;
  onOpenAuth: () => void;
  /** Adds "Analyze a chart" to the top of the Pro list. */
  withAnalyzeChart?: boolean;
}) {
  const { t } = useTranslation();
  const { user, tier, refreshProfile } = useAuth();
  const prices = useStorePrices();
  const iap = isIAPAvailable();
  const [tab, setTab] = useState<TierTab>(promoted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setTab(promoted); setError(null); } }, [open, promoted]);

  const tabs = (promoted === "elite" ? ["elite", "pro"] : ["pro", "elite"]).map((id) => ({
    id, label: id === "elite" ? "Elite" : "Pro",
  }));

  const proKeys = withAnalyzeChart ? ["analyzeChart", ...PRO_FEATURES] : PRO_FEATURES;
  const features: PlanFeature[] = tab === "pro"
    ? proKeys.map((k) => ({ key: k, icon: PRO_ICONS[k], label: t(`planSheet.features.${k}`) }))
    : ELITE_FEATURES.map(([k, icon]) => ({ key: k, icon, label: t(`planSheet.features.${k}`) }));

  const current = tier === tab;
  const included = tab === "pro" && tier === "elite";
  const ctaLabel = current ? t("planSheet.ctaCurrent") : included ? t("planSheet.ctaIncluded") : t(tab === "pro" ? "planSheet.ctaPro" : "planSheet.ctaElite");

  const buy = async () => {
    if (!user) { onOpenAuth(); return; }
    setError(null);
    // Already on a paid plan (Pro → Elite): the full upgrade screen handles
    // proration and which store the plan was bought in.
    if (tier !== "free") {
      onClose();
      window.dispatchEvent(new Event("open-upgrade-modal"));
      return;
    }
    setBusy(true);
    try {
      if (iap) {
        const plan = (await getIAPPlans()).find((pl) => pl.tier === tab);
        if (!plan) { setError(t("planSheet.errStore")); return; }
        const res = await purchaseIAPPlan(plan);
        if (res.cancelled) return;
        if (!res.success) { setError(res.error ?? t("planSheet.errPurchase")); return; }
        await syncIAPEntitlement();
        await refreshProfile();
        onClose();
        return;
      }
      await redirectToCheckout(PRICE_IDS[tab]);
    } catch {
      setError(t("planSheet.errPurchase"));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true); setError(null);
    try {
      const res = await restorePurchases();
      if (!res.success) { setError(t("planSheet.errNothing")); return; }
      await syncIAPEntitlement();
      await refreshProfile();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlanSheet
      open={open}
      onClose={onClose}
      tone={tab}
      badgeLabel={t("planSheet.tierPlan", { tier: tab === "pro" ? "Pro" : "Elite" })}
      title={t(tab === "pro" ? "planSheet.titlePro" : "planSheet.titleElite")}
      tabs={tabs}
      activeTab={tab}
      onTab={(id) => { setTab(id as TierTab); setError(null); }}
      intro={t(tab === "pro" ? "planSheet.introPro" : "planSheet.introElite")}
      benefits={t(tab === "pro" ? "planSheet.benefitsPro" : "planSheet.benefitsElite")}
      features={features}
      price={{
        amount: tab === "pro" ? prices.pro : prices.elite,
        period: t("planSheet.monthly"),
        sub: t(tab === "pro" ? "planSheet.aiWeekly" : "planSheet.includesPro"),
      }}
      cta={{ label: ctaLabel, onClick: buy, disabled: current || included }}
      error={error}
      busy={busy}
      legalTail={t(iap ? "planSheet.legalApple" : "planSheet.legalWeb")}
      onRestore={iap ? restore : undefined}
    />
  );
}
