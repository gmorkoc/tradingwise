import { useState, useEffect, useCallback, useRef } from "react";
import { subscribeWhaleAlerts, type WhaleTx } from "../services/whaleAlerts";
import "../styles/WhaleAlerts.css";

const DISMISS_MS = 12_000;

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
}

export function WhaleAlerts({ btcPrice }: Props) {
  const [alerts, setAlerts] = useState<WhaleTx[]>([]);
  const [muted, setMuted] = useState(() => localStorage.getItem("whale-muted") !== "0");
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const toggleMute = useCallback(() => {
    setMuted(m => {
      const next = !m;
      localStorage.setItem("whale-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  useEffect(() => {
    return subscribeWhaleAlerts(tx => {
      if (!mutedRef.current) playWhaleSound();
      setAlerts(prev => [tx, ...prev].slice(0, 3));
      setTimeout(() => dismiss(tx.id), DISMISS_MS);
    });
  }, [dismiss]);

  if (!alerts.length) return null;

  return (
    <div className="whale-alerts" role="status" aria-live="polite">
      {alerts.map(alert => {
        const usd = btcPrice && btcPrice > 0 ? alert.amount * btcPrice : null;
        return (
          <div key={alert.id} className="whale-alert">
            <div className="whale-alert-icon">🐋</div>

            <div className="whale-alert-body">
              <div className="whale-alert-label">
                Whale Alert · BTC
                {alert.sentiment !== "neutral" && (
                  <span className={`whale-sentiment whale-sentiment--${alert.sentiment}`}>
                    {alert.sentiment === "bullish" ? "▲ Bullish" : "▼ Bearish"}
                  </span>
                )}
              </div>

              <div className="whale-alert-row">
                <span className="whale-alert-btc">
                  {alert.amount >= 1000
                    ? `${(alert.amount / 1000).toFixed(2)}K`
                    : alert.amount.toFixed(1)}{" "}BTC
                </span>
                {usd && (
                  <span className="whale-alert-usd">≈ {fmtUsd(usd)}</span>
                )}
              </div>

              <div className="whale-alert-transfer">
                <span
                  className={`whale-alert-entity${isKnown(alert.from) ? " known" : ""}`}
                  title={alert.fromRaw || alert.from}
                >
                  {alert.from}
                </span>
                <svg className="whale-alert-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
                <span
                  className={`whale-alert-entity${isKnown(alert.to) ? " known" : ""}`}
                  title={alert.toRaw || alert.to}
                >
                  {alert.to}
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  </svg>
                )}
              </button>
              <a
                href={`https://mempool.space/tx/${alert.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="whale-alert-view"
                title="View transaction"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
              <button
                className="whale-alert-close"
                onClick={() => dismiss(alert.id)}
                aria-label="Dismiss"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div
              className="whale-alert-progress"
              style={{ "--dismiss-ms": `${DISMISS_MS}ms` } as React.CSSProperties}
            />
          </div>
        );
      })}
    </div>
  );
}
