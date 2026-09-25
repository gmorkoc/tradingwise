import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Avatar } from "./Avatar";
import { useAuth } from "../contexts/AuthContext";
import { toggleMutedSignalCoin } from "../services/supabase";
import "../styles/PushToast.css";

const IS_IOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

interface SignalHit { id: string; label: string; value?: number }
type Direction = "buy" | "sell";
type Confidence = "low" | "medium" | "high";

interface PushToastData {
  type?: string;
  url?: string;
  coin?: string;
  commentId?: string;
  avatarUrl?: string;
  username?: string;
  strategyId?: string;
  // Real structured data (not the FCM-style string-only payload the native
  // push path is stuck with) — only ever set by the web Realtime path
  // (useBuySignalRealtime.ts), which has the full row to work with. Native
  // buy-signal pushes fall back to the plain title/body layout below since
  // the OS notification payload never carried this.
  price?: number;
  signals?: SignalHit[];
  direction?: Direction;
  score?: number;
  maxScore?: number;
  confidence?: Confidence;
}

interface PushToastDetail {
  title: string;
  body: string;
  data?: PushToastData;
}

// 3 minutes instead of the old 6s — this now covers a genuinely
// action-worth-noticing alert (a buy/sell signal), not just an FYI, so it
// stays up long enough to actually notice without demanding an instant
// reaction. The close button (already there) covers "I saw it, dismiss it
// now."
const DURATION = 180_000;

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function confidenceLabel(c: Confidence | undefined): string {
  if (c === "high") return "High";
  if (c === "medium") return "Medium";
  return "Low";
}

// Shown on every buy/sell-signal toast, every platform — same posture as
// the Buy Signals panel's own disclaimer, restated here since this is
// often the very first place someone sees a signal (a push/toast arrives
// before they've ever opened the panel itself).
const INVESTMENT_DISCLAIMER = "For informational purposes only. Not investment advice — all trading decisions are made at your own risk.";

// Rendered once at the app root. pushNotifications.ts dispatches
// "push-toast" for any push received while the app is in the foreground
// (the OS banner is suppressed for those — see capacitor.config.ts) so the
// user still sees something, just in-app instead of a system banner.
export function PushToast() {
  const { user, profile, refreshProfile } = useAuth();
  const [toast, setToast] = useState<PushToastDetail | null>(null);
  const [logoError, setLogoError] = useState(false);
  const [watchlisted, setWatchlisted] = useState(false);
  const [muting, setMuting] = useState(false);
  const [justMuted, setJustMuted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onPush = (e: Event) => {
      const detail = (e as CustomEvent<PushToastDetail>).detail;
      setToast(detail);
      setLogoError(false);
      setWatchlisted(false);
      setJustMuted(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setToast(null), DURATION);
    };
    window.addEventListener("push-toast", onPush);
    return () => window.removeEventListener("push-toast", onPush);
  }, []);

  if (!toast) return null;

  const data = toast.data;

  const handleTap = () => {
    if ((data?.type === "daily_brief" || data?.type === "breaking_news") && data.url) {
      Browser.open({ url: data.url });
    } else if (data?.type === "upgrade_reminder") {
      window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
    } else if (data?.type === "coin_mention" && data.coin && data.commentId) {
      window.dispatchEvent(new CustomEvent("open-coin-mention", {
        detail: { coin: data.coin, commentId: parseInt(data.commentId, 10) },
      }));
    } else if (data?.type === "strategy_alert" && data.strategyId) {
      window.dispatchEvent(new CustomEvent("open-strategy-alert", {
        detail: { strategyId: data.strategyId, coin: data.coin },
      }));
    } else if (data?.type === "buy_signal") {
      window.dispatchEvent(new CustomEvent("open-buy-signals", { detail: { coin: data.coin } }));
    }
    setToast(null);
  };

  // Adds straight to the localStorage-backed watchlist (Watchlist.tsx's own
  // store — there's no server-side watchlist) and tells any mounted
  // Watchlist to pick it up live instead of only on its next mount.
  const handleAddToWatchlist = (e: React.MouseEvent) => {
    e.stopPropagation();
    const coin = data?.coin;
    if (!coin) return;
    try {
      const saved = JSON.parse(localStorage.getItem("watchlistCoins_v1") ?? "null");
      const current: string[] = Array.isArray(saved) ? saved : [];
      if (!current.includes(coin)) {
        localStorage.setItem("watchlistCoins_v1", JSON.stringify([...current, coin]));
        window.dispatchEvent(new CustomEvent("watchlist-add", { detail: { coin } }));
      }
    } catch { /* localStorage unavailable — best effort, button still flips */ }
    setWatchlisted(true);
  };

  const handleMute = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const coin = data?.coin;
    if (!coin || !user || muting) return;
    setMuting(true);
    try {
      await toggleMutedSignalCoin(user.id, coin, profile?.signal_muted_coins ?? []);
      await refreshProfile();
      setJustMuted(true);
    } catch (err) {
      console.error("Failed to mute signal coin from toast:", err);
    } finally {
      setMuting(false);
    }
  };

  const isBuySignal = data?.type === "buy_signal";
  const direction: Direction = data?.direction ?? "buy";
  const isSell = direction === "sell";
  const signalLabel = isSell ? "Sell Signal" : "Buy Signal";
  const alreadyMuted = !!data?.coin && (profile?.signal_muted_coins ?? []).includes(data.coin);
  // Only the web Realtime path sends the full breakdown — a native push
  // (title/body only) still gets the plain layout further down.
  const hasBuySignalDetail = isBuySignal && data?.coin && data?.signals && data.signals.length > 0;

  const ActionButtons = ({ compact }: { compact?: boolean }) => (
    <div className={`push-toast-actions${compact ? " push-toast-actions--compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="push-toast-action-btn" onClick={handleAddToWatchlist} disabled={watchlisted}>
        {watchlisted ? "✓ Watchlisted" : "+ Watchlist"}
      </button>
      <button type="button" className="push-toast-action-btn push-toast-action-btn--mute" onClick={handleMute} disabled={muting || justMuted || alreadyMuted}>
        {justMuted || alreadyMuted ? "Muted" : `Mute ${data?.coin ?? ""}`}
      </button>
    </div>
  );

  if (hasBuySignalDetail) {
    const coin = data!.coin!;
    const signals = data!.signals!;
    const maxScore = data?.maxScore ?? 7;
    const score = data?.score ?? signals.length;
    const confidence = data?.confidence ?? (score >= 6 ? "high" : score >= 5 ? "medium" : "low");
    const priceStr = data?.price != null
      ? `$${data.price.toLocaleString(undefined, { maximumFractionDigits: data.price < 1 ? 6 : 2 })}`
      : null;

    // iOS gets a bigger, bolder half-screen bottom sheet (drag handle,
    // slides up, glowing coin logo, score badge, chip-style signal rows)
    // instead of the compact top-anchored card every other platform gets
    // — matches the native "detail sheet" pattern iOS users already
    // expect (Daily Brief's own mobile sheet does the same), with real
    // presence instead of a web-style toast bolted onto a native app.
    if (IS_IOS) {
      return ReactDOM.createPortal(
        <div className={`push-toast push-toast--buy-signal push-toast--sheet${isSell ? " push-toast--sell" : ""}`} onClick={handleTap} role="alert">
          <div className="push-toast-sheet-handle" />
          <button className="push-toast-close push-toast-close--rich" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>

          <div className="push-toast-sheet-hero">
            <div className="push-toast-sheet-logo-ring">
              <div className="push-toast-coin-logo push-toast-coin-logo--lg">
                {!logoError ? (
                  <img
                    src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                    alt=""
                    onError={() => setLogoError(true)}
                  />
                ) : (
                  <span className="push-toast-coin-logo-fallback">{coin[0] ?? "?"}</span>
                )}
              </div>
            </div>
            <span className="push-toast-eyebrow">{signalLabel}</span>
            <span className="push-toast-sheet-pair">
              {coin} / USD
              {priceStr && <span className="push-toast-sheet-price">{priceStr}</span>}
            </span>
            {/* Confidence = confluence strength (how many of the 7
                conditions agree), not a probability — this has never been
                backtested, so it's never framed as "how likely this is
                right." */}
            <span className={`push-toast-sheet-confidence${confidence === "high" ? " push-toast-sheet-confidence--strong" : ""}`}>
              {score}/{maxScore} · {confidenceLabel(confidence)} confidence
            </span>
          </div>

          <div className="push-toast-signals push-toast-signals--chips">
            {signals.map((s) => (
              <div key={s.id} className="push-toast-signal-chip">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                <span>{s.label}</span>
              </div>
            ))}
          </div>

          <ActionButtons />
          <p className="push-toast-disclaimer">{INVESTMENT_DISCLAIMER}</p>
        </div>,
        document.body
      );
    }

    return ReactDOM.createPortal(
      <div className={`push-toast push-toast--buy-signal push-toast--rich${isSell ? " push-toast--sell" : ""}`} onClick={handleTap} role="alert">
        <button className="push-toast-close push-toast-close--rich" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
        <div className="push-toast-rich-head">
          <div className="push-toast-coin-logo">
            {!logoError ? (
              <img
                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                alt=""
                onError={() => setLogoError(true)}
              />
            ) : (
              <span className="push-toast-coin-logo-fallback">{coin[0] ?? "?"}</span>
            )}
          </div>
          <div className="push-toast-rich-name">
            <span className="push-toast-eyebrow">{signalLabel}</span>
            <span className="push-toast-coin-pair">
              {coin} / USD
              {priceStr && <span className="push-toast-coin-price">{priceStr}</span>}
            </span>
          </div>
          <span className={`push-toast-confidence${confidence === "high" ? " push-toast-confidence--strong" : ""}`}>
            {score}/{maxScore} · {confidenceLabel(confidence)}
          </span>
        </div>
        <div className="push-toast-signals">
          {signals.map((s) => (
            <div key={s.id} className="push-toast-signal-row">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
        <ActionButtons compact />
        <p className="push-toast-disclaimer">{INVESTMENT_DISCLAIMER}</p>
      </div>,
      document.body
    );
  }

  return ReactDOM.createPortal(
    <div className={`push-toast${isBuySignal ? ` push-toast--buy-signal${isSell ? " push-toast--sell" : ""}` : ""}`} onClick={handleTap} role="alert">
      {data?.type === "coin_mention" ? (
        <Avatar url={data.avatarUrl} fallback={initials(data.username ?? "?")} className="push-toast-avatar" />
      ) : isBuySignal ? (
        <div className="push-toast-icon push-toast-icon--buy-signal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {isSell ? <path d="M3 7l6 6 4-4 8 8M15 17h6v-6" /> : <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />}
          </svg>
        </div>
      ) : (
        <div className="push-toast-icon">🔔</div>
      )}
      <div className="push-toast-body">
        {isBuySignal && <span className="push-toast-eyebrow">{signalLabel}</span>}
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
        {/* Native push notifications only ever carry title/body/coin/score
            (see the FCM data payload in buy-signal-scan/index.ts) — no
            room here for the full sentence the rich layouts use, but the
            disclaimer itself still belongs on every platform. */}
        {isBuySignal && <span className="push-toast-disclaimer push-toast-disclaimer--compact">Not investment advice. Trade at your own risk.</span>}
        {isBuySignal && data?.coin && <ActionButtons compact />}
      </div>
      <button className="push-toast-close" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
    </div>,
    document.body
  );
}
