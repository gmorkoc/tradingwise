// Predict → a full-screen "Over / Under" round (1, 5 or 15 minutes), with
// practice money only (layout modelled on a prediction app the user shared):
//   • the round is the current 1/5/15-min window (UTC);
//     "Price to beat" = the price when it opened, countdown to its end
//   • a live 1-second smooth line, green above the price to beat / red below,
//     with the price to beat as a dashed line + a pill on the right
//   • Over / Under odds update live: P(close > beat) from the distance to the
//     beat, the time left and recent volatility; payout = 0.95 / P
//   • tap Over / Under → pick a stake from a $1,000 practice wallet; bets
//     settle automatically on the round's close; betting locks at 0:15 left
//   • the last 5 rounds' results (↑ / ↓), the live trade ticker on the left
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useTranslation } from "react-i18next";
import {
  createChart, ColorType, LineSeries, LineType, LineStyle, LastPriceAnimationMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from "lightweight-charts";
import { coinglass, type CandleDataPoint, type CoinSymbol, COINS } from "../services/coinglass";
import { BottomSheet } from "./BottomSheet";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { predictShareUrl } from "../services/pendingPredict";
import "../styles/CompactPriceView.css";

interface Props {
  coin: CoinSymbol;
  theme: "dark" | "light";
  onClose: () => void;
  /** Kept for callers; the view is always full screen now. */
  inline?: boolean;
}

interface Tick { id: number; usd: number; isBuy: boolean }
type Side = "over" | "under";
// `len` = round length in seconds (older bets without it were 15-min rounds).
interface Bet { id: string; coin: string; round: number; len?: number; side: Side; stake: number; mult: number; beat: number; settled?: boolean; won?: boolean | null; payout?: number }

// Round lengths the user can pick: 1, 5 or 15 minutes.
type RoundLen = 60 | 300 | 900;
const ROUND_LENS: RoundLen[] = [60, 300, 900];
const CANDLE_OF: Record<RoundLen, "1min" | "5min" | "15min"> = { 60: "1min", 300: "5min", 900: "15min" };
// Predictions close this many seconds before the round ends.
const lockOf = (len: RoundLen) => (len === 60 ? 5 : 15);
const MAX_TICKS = 5;
const START_BALANCE = 1000;
const STAKES = [10, 25, 50, 100];
const LS_WALLET = "predWalletV1";
const LS_BETS = "predBetsV1";
const LS_LEN = "predRoundLen";

const roundStartOf = (sec: number, len: number) => Math.floor(sec / len) * len;
const nowSec = () => Math.floor(Date.now() / 1000);
const fmtPrice = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtAxis = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 4 })}`;
const fmtSize = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 1 ? `$${+n.toFixed(1)}` : `$${+n.toPrecision(2)}`;
const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
// Standard normal CDF (Abramowitz–Stegun erf).
const normCdf = (x: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};
const readLS = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const writeLS = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export function CompactPriceView({ coin, theme, onClose }: Props) {
  const { t } = useTranslation();
  const isLight = theme === "light";
  const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;
  const sideLabel = (s: Side) => t(s === "over" ? "predictRound.over" : "predictRound.under");

  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const beatLineRef = useRef<IPriceLine | null>(null);

  const [now, setNow] = useState(nowSec());
  const [current, setCurrent] = useState<number | null>(null);
  const [beat, setBeat] = useState<number | null>(null);
  const [history, setHistory] = useState<boolean[]>([]); // last 5 rounds, true = closed up
  const [sigmaPerSec, setSigmaPerSec] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [pillY, setPillY] = useState<number | null>(null);
  const [logoError, setLogoError] = useState(false);
  const [balance, setBalance] = useState<number>(() => readLS(LS_WALLET, { balance: START_BALANCE }).balance);
  const [bets, setBets] = useState<Bet[]>(() => readLS<Bet[]>(LS_BETS, []));
  const [pick, setPick] = useState<Side | null>(null);
  const [stake, setStake] = useState(STAKES[1]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [lenOpen, setLenOpen] = useState(false);
  const lenDdRef = useRef<HTMLSpanElement>(null);
  // Close the round-length dropdown on any tap outside it.
  useEffect(() => {
    if (!lenOpen) return;
    const off = (e: PointerEvent) => { if (!lenDdRef.current?.contains(e.target as Node)) setLenOpen(false); };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [lenOpen]);
  const [toast, setToast] = useState<string | null>(null);
  const tickIdRef = useRef(0);
  const [roundLen, setRoundLen] = useState<RoundLen>(() => {
    const v = readLS<number>(LS_LEN, 900);
    return (ROUND_LENS as number[]).includes(v) ? (v as RoundLen) : 900;
  });
  const ROUND = roundLen;
  const LOCK_SEC = lockOf(roundLen);
  const mins = roundLen / 60;

  const round = roundStartOf(now, ROUND);
  const left = Math.max(0, round + ROUND - now);
  const locked = left <= LOCK_SEC;

  useEffect(() => writeLS(LS_LEN, roundLen), [roundLen]);
  // New round length → the old price to beat / history no longer apply.
  useEffect(() => { setBeat(null); setHistory([]); setPick(null); }, [roundLen]);
  useEffect(() => writeLS(LS_WALLET, { balance }), [balance]);
  useEffect(() => writeLS(LS_BETS, bets.slice(-200)), [bets]);
  useEffect(() => setLogoError(false), [coin]);

  // ── Clock ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => setNow(nowSec()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Round data: price to beat, last 5 results; settles finished bets ──
  const loadRounds = useCallback(async () => {
    // Candles for the picked length, plus any other length that still has
    // open bets on this coin (so switching lengths never strands a bet).
    const tNow = nowSec();
    const lens = new Set<RoundLen>([roundLen]);
    readLS<Bet[]>(LS_BETS, []).forEach((b) => {
      const l = (b.len ?? 900) as RoundLen;
      if (!b.settled && b.coin === coin && b.round + l <= tNow && ROUND_LENS.includes(l)) lens.add(l);
    });
    const byLen = new Map<RoundLen, CandleDataPoint[]>();
    await Promise.all([...lens].map(async (l) => {
      byLen.set(l, await coinglass.getHistoricalCandles(CANDLE_OF[l], coin).catch(() => []));
    }));
    const cs = byLen.get(roundLen) ?? [];
    if (cs.length) {
      const r = roundStartOf(tNow, roundLen);
      const cur = cs.find((c) => c.time === r);
      setBeat(cur ? cur.open : cs[cs.length - 1].close);
      setHistory(cs.filter((c) => c.time < r).slice(-5).map((c) => c.close >= c.open));
    }
    // Settle any of this coin's open bets whose round has ended.
    const closeAt = new Map<string, number>();
    byLen.forEach((list, l) => list.forEach((c) => closeAt.set(`${l}:${c.time}`, c.close)));
    setBets((prev) => {
      let won = 0, lost = 0, credit = 0;
      const next = prev.map((b) => {
        const l = b.len ?? 900;
        if (b.settled || b.coin !== coin || b.round + l > tNow) return b;
        const close = closeAt.get(`${l}:${b.round}`);
        if (close === undefined) return b;
        if (close === b.beat) { credit += b.stake; return { ...b, settled: true, won: null, payout: b.stake }; }
        const win = b.side === "over" ? close > b.beat : close < b.beat;
        const payout = win ? Math.round(b.stake * b.mult * 100) / 100 : 0;
        if (win) { won++; credit += payout; } else lost++;
        return { ...b, settled: true, won: win, payout };
      });
      if (credit) setBalance((x) => Math.round((x + credit) * 100) / 100);
      if (won || lost) setToast(won && !lost ? t("predictRound.toastWon", { amount: fmtPrice(credit) }) : !won ? t("predictRound.toastLost") : t("predictRound.toastSettled", { amount: fmtPrice(credit) }));
      return next;
    });
  }, [coin, roundLen, t]);
  useEffect(() => { loadRounds(); }, [loadRounds, round]);
  // Late close data: re-check a few seconds into each round.
  useEffect(() => {
    const id = window.setTimeout(() => loadRounds(), roundLen === 60 ? 3000 : 6000);
    return () => window.clearTimeout(id);
  }, [loadRounds, round, roundLen]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ── Chart ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: isLight ? "#58667e" : "rgba(255,255,255,0.75)", fontSize: 12, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.16)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 4, lockVisibleTimeRangeOnResize: true },
      localization: { priceFormatter: fmtAxis },
      crosshair: { vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const line = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 2,
      lineType: LineType.Curved,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      lastPriceAnimation: LastPriceAnimationMode.Continuous,
    });
    chartRef.current = chart;
    lineRef.current = line;
    let cancelled = false;
    // Seed: the last hour of 1-min closes (also gives the volatility).
    coinglass.getHistoricalCandles("1min", coin).then((c: CandleDataPoint[]) => {
      if (cancelled || !c.length) return;
      const recent = c.slice(-60);
      // Shown: the last 15 minutes (then live seconds); volatility: the hour.
      line.setData(recent.slice(-15).map((x) => ({ time: x.time as UTCTimestamp, value: x.close })));
      setCurrent(recent[recent.length - 1].close);
      const diffs = recent.slice(1).map((x, i) => x.close - recent[i].close);
      const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
      const sdMin = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
      setSigmaPerSec(sdMin / Math.sqrt(60) || null);
      chart.timeScale().fitContent();
    }).catch(() => {});
    return () => {
      cancelled = true;
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
      beatLineRef.current = null;
    };
  }, [coin, isLight]);

  // Live price every second.
  useEffect(() => {
    const id = window.setInterval(async () => {
      const c = await coinglass.getLiveSecondCandle(coin).catch(() => null);
      if (!c) return;
      try { lineRef.current?.update({ time: c.time as UTCTimestamp, value: c.close }); } catch { /* out-of-order tick */ }
      setCurrent(c.close);
    }, 1000);
    return () => window.clearInterval(id);
  }, [coin]);

  // Line colour + the dashed "price to beat" line, and its pill's position.
  useEffect(() => {
    const line = lineRef.current;
    if (!line || beat === null) return;
    line.applyOptions({ color: current !== null && current < beat ? "#ef4444" : "#22c55e" });
    if (beatLineRef.current) line.removePriceLine(beatLineRef.current);
    beatLineRef.current = line.createPriceLine({
      price: beat, color: isLight ? "rgba(13,20,33,0.45)" : "rgba(255,255,255,0.55)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false,
    });
    const y = line.priceToCoordinate(beat);
    setPillY(y ?? null);
  }, [beat, current, isLight]);

  // ── Live trade ticker (left edge) — Kraken trade feed ────────────────
  useEffect(() => {
    let ws: WebSocket | undefined;
    let dead = false;
    let retry = 0;
    const connect = () => {
      if (dead) return;
      ws = new WebSocket("wss://ws.kraken.com/v2");
      ws.onopen = () => ws?.send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: [`${coin.toUpperCase()}/USD`] } }));
      ws.onclose = () => { if (!dead) retry = window.setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.channel !== "trade") return;
        const add: Tick[] = (msg.data ?? []).map((tr: { price: number; qty: number; side: string }) => ({ id: tickIdRef.current++, usd: tr.price * tr.qty, isBuy: tr.side === "buy" }));
        if (add.length) setTicks((p) => [...add, ...p].slice(0, MAX_TICKS));
      };
    };
    connect();
    return () => { dead = true; window.clearTimeout(retry); ws?.close(); };
  }, [coin]);

  // ── Odds ───────────────────────────────────────────────────────────────
  const pOver = useMemo(() => {
    if (current === null || beat === null || !sigmaPerSec) return 0.5;
    const z = (current - beat) / (sigmaPerSec * Math.sqrt(Math.max(1, left)));
    return Math.min(0.97, Math.max(0.03, normCdf(z)));
  }, [current, beat, sigmaPerSec, left]);
  const overPct = Math.round(pOver * 100);
  const underPct = 100 - overPct;
  const multOf = (p: number) => Math.max(1.01, Math.floor((0.95 / p) * 10) / 10);
  const overMult = multOf(pOver);
  const underMult = multOf(1 - pOver);

  const myRoundBets = bets.filter((b) => b.coin === coin && b.round === round && (b.len ?? 900) === roundLen && !b.settled);
  const diff = current !== null && beat !== null ? current - beat : null;
  const up = (diff ?? 0) >= 0;

  const placeBet = () => {
    if (!pick || beat === null || locked || stake > balance) return;
    const mult = pick === "over" ? overMult : underMult;
    setBets((p) => [...p, { id: `${Date.now()}`, coin, round, len: roundLen, side: pick, stake, mult, beat }]);
    setBalance((x) => Math.round((x - stake) * 100) / 100);
    setToast(t("predictRound.toastPlaced", { side: sideLabel(pick), beat: fmtPrice(beat), stake: fmtPrice(stake), mult }));
    setPick(null);
  };

  // Shares a public link that opens these predictions (in the app when
  // installed; guests sign up first, then land here) — never the app's own
  // capacitor:// address.
  const share = () => {
    const url = predictShareUrl(name);
    const title = t("predictRound.shareTitle", { mins, name });
    if (Capacitor.isNativePlatform()) {
      Share.share({ title, text: title, url, dialogTitle: t("predictRound.share") }).catch(() => {});
      return;
    }
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
    if (nav.share) nav.share({ title, text: title, url }).catch(() => {});
    else navigator.clipboard?.writeText(url).catch(() => {});
  };

  const ringPct = 1 - left / ROUND;

  // My predictions: newest first, with a win/loss summary of settled ones.
  const myHistory = useMemo(() => [...bets].sort((a, b) => Number(b.id) - Number(a.id)), [bets]);
  const histStats = useMemo(() => {
    let wins = 0, losses = 0, net = 0;
    for (const b of bets) {
      if (!b.settled) continue;
      if (b.won === true) wins++;
      else if (b.won === false) losses++;
      net += (b.payout ?? 0) - b.stake;
    }
    return { wins, losses, net: Math.round(net * 100) / 100 };
  }, [bets]);
  const fmtWhen = (id: string) => {
    const d = new Date(Number(id));
    if (isNaN(d.getTime())) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  return createPortal(
    <div className={`cpv-overlay cpv-round${isLight ? "" : " cpv-round--dark"}`}>
      {/* Top bar: back · countdown · history + share */}
      <div className="cpr-top">
        <button type="button" className="cpr-circle" onClick={onClose} aria-label={t("predictRound.close")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <span className={`cpr-clock${locked ? " cpr-clock--locked" : ""}`} style={{ ["--cpr-p" as string]: ringPct }} aria-label={t("predictRound.clockAria", { time: fmtClock(left) })}>
          {fmtClock(left)}
        </span>
        <span className="cpr-pair">
          <button type="button" onClick={() => setHistOpen(true)} aria-label={t("predictRound.myPredictions")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></svg>
          </button>
          <button type="button" onClick={share} aria-label={t("predictRound.share")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v13M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>
          </button>
        </span>
      </div>

      {/* Title */}
      <div className="cpr-title">
        {!logoError ? (
          <img src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`} alt="" onError={() => setLogoError(true)} />
        ) : <span className="cpr-logo-fb">{coin[0]}</span>}
        <span>{name}</span>
        {/* Round length dropdown: 1 / 5 / 15 min */}
        <span className="cpr-lendd" ref={lenDdRef}>
          <button
            type="button"
            className={`cpr-lenbtn${lenOpen ? " cpr-lenbtn--open" : ""}`}
            aria-haspopup="listbox"
            aria-expanded={lenOpen}
            aria-label={t("predictRound.lenAria", { mins })}
            onClick={() => setLenOpen((o) => !o)}
          >
            {t("predictRound.lenShort", { mins })}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {lenOpen && (
            <span className="cpr-lenmenu" role="listbox" aria-label={t("predictRound.lenMenuAria")}>
              {ROUND_LENS.map((l) => (
                <button
                  key={l}
                  type="button"
                  role="option"
                  aria-selected={roundLen === l}
                  className={`cpr-lenopt${roundLen === l ? " cpr-lenopt--on" : ""}`}
                  onClick={() => { setRoundLen(l); setLenOpen(false); }}
                >
                  {t("predictRound.lenOption", { mins: l / 60 })}
                  {roundLen === l && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </button>
              ))}
            </span>
          )}
        </span>
        <span className="cpr-wallet">{fmtPrice(balance)} <em>{t("predictRound.practice")}</em></span>
      </div>

      {/* Current vs price to beat */}
      <div className="cpr-prices">
        <div>
          <strong className={up ? "cpr-up" : "cpr-dn"}>{current !== null ? fmtPrice(current) : "—"}</strong>
          <span>{t("predictRound.current")} {diff !== null && <b className={up ? "cpr-up" : "cpr-dn"}>{up ? "↗" : "↘"}{fmtPrice(Math.abs(diff))}</b>}</span>
        </div>
        <i aria-hidden="true" />
        <div>
          <strong>{beat !== null ? fmtPrice(beat) : "—"}</strong>
          <span>{t("predictRound.priceToBeat")}</span>
        </div>
      </div>

      {/* Chart + trade ticker + price-to-beat pill */}
      <div className="cpr-chart">
        <div ref={boxRef} className="cpr-chart-box" />
        <div className="cpr-ticks" aria-hidden="true">
          {ticks.map((tk) => (
            <span key={tk.id} className={tk.isBuy ? "cpr-up" : "cpr-dn"}>{tk.isBuy ? "↑" : "↓"} {fmtSize(tk.usd)}</span>
          ))}
        </div>
        {beat !== null && pillY !== null && (
          <span className="cpr-beat-pill" style={{ top: pillY }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            {fmtPrice(beat)}
          </span>
        )}
      </div>

      {/* Past rounds + rules */}
      <div className="cpr-hist">
        <span className="cpr-hist-dots">
          {history.map((u, i) => (
            <i key={i} className={u ? "cpr-hist-up" : "cpr-hist-dn"} aria-label={u ? t("predictRound.closedUp") : t("predictRound.closedDown")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">{u ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}</svg>
            </i>
          ))}
        </span>
        <button type="button" className="cpr-rules" onClick={() => setRulesOpen(true)}>
          {t("predictRound.readRules")}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
        </button>
      </div>

      {myRoundBets.length > 0 && (
        <div className="cpr-mybets">
          {myRoundBets.map((b) => (
            <span key={b.id} className={b.side === "over" ? "cpr-up" : "cpr-dn"}>
              {t("predictRound.yourBet", { side: sideLabel(b.side), stake: fmtPrice(b.stake), payout: fmtPrice(b.stake * b.mult) })}
            </span>
          ))}
        </div>
      )}

      {/* Out of practice money (less than the smallest stake, nothing still
          in play): one tap refills the wallet instead of Over / Under. */}
      {balance < STAKES[0] && !bets.some((b) => !b.settled) ? (
        <div className="cpr-broke">
          <p>{t("predictRound.outOfMoney")}</p>
          <button
            type="button"
            className="cpr-confirm"
            onClick={() => { setBalance(START_BALANCE); setToast(t("predictRound.toastWalletReset", { amount: fmtPrice(START_BALANCE) })); }}
          >
            {t("predictRound.resetTo", { amount: fmtPrice(START_BALANCE) })}
          </button>
        </div>
      ) : (
      <div className="cpr-actions">
        <div>
          <button type="button" className="cpr-btn cpr-btn--over" disabled={locked || beat === null} onClick={() => setPick("over")}>
            {t("predictRound.over")} <span>{overPct}%</span>
          </button>
          <span className="cpr-mult cpr-up">{overMult.toFixed(1)}x</span>
        </div>
        <div>
          <button type="button" className="cpr-btn cpr-btn--under" disabled={locked || beat === null} onClick={() => setPick("under")}>
            {t("predictRound.under")} <span>{underPct}%</span>
          </button>
          <span className="cpr-mult cpr-dn">{underMult.toFixed(1)}x</span>
        </div>
      </div>
      )}
      {locked && <p className="cpr-lock">{t("predictRound.locked", { time: fmtClock(left) })}</p>}

      {toast && <div className="cpr-toast" role="status">{toast}</div>}

      {/* Stake picker */}
      <BottomSheet
        open={!!pick}
        onClose={() => setPick(null)}
        title={<>{pick === "over" ? t("predictRound.over") : t("predictRound.under")} {beat !== null ? fmtPrice(beat) : ""}</>}
        ariaLabel={t("predictRound.placeAria")}
      >
        <div className="cpr-sheet">
          <p className="cpr-sheet-sub">
            {t(pick === "over" ? "predictRound.sheetSubOver" : "predictRound.sheetSubUnder", { name, beat: beat !== null ? fmtPrice(beat) : t("predictRound.beatFallback"), time: fmtClock(left) })}
          </p>
          <div className="cpr-stakes">
            {STAKES.map((s) => (
              <button key={s} type="button" className={`cpr-stake${stake === s ? " cpr-stake--on" : ""}`} disabled={s > balance} onClick={() => setStake(s)}>
                ${s}
              </button>
            ))}
          </div>
          <div className="cpr-sheet-row"><span>{t("predictRound.balance")}</span><b>{fmtPrice(balance)}</b></div>
          <div className="cpr-sheet-row"><span>{t("predictRound.payoutIfRight")}</span><b className="cpr-up">{fmtPrice(stake * (pick === "over" ? overMult : underMult))}</b></div>
          <button
            type="button"
            className={`cpr-confirm${pick === "under" ? " cpr-confirm--under" : ""}`}
            disabled={locked || stake > balance}
            onClick={placeBet}
          >
            {stake > balance ? t("predictRound.notEnough") : t("predictRound.predictBtn", { side: pick === "over" ? t("predictRound.over") : t("predictRound.under"), stake: fmtPrice(stake) })}
          </button>
          <p className="cpr-sheet-note">{t("predictRound.practiceNote")}</p>
        </div>
      </BottomSheet>

      {/* My predictions */}
      <BottomSheet open={histOpen} onClose={() => setHistOpen(false)} title={<>{t("predictRound.myPredictions")}</>} ariaLabel={t("predictRound.myPredictions")}>
        <div className="cpr-sheet cpr-histlist">
          <div className="cpr-hstats">
            <div><b className="cpr-up">{histStats.wins}</b><span>{t("predictRound.won")}</span></div>
            <div><b className="cpr-dn">{histStats.losses}</b><span>{t("predictRound.lost")}</span></div>
            <div>
              <b className={histStats.net >= 0 ? "cpr-up" : "cpr-dn"}>{histStats.net >= 0 ? "+" : "−"}{fmtPrice(Math.abs(histStats.net))}</b>
              <span>{t("predictRound.net")}</span>
            </div>
          </div>
          {myHistory.length === 0 ? (
            <p className="cpr-hempty">{t("predictRound.empty")}</p>
          ) : (
            <ul className="cpr-hlist">
              {myHistory.map((b) => {
                const len = (b.len ?? 900) / 60;
                const result = !b.settled
                  ? <span className="cpr-hres cpr-hres--open">{t("predictRound.inPlay")}</span>
                  : b.won === null
                    ? <span className="cpr-hres">{t("predictRound.tie", { amount: fmtPrice(b.stake) })}</span>
                    : b.won
                      ? <span className="cpr-hres cpr-up">+{fmtPrice((b.payout ?? 0) - b.stake)}</span>
                      : <span className="cpr-hres cpr-dn">−{fmtPrice(b.stake)}</span>;
                return (
                  <li key={b.id}>
                    <span className={`cpr-hside ${b.side === "over" ? "cpr-hside--up" : "cpr-hside--dn"}`} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">{b.side === "over" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}</svg>
                    </span>
                    <span className="cpr-hmain">
                      <b>{b.coin} {sideLabel(b.side)} {fmtPrice(b.beat)}</b>
                      <small>{t("predictRound.histMeta", { len, stake: fmtPrice(b.stake), mult: b.mult.toFixed(1), when: fmtWhen(b.id) })}</small>
                    </span>
                    {result}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="cpr-sheet-note">{t("predictRound.practiceNote")}</p>
        </div>
      </BottomSheet>

      {/* Rules */}
      <BottomSheet open={rulesOpen} onClose={() => setRulesOpen(false)} title={<>{t("predictRound.rulesTitle")}</>} ariaLabel={t("predictRound.rulesAria")}>
        <div className="cpr-sheet cpr-rules-body">
          <p><Trans i18nKey="predictRound.rules1" count={mins} values={{ mins, quarters: mins === 15 ? " (:00, :15, :30, :45)" : "", name }} components={{ b: <b /> }} /></p>
          <p><Trans i18nKey="predictRound.rules2" components={{ up: <b className="cpr-up" />, dn: <b className="cpr-dn" /> }} /></p>
          <p>{t("predictRound.rules3", { secs: LOCK_SEC })}</p>
          <p>{t("predictRound.rules4", { amount: fmtPrice(START_BALANCE) })}</p>
          {balance < STAKES[0] && (
            <button type="button" className="cpr-confirm" onClick={() => { setBalance(START_BALANCE); setRulesOpen(false); }}>{t("predictRound.resetWallet", { amount: fmtPrice(START_BALANCE) })}</button>
          )}
        </div>
      </BottomSheet>
    </div>,
    document.body,
  );
}
