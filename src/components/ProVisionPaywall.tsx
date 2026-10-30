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
import { getProVisionIAPPackage, isIAPAvailable, purchaseProVisionIAP, syncIAPEntitlement } from "../services/revenuecat";

export const PV_PLAN_PRICE = "$99";

const FEATURES: { title: string; text: string }[] = [
  { title: "Trend-painted chart", text: "Candles and an EMA ribbon coloured by trend, so direction is obvious at a glance." },
  { title: "Buy / Sell signals", text: "Labels where the trend flips, STRONG signals when every check agrees, take-profit marks." },
  { title: "Invalidation zone", text: "Where a signal is proven wrong, with real buy-vs-sell volume." },
  { title: "Live Signal Check", text: "Seven indicators, buyers vs sellers and five timeframes, updating every few seconds." },
  { title: "Safeguards", text: "Sideways-market detection, news-spike guard and macro-event pauses." },
  { title: "Honest track record", text: "Every past signal on the chart, scored after fees." },
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
}

function fmtWhen(ms: number): string {
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export function ProVisionPaywall({
  open, onClose, reason, nextFreeAt, coin, busy, error,
  onStartTrial, onBuyPlan, onUpgradeElite, onSignIn,
}: Props) {
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
    <BottomSheet
      open={open}
      onClose={onClose}
      ariaLabel="ProVision"
      className="pvp-sheet"
      desktopModal
    >
      <div className="pvp">
        <div className="pvp-hero">
          <span className="pvp-orb" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
          </span>
          <span className="pvp-kicker">{head.kicker}</span>
          <h2 className="pvp-title">{head.title}</h2>
          <p className="pvp-sub">{sub}</p>
        </div>

        <ul className="pvp-list">
          {FEATURES.map((f) => (
            <li key={f.title} className="pvp-item">
              <span className="pvp-check" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
              </span>
              <span><strong>{f.title}.</strong> {f.text}</span>
            </li>
          ))}
        </ul>

        <div className="pvp-actions">
          {reason === "signin" && (
            <button type="button" className="pvp-cta" onClick={onSignIn} disabled={busy}>
              Sign up to start your free trial
            </button>
          )}
          {reason === "trial-available" && (
            <button type="button" className="pvp-cta" onClick={onStartTrial} disabled={busy}>
              {busy ? "Starting…" : `Start ${PV_TRIAL_DAYS}-day free trial`}
            </button>
          )}
          {(reason === "trial-ended" || reason === "trial-active" || reason === "pro-limit") && (
            <button type="button" className="pvp-cta" onClick={onBuyPlan} disabled={busy}>
              {busy ? "Opening…" : <>Get ProVision · {PV_PLAN_PRICE}/year</>}
            </button>
          )}
          {reason === "pro-limit" && (
            <button type="button" className="pvp-alt" onClick={onUpgradeElite} disabled={busy}>
              Or go Elite: ProVision included
            </button>
          )}
          {(reason === "signin" || reason === "trial-available") && (
            <span className="pvp-fine">Then {PV_PLAN_PRICE}/year if you keep it. Cancel anytime.</span>
          )}
          {error && <span className="pvp-error" role="alert">{error}</span>}
          <span className="pvp-fine">Signals are tools, not financial advice.</span>
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

  const close = () => { if (!busy) setReq(null); };

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

  return (
    <ProVisionPaywall
      open={!!req}
      onClose={close}
      reason={req?.reason ?? "trial-available"}
      coin={req?.coin}
      nextFreeAt={access.nextFreeAt}
      busy={busy}
      error={error}
      onStartTrial={startTrial}
      onBuyPlan={buyPlan}
      onUpgradeElite={() => { setReq(null); onOpenUpgrade(); }}
      onSignIn={() => { setReq(null); onOpenAuth(); }}
    />
  );
}
