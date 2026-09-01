import { useState, useEffect, useRef, useMemo } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { coinglass, CoinSymbol, COINS } from "../services/coinglass";
import { useNotificationsEnabled } from "../hooks/useNotificationsEnabled";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
import { playAlertSoundFile } from "../utils/alertSound";
import "../styles/PriceAlerts.css";

interface PriceAlert {
  id: string;
  coin: CoinSymbol;
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

const STORAGE_KEY = "priceAlerts";

function loadAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    // Alerts saved before per-coin support didn't store a coin at all —
    // fall back to BTC for those rather than crash on the missing field.
    return (JSON.parse(raw) as PriceAlert[]).map((a) => ({ ...a, coin: a.coin ?? "BTC" }));
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
  const { user, profile } = useAuth();
  const alertSoundRef = useRef(profile?.alert_sound ?? "bell");
  alertSoundRef.current = profile?.alert_sound ?? "bell";
  const [notificationsEnabled] = useNotificationsEnabled();
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  const [open, setOpen]         = useState(false);
  const [alerts, setAlerts]     = useState<PriceAlert[]>(loadAlerts);
  const [input, setInput]       = useState("");
  const [selectedCoin, setSelectedCoin] = useState<CoinSymbol>(coin);
  const [toast, setToast]       = useState<PriceAlert | null>(null);
  const [prices, setPrices]     = useState<Record<string, number>>({});
  const prevPricesRef           = useRef<Record<string, number>>({});
  const toastTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bellRef                 = useRef<HTMLButtonElement>(null);

  // Opening the panel fresh defaults the coin picker to whatever chart is
  // currently on screen — doesn't snap back while it's already open, so
  // picking a different coin sticks for setting several alerts in a row.
  useEffect(() => {
    if (open) setSelectedCoin(coin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Global switch hides an already-showing toast too, not just future ones.
  useEffect(() => {
    if (!notificationsEnabled) setToast(null);
  }, [notificationsEnabled]);

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

  // Every coin that needs a live price right now: whichever coin is picked
  // in the add form (shown in the panel header, and needed so its
  // direction/reference price is accurate the moment it's selected), and
  // every coin any pending alert is watching — not just one. The
  // currently-charted coin doesn't need its own poll here — the
  // currentPrice-sync effect below already keeps prices[coin] fresh from
  // the prop, and it's only ever read as a fallback when it equals selectedCoin.
  const trackedCoins = useMemo(() => {
    const set = new Set<string>([selectedCoin]);
    for (const a of alerts) if (!a.triggered) set.add(a.coin);
    return Array.from(set);
  }, [selectedCoin, alerts]);
  const trackedCoinsKey = trackedCoins.join(",");

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        trackedCoinsKey.split(",").map(async (c) => [c, (await coinglass.getLiveSecondCandle(c))?.close] as const)
      );
      if (cancelled) return;
      setPrices((prev) => {
        const next = { ...prev };
        for (const [c, price] of results) if (price != null) next[c] = price;
        return next;
      });
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [trackedCoinsKey]);

  useEffect(() => {
    if (currentPrice) setPrices((prev) => ({ ...prev, [coin]: currentPrice }));
  }, [coin, currentPrice]);

  useEffect(() => { saveAlerts(alerts); }, [alerts]);

  useEffect(() => {
    const prevPrices = prevPricesRef.current;
    prevPricesRef.current = prices;

    setAlerts((current) =>
      current.map((alert) => {
        if (alert.triggered) return alert;
        const price = prices[alert.coin];
        const prev = prevPrices[alert.coin];
        if (price == null || prev == null) return alert;
        const hit =
          alert.direction === "above"
            ? prev < alert.targetPrice && price >= alert.targetPrice
            : prev > alert.targetPrice && price <= alert.targetPrice;
        if (hit) {
          if (notificationsEnabledRef.current) {
            playAlertSoundFile(alertSoundRef.current);
            setToast(alert);
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => setToast(null), 6000);
          }
          return { ...alert, triggered: true };
        }
        return alert;
      })
    );
  }, [prices]);

  const handleBellClick = () => {
    if (bellRef.current) syncPanelPos(bellRef.current); // sync before render
    setOpen((v) => !v);
  };

  const addAlert = () => {
    const price = parseFloat(input.replace(/,/g, ""));
    if (!price || isNaN(price) || price <= 0) return;
    const refPrice = prices[selectedCoin] ?? currentPrice;
    const direction: "above" | "below" = price > refPrice ? "above" : "below";
    const alert: PriceAlert = {
      id: crypto.randomUUID(),
      coin: selectedCoin,
      targetPrice: price,
      direction,
      label: `${direction === "above" ? "↑" : "↓"} $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      triggered: false,
      createdAt: Date.now(),
    };
    setAlerts((prev) => [...prev, alert].sort((a, b) => b.targetPrice - a.targetPrice));
    setInput("");

    // Mirrors into Supabase so the price-alert cron can push a notification
    // for this even with the app closed — the local copy above still drives
    // the in-app toast/sound while it's open, unchanged.
    if (user) {
      supabase.from("price_alerts").insert({
        id: alert.id, user_id: user.id, coin: selectedCoin, target_price: price, direction,
      }).then(({ error }) => { if (error) console.error("Saving price alert failed:", error.message); });
    }
  };

  const removeAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    if (user) supabase.from("price_alerts").delete().eq("id", id).then(() => {});
  };

  const resetAlert = (id: string) => {
    setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, triggered: false } : a));
    if (user) supabase.from("price_alerts").update({ triggered: false }).eq("id", id).then(() => {});
  };

  const activeCount = alerts.filter((a) => !a.triggered).length;

  return (
    <>
      <button
        ref={bellRef}
        className={`alerts-bell${activeCount > 0 ? " alerts-bell--active" : ""}`}
        onClick={handleBellClick}
        title={t("priceAlerts.title")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
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
                    {selectedCoin} ${(prices[selectedCoin] ?? (selectedCoin === coin ? currentPrice : undefined))?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "…"}
                  </span>
                  <button className="alerts-panel-close" onClick={() => setOpen(false)}>✕</button>
                </div>

                <div className="alerts-add">
                  <select
                    className="alerts-coin-select"
                    value={selectedCoin}
                    onChange={(e) => setSelectedCoin(e.target.value as CoinSymbol)}
                  >
                    {COINS.map((c) => (
                      <option key={c.symbol} value={c.symbol}>{c.symbol}</option>
                    ))}
                  </select>
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
                      <span className="alert-coin">{alert.coin}</span>
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
                <span>{toast.coin} {toast.direction === "above" ? t("priceAlerts.toastReached") : t("priceAlerts.toastDropped")} ${toast.targetPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
