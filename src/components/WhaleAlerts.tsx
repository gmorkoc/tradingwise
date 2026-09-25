import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { subscribeWhaleAlerts, type WhaleTx } from "../services/whaleAlerts";
import { useNotificationsEnabled } from "../hooks/useNotificationsEnabled";
import "../styles/WhaleAlerts.css";

const DISMISS_MS = 4_000;
const SNOOZE_MS = 30 * 60 * 1000;

function playWhaleSound() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // Fundamental: slow descending moan 380 Hz → 140 Hz → 190 Hz
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(380, now);
    osc1.frequency.exponentialRampToValueAtTime(140, now + 1.4);
    osc1.frequency.exponentialRampToValueAtTime(190, now + 2.0);
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.28, now + 0.4);
    g1.gain.setValueAtTime(0.28, now + 1.4);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 2.2);
    osc1.start(now); osc1.stop(now + 2.2);

    // Second harmonic for body
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(760, now);
    osc2.frequency.exponentialRampToValueAtTime(280, now + 1.4);
    osc2.frequency.exponentialRampToValueAtTime(380, now + 2.0);
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.08, now + 0.4);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 2.0);
    osc2.start(now); osc2.stop(now + 2.0);

    setTimeout(() => ctx.close(), 2600);
  } catch { /* audio blocked — ignore */ }
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

function isKnown(label: string): boolean {
  return !label.includes("…");
}

interface Props {
  btcPrice?: number;
  coinChatOpen?: boolean;
}

// One fixed-size banner, always — never multiple stacked cards and never a
// card that grows to fit more than one alert. When several whale txs come
// in close together, they queue and the SAME banner cycles through their
// content one at a time (a small "+N waiting" badge hints there's more
// behind the current one), instead of stacking or resizing.
export function WhaleAlerts({ btcPrice, coinChatOpen }: Props) {
  const { t } = useTranslation();
  const [notificationsEnabled] = useNotificationsEnabled();
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  const [current, setCurrent] = useState<WhaleTx | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [muted, setMuted] = useState(() => localStorage.getItem("whale-muted") !== "0");
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem("whale-snoozed-until"));
    return saved > Date.now() ? saved : null;
  });
  const snoozedUntilRef = useRef(snoozedUntil);
  snoozedUntilRef.current = snoozedUntil;

  const queueRef = useRef<WhaleTx[]>([]);
  const advancingRef = useRef(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global switch hides whatever's on screen too, not just future ones.
  useEffect(() => {
    if (!notificationsEnabled) {
      queueRef.current = [];
      setPendingCount(0);
      setCurrent(null);
    }
  }, [notificationsEnabled]);

  const toggleMute = useCallback(() => {
    setMuted(m => {
      const next = !m;
      localStorage.setItem("whale-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  // Snoozing clears whatever's on screen right now too (not just future
  // alerts), and drops anything already queued so the backlog doesn't pop
  // up immediately after — matches the notificationsEnabled behavior above.
  const snooze = useCallback(() => {
    const until = Date.now() + SNOOZE_MS;
    localStorage.setItem("whale-snoozed-until", String(until));
    setSnoozedUntil(until);
    queueRef.current = [];
    setPendingCount(0);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setCurrent(null);
  }, []);

  // Pulls the next queued tx into `current` and schedules its own
  // replacement — one continuous chain, so the banner never shows more
  // than one alert's content at a time regardless of how fast they arrive.
  const advance = useCallback(() => {
    const tx = queueRef.current.shift();
    setPendingCount(queueRef.current.length);
    if (!tx) {
      advancingRef.current = false;
      setCurrent(null);
      return;
    }
    if (!mutedRef.current) playWhaleSound();
    setCurrent(tx);
    dismissTimerRef.current = setTimeout(advance, DISMISS_MS);
  }, []);

  const dismissCurrent = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    advance();
  }, [advance]);

  useEffect(() => {
    return subscribeWhaleAlerts(tx => {
      if (!notificationsEnabledRef.current) return;
      if (snoozedUntilRef.current && Date.now() < snoozedUntilRef.current) return;
      queueRef.current.push(tx);
      setPendingCount(queueRef.current.length);
      if (!advancingRef.current) {
        advancingRef.current = true;
        advance();
      }
    });
  }, [advance]);

  if (!current) return null;

  const usd = btcPrice && btcPrice > 0 ? current.amount * btcPrice : null;

  return (
    <div
      className={`whale-alerts${coinChatOpen ? " whale-alerts--chat-open" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="whale-alert" key={current.id}>
        <div className="whale-alert-main">
          <div className="whale-alert-icon">🐋</div>

          <div className="whale-alert-body">
            <div className="whale-alert-label">
              {t("whaleAlerts.label")}
              {current.sentiment !== "neutral" && (
                <span className={`whale-sentiment whale-sentiment--${current.sentiment}`}>
                  {current.sentiment === "bullish" ? t("whaleAlerts.bullish") : t("whaleAlerts.bearish")}
                </span>
              )}
              {pendingCount > 0 && <span className="whale-alert-count">+{pendingCount}</span>}
            </div>

            <div className="whale-alert-row">
              <span className="whale-alert-btc">
                {current.amount >= 1000
                  ? `${(current.amount / 1000).toFixed(2)}K`
                  : current.amount.toFixed(1)}{" "}BTC
              </span>
              {usd && (
                <span className="whale-alert-usd">≈ {fmtUsd(usd)}</span>
              )}
            </div>

            <div className="whale-alert-transfer">
              <span
                className={`whale-alert-entity${isKnown(current.from) ? " known" : ""}`}
                title={current.fromRaw || current.from}
              >
                {current.from}
              </span>
              <svg className="whale-alert-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <span
                className={`whale-alert-entity${isKnown(current.to) ? " known" : ""}`}
                title={current.toRaw || current.to}
              >
                {current.to}
              </span>
            </div>
          </div>

          <div className="whale-alert-actions">
            <button
              className={`whale-mute${muted ? " whale-mute--off" : ""}`}
              onClick={toggleMute}
              aria-label={muted ? "Unmute whale alerts" : "Mute whale alerts"}
              title={muted ? "Sound off" : "Sound on"}
            >
              {muted ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
              )}
            </button>
            <a
              href={`https://mempool.space/tx/${current.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="whale-alert-view"
              title="View transaction"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
            <button
              className="whale-alert-close"
              onClick={dismissCurrent}
              aria-label={pendingCount > 0 ? "Dismiss and show next" : "Dismiss"}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <button
          type="button"
          className="whale-snooze-footer"
          onClick={snooze}
          aria-label="Snooze whale alerts for 30 minutes"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="13" r="8"/>
            <path d="M12 9v4l3 2"/>
          </svg>
          {t("whaleAlerts.snooze", "Snooze 30m")}
        </button>

        <div
          className="whale-alert-progress"
          style={{ "--dismiss-ms": `${DISMISS_MS}ms` } as React.CSSProperties}
        />
      </div>
    </div>
  );
}
