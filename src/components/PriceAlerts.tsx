import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { coinglass, CoinSymbol } from "../services/coinglass";
import "../styles/PriceAlerts.css";

interface PriceAlert {
  id: string;
  targetPrice: number;
  direction: "above" | "below";
  label: string;
  triggered: boolean;
  createdAt: number;
}

interface Props {
  coin: CoinSymbol;
  currentPrice: number;
}

function playAlertSound() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const t0 = ctx.currentTime;

    function bell(freq: number, t: number, vol = 0.4) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc2.connect(gain2); gain2.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
      osc.start(t); osc.stop(t + 2.2);
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(freq * 2.756, t);
      gain2.gain.setValueAtTime(vol * 0.4, t);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      osc2.start(t); osc2.stop(t + 1.0);
    }

    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.connect(clickGain); clickGain.connect(ctx.destination);
    click.type = "square";
    click.frequency.setValueAtTime(800, t0);
    clickGain.gain.setValueAtTime(0.3, t0);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.02);
    click.start(t0); click.stop(t0 + 0.02);

    bell(987, t0);
    bell(830, t0 + 0.18, 0.3);
    bell(659, t0 + 0.34, 0.2);
  } catch { /* browser may block without user gesture */ }
}

const STORAGE_KEY = "priceAlerts";

function loadAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAlerts(alerts: PriceAlert[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts)); } catch { /* quota */ }
}

// Set CSS vars synchronously — no React state, no re-render, no position flash
function syncPanelPos(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const root = document.documentElement;
  root.style.setProperty("--alerts-panel-top", `${rect.bottom + 10}px`);
  const panelWidth = 340;
  const rightFromEdge = window.innerWidth - rect.right;
  const clampedRight = Math.min(rightFromEdge, window.innerWidth - panelWidth - 12);
  root.style.setProperty("--alerts-panel-right", `${Math.max(clampedRight, 12)}px`);
}

export function PriceAlerts({ coin, currentPrice }: Props) {
  const { t } = useTranslation();
  const [open, setOpen]         = useState(false);
  const [alerts, setAlerts]     = useState<PriceAlert[]>(loadAlerts);
  const [input, setInput]       = useState("");
  const [toast, setToast]       = useState<PriceAlert | null>(null);
  const [livePrice, setLivePrice] = useState(currentPrice);
  const prevPriceRef            = useRef<number | null>(null);
  const toastTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bellRef                 = useRef<HTMLButtonElement>(null);

  // Keep resize/scroll in sync while open
  useEffect(() => {
    if (!open || !bellRef.current) return;
    const update = () => { if (bellRef.current) syncPanelPos(bellRef.current); };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const id = setInterval(async () => {
      const c = await coinglass.getLiveSecondCandle(coin);
      if (c) setLivePrice(c.close);
    }, 3000);
    return () => clearInterval(id);
  }, [coin]);

  useEffect(() => {
    if (currentPrice) setLivePrice(currentPrice);
  }, [currentPrice]);

  useEffect(() => { saveAlerts(alerts); }, [alerts]);

  useEffect(() => {
    const prev = prevPriceRef.current;
    prevPriceRef.current = livePrice;
    if (!prev || !livePrice) return;

    setAlerts((current) =>
      current.map((alert) => {
        if (alert.triggered) return alert;
        const hit =
          alert.direction === "above"
            ? prev < alert.targetPrice && livePrice >= alert.targetPrice
            : prev > alert.targetPrice && livePrice <= alert.targetPrice;
        if (hit) {
          playAlertSound();
          setToast(alert);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => setToast(null), 6000);
          return { ...alert, triggered: true };
        }
        return alert;
      })
    );
  }, [livePrice]);

  const handleBellClick = () => {
    if (bellRef.current) syncPanelPos(bellRef.current); // sync before render
    setOpen((v) => !v);
  };

  const addAlert = () => {
    const price = parseFloat(input.replace(/,/g, ""));
    if (!price || isNaN(price) || price <= 0) return;
    const direction: "above" | "below" = price > livePrice ? "above" : "below";
    const alert: PriceAlert = {
      id: Date.now().toString(),
      targetPrice: price,
      direction,
      label: `${direction === "above" ? "↑" : "↓"} $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      triggered: false,
      createdAt: Date.now(),
    };
    setAlerts((prev) => [...prev, alert].sort((a, b) => b.targetPrice - a.targetPrice));
    setInput("");
  };

  const removeAlert = (id: string) =>
    setAlerts((prev) => prev.filter((a) => a.id !== id));

  const resetAlert = (id: string) =>
    setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, triggered: false } : a));

  const activeCount = alerts.filter((a) => !a.triggered).length;

  return (
    <>
      <button
        ref={bellRef}
        className={`alerts-bell${activeCount > 0 ? " alerts-bell--active" : ""}`}
        onClick={handleBellClick}
        title={t("priceAlerts.title")}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {activeCount > 0 && <span className="alerts-bell-count">{activeCount}</span>}
      </button>

      {ReactDOM.createPortal(
        <>
          {open && (
            <>
              <div className="alerts-backdrop" onClick={() => setOpen(false)} />
              <div className="alerts-panel">
                <div className="alerts-panel-header">
                  <span className="alerts-panel-title">{t("priceAlerts.title")}</span>
                  <span className="alerts-panel-price">
                    {coin} ${livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <button className="alerts-panel-close" onClick={() => setOpen(false)}>✕</button>
                </div>

                <div className="alerts-add">
                  <input
                    className="alerts-input"
                    type="number"
                    placeholder={t("priceAlerts.placeholder")}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addAlert()}
                  />
                  <button className="alerts-add-btn" onClick={addAlert}>{t("priceAlerts.addBtn")}</button>
                </div>

                <div className="alerts-list">
                  {alerts.length === 0 && (
                    <p className="alerts-empty">{t("priceAlerts.empty")}</p>
                  )}
                  {alerts.map((alert) => (
                    <div key={alert.id} className={`alert-item${alert.triggered ? " alert-item--triggered" : ""}`}>
                      <span className={`alert-direction ${alert.direction === "above" ? "alert-direction--above" : "alert-direction--below"}`}>
                        {alert.direction === "above" ? "↑" : "↓"}
                      </span>
                      <span className="alert-price">
                        ${alert.targetPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <span className="alert-tag">
                        {alert.direction === "above" ? t("priceAlerts.goesAbove") : t("priceAlerts.goesBelow")}
                      </span>
                      {alert.triggered && (
                        <span className="alert-triggered-badge">{t("priceAlerts.triggered")}</span>
                      )}
                      <div className="alert-actions">
                        {alert.triggered && (
                          <button className="alert-reset-btn" onClick={() => resetAlert(alert.id)} title="Reset">↺</button>
                        )}
                        <button className="alert-delete-btn" onClick={() => removeAlert(alert.id)} title="Delete">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {toast && (
            <div className="alert-toast" onClick={() => setToast(null)}>
              <div className="alert-toast-icon">🔔</div>
              <div className="alert-toast-body">
                <strong>{t("priceAlerts.toastTitle")}</strong>
                <span>{coin} {toast.direction === "above" ? t("priceAlerts.toastReached") : t("priceAlerts.toastDropped")} ${toast.targetPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <button className="alert-toast-close">✕</button>
            </div>
          )}
        </>,
        document.body
      )}
    </>
  );
}
