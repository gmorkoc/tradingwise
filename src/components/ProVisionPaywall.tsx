// ProVision sales sheet — opens from the ProVision switches, and when a Pro
// user moves to a 4th coin in 24h. What it offers depends on why it opened:
//   signin           → sign up to start the 3-day free trial
//   trial-available  → start the 3-day free trial
//   trial-ended      → buy the ProVision plan ($99/yr)
//   pro-limit        → buy the plan for unlimited, or move up to Elite
import { useEffect, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import type { PvLockReason } from "../hooks/useProVisionAccess";
import { PV_PRO_COINS_PER_DAY, PV_TRIAL_DAYS } from "../hooks/useProVisionAccess";
import { onProVisionPaywall, useProVisionGate } from "../hooks/useProVisionGate";
import { useAuth } from "../contexts/AuthContext";
import { startProVisionTrial } from "../services/supabase";
import { PROVISION_PRICE_ID, redirectToCheckout } from "../services/stripeService";
import { getProVisionIAPPackage, isIAPAvailable, purchaseProVisionIAP, restoreProVisionIAP, syncIAPEntitlement } from "../services/revenuecat";
import { useStorePrices } from "../hooks/useStorePrices";
import { useTranslation } from "react-i18next";
import "../styles/MembershipGate.css";
import "../styles/PaywallPromo.css";
import { useAuthFirst } from "../hooks/useAuthFirst";

// Terms / Privacy pages exist in these languages (same as UpgradeModal).
const LOCALIZED_LEGAL_LANGS = ["es", "it", "tr"];

const FEATURES: { title: string; text: string; icon: React.ReactNode }[] = [
  { title: "Trend-painted chart", text: "Candles and an EMA ribbon coloured by trend, so direction is obvious at a glance.", icon: <><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h5v5" /></> },
  { title: "Buy / Sell signals", text: "Labels where the trend flips, STRONG signals when every check agrees, take-profit marks.", icon: <><path d="M7 17V7M17 7v10" /><path d="m4 10 3-3 3 3M14 14l3 3 3-3" /></> },
  { title: "Invalidation zone", text: "Where a signal is proven wrong, with real buy-vs-sell volume.", icon: <><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 12h10" /></> },
  { title: "Live Signal Check", text: "Seven indicators, buyers vs sellers and five timeframes, updating every few seconds.", icon: <><path d="M12 20a8 8 0 1 1 8-8" /><path d="M12 12l4-4" /></> },
  { title: "Safeguards", text: "Sideways-market detection, news-spike guard and macro-event pauses.", icon: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></> },
  { title: "Honest track record", text: "Every past signal on the chart, scored after fees.", icon: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></> },
];

interface Props {
  open: boolean;
  onClose: () => void;
  reason: PvLockReason;
  /** Pro at the limit: when a coin slot frees up again (ms). */
  nextFreeAt?: number | null;
  /** Coin the user tried to open (for the Pro-limit message). */
  coin?: string;
  busy?: boolean;
  error?: string | null;
  onStartTrial: () => void;
  onBuyPlan: () => void;
  onUpgradeElite: () => void;
  onSignIn: () => void;
  /** iOS: restore an earlier App Store purchase. */
  onRestore?: () => void;
}

function fmtWhen(ms: number): string {
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export function ProVisionPaywall({
  open, onClose, reason, nextFreeAt, coin, busy, error,
  onStartTrial, onBuyPlan, onUpgradeElite, onSignIn, onRestore,
}: Props) {
  // App Store price in the user's currency on iOS; $99 elsewhere.
  const PV_PLAN_PRICE = useStorePrices().provision;
  const { i18n } = useTranslation();
  const legalSuffix = LOCALIZED_LEGAL_LANGS.includes(i18n.language) ? `.${i18n.language}` : "";
  const iap = isIAPAvailable();
  const head =
    reason === "pro-limit"
      ? { kicker: `${PV_PRO_COINS_PER_DAY} of ${PV_PRO_COINS_PER_DAY} coins used today`, title: "Unlimited ProVision" }
      : reason === "trial-ended"
        ? { kicker: "Your free trial has ended", title: "Keep ProVision" }
        : reason === "trial-active"
          ? { kicker: "Free trial running", title: "Keep ProVision" }
        : { kicker: `${PV_TRIAL_DAYS} days free`, title: "Try ProVision" };

  const sub =
    reason === "pro-limit"
      ? `Pro includes ProVision on ${PV_PRO_COINS_PER_DAY} coins a day${coin ? `, so ${coin} is locked for now` : ""}.${nextFreeAt ? ` A slot frees up in ${fmtWhen(nextFreeAt)}.` : ""}`
      : reason === "trial-ended" || reason === "trial-active"
        ? "Get every coin and timeframe with the ProVision plan."
        : `Full ProVision on every coin and timeframe for ${PV_TRIAL_DAYS} days. No card needed.`;

  return (
    // Same card as the Pro / Elite upgrade popup (BlurGate's .bg-elite-card,
    // laid out by PaywallPromo.css), in ProVision purple.
    <BottomSheet
      open={open}
      onClose={onClose}
      ariaLabel="ProVision"
      className="paywall-promo-sheet paywall-promo-sheet--pv"
      desktopModal
    >
      <div className="bg-root bg-root--promo">
        <div className="bg-overlay">
          <div className="bg-elite-card bg-elite-card--pv">
            {/* Top bar: badge + price */}
            <div className="bg-elite-top">
              <div className="bg-elite-badge">✦ PROVISION</div>
              <div className="bg-elite-price-wrap">
                <span className="bg-elite-price">{PV_PLAN_PRICE}</span>
                <span className="bg-elite-per">/yr</span>
              </div>
            </div>

            {/* Headline */}
            <div className="bg-elite-headline">
              <span className="bg-elite-eyebrow">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                {head.kicker}
              </span>
              <h3>{head.title}</h3>
              <p>{sub}</p>
            </div>

            {/* Feature grid */}
            <div className="bg-elite-features">
              {FEATURES.map((f) => (
                <div key={f.title} className="bg-elite-feature">
                  <span className="bg-elite-feat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{f.icon}</svg>
                  </span>
                  <div>
                    <p className="bg-elite-feat-title">{f.title}</p>
                    <p className="bg-elite-feat-desc">{f.text}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* CTA */}
            {reason === "signin" && (
              <button type="button" className="bg-elite-cta bg-elite-cta--pv" onClick={onSignIn} disabled={busy}>
                Sign up to start your free trial
              </button>
            )}
            {reason === "trial-available" && (
              <button type="button" className="bg-elite-cta bg-elite-cta--pv" onClick={onStartTrial} disabled={busy}>
                {busy ? "Starting…" : `Start ${PV_TRIAL_DAYS}-day free trial`}
              </button>
            )}
            {(reason === "trial-ended" || reason === "trial-active" || reason === "pro-limit") && (
              <button type="button" className="bg-elite-cta bg-elite-cta--pv" onClick={onBuyPlan} disabled={busy}>
                {busy ? "Opening…" : <>{reason === "trial-ended" ? "Keep ProVision" : "Get ProVision"} — {PV_PLAN_PRICE}/year</>}
              </button>
            )}
            {error && <p className="bg-pv-error" role="alert">{error}</p>}

            <p className="bg-card-trust bg-card-trust--split">
              <span>
                {reason === "signin" || reason === "trial-available"
                  ? `${PV_TRIAL_DAYS} days free · then ${PV_PLAN_PRICE}/year`
                  : iap
                    // App Store: Apple handles billing and refunds.
                    ? `${PV_PLAN_PRICE}/year, billed via your Apple ID · renews automatically unless cancelled at least 24 hours before the period ends · cancel anytime in Settings`
                    : "Billed once a year · non-refundable"}
              </span>
              {reason === "pro-limit" ? (
                <button type="button" className="bg-elite-link" onClick={onUpgradeElite} disabled={busy}>
                  Or go <span className="bg-elite-link-word">Elite</span>: ProVision included
                </button>
              ) : (
                <span>Signals are tools, not financial advice.</span>
              )}
            </p>
            {/* Required on subscription screens (App Store 3.1.2): Terms,
                Privacy, and on iOS a way to restore an earlier purchase. */}
            <p className="bg-card-trust bg-pv-legal">
              <a href={`https://coinhintz.io/terms${legalSuffix}.html`} target="_blank" rel="noopener noreferrer">Terms of Use</a>
              {" · "}
              <a href={`https://coinhintz.io/privacy${legalSuffix}.html`} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
              {iap && onRestore && (
                <>
                  {" · "}
                  <button type="button" className="bg-pv-restore" onClick={onRestore} disabled={busy}>Restore purchases</button>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}

/**
 * Mounted once in App. Listens for openProVisionPaywall() from any switch
 * or the chart, and runs the actual trial start / purchase.
 */
export function ProVisionPaywallHost({ onOpenAuth, onOpenUpgrade }: { onOpenAuth: () => void; onOpenUpgrade: () => void }) {
  const { refreshProfile } = useAuth();
  const { setOn, access } = useProVisionGate();
  const [req, setReq] = useState<{ reason: PvLockReason; coin?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onProVisionPaywall((r) => { setError(null); setReq(r); }), []);

  // Opened signed out ("sign in to try") → once signed in and the profile
  // has loaded, show the offer that fits this account instead — or close
  // and switch ProVision on if the plan already includes it.
  const { user, profile, profileLoading } = useAuth();
  useEffect(() => {
    // Wait for THIS account's profile (its tier decides the offer).
    if (!req || req.reason !== "signin" || !user || profileLoading || profile?.id !== user.id) return;
    const reason = access.lockReason(req.coin ?? "BTC");
    if (!reason) { setReq(null); setOn(true); return; }
    if (reason !== "signin") setReq({ ...req, reason });
  }, [req, user, profile, profileLoading, access, setOn]);

  const close = () => { if (!busy) setReq(null); };
  // Signed out → open the sign-in window instead of the paywall; the
  // effect below swaps in the right offer once signed in. Dismissing
  // sign-in closes the request.
  useAuthFirst(req?.reason === "signin", onOpenAuth, () => setReq(null));

  const startTrial = async () => {
    setBusy(true); setError(null);
    try {
      const started = await startProVisionTrial();
      if (!started) throw new Error("The free trial isn't available on this account.");
      await refreshProfile();
      setOn(true);
      setReq(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the trial. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const buyPlan = async () => {
    setBusy(true); setError(null);
    try {
      if (isIAPAvailable()) {
        const found = await getProVisionIAPPackage();
        if (!found) throw new Error("ProVision isn't available in the App Store yet. Please try again later.");
        const res = await purchaseProVisionIAP(found.pkg);
        if (res.cancelled) return;
        if (!res.success) throw new Error(res.error ?? "Purchase failed");
        await syncIAPEntitlement();
        await refreshProfile();
        setOn(true);
        setReq(null);
        return;
      }
      if (!PROVISION_PRICE_ID) throw new Error("ProVision checkout isn't set up yet.");
      await redirectToCheckout(PROVISION_PRICE_ID); // returns via ?payment=success
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true); setError(null);
    try {
      const res = await restoreProVisionIAP();
      if (!res.success) throw new Error(res.error ?? "Nothing to restore.");
      await syncIAPEntitlement();
      await refreshProfile();
      setOn(true);
      setReq(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restore. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProVisionPaywall
      open={!!req && req.reason !== "signin"}
      onRestore={restore}
      onClose={close}
      reason={req?.reason ?? "trial-available"}
      coin={req?.coin}
      nextFreeAt={access.nextFreeAt}
      busy={busy}
      error={error}
      onStartTrial={startTrial}
      onBuyPlan={buyPlan}
      onUpgradeElite={() => { setReq(null); onOpenUpgrade(); }}
      // Stays open under the sign-in window; the effect above swaps in the
      // signed-in offer (or closes it if the plan already covers it).
      onSignIn={() => { onOpenAuth(); }}
    />
  );
}
