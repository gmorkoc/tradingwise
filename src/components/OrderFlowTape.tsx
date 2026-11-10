import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { LockCard } from "./MembershipGate";

// Live Flow: real-time trades from SIX exchanges' public feeds at once
// (spot markets, so they're comparable): Binance, Coinbase, OKX, Bybit,
// Bitget, Kraken. Every trade is normalised to price · size in USD ·
// aggressor side, and the Buy/Sell volume, Cumulative Delta and pressure
// bar are totals across all of them since this tab opened. Each feed
// reconnects on its own; the breakdown shows which ones are live.

type Ex = "Binance" | "Coinbase" | "OKX" | "Bybit" | "Bitget" | "Kraken";
type Status = "connecting" | "live" | "waiting" | "unavailable";

interface Trade {
  id: number;
  ex: Ex;
  price: number;
  usd: number;
  isBuy: boolean;
  time: number;
}

interface Raw { price: number; qty: number; buy: boolean; time: number }

interface Adapter {
  ex: Ex;
  url: (c: string) => string;
  subscribe?: (c: string) => unknown;
  /** Keep-alive some exchanges require (sent as-is). */
  ping?: { everyMs: number; msg: string };
  /** Trades in this message (live ones only), or "error" if the exchange
   *  says the market doesn't exist, or null to ignore. */
  parse: (d: any) => Raw[] | "error" | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const ADAPTERS: Adapter[] = [
  {
    ex: "Binance",
    // Public market-data mirror — Binance's main stream refuses US users.
    url: (c) => `wss://data-stream.binance.vision/ws/${c.toLowerCase()}usdt@trade`,
    // m = buyer is the maker → the aggressor sold.
    parse: (d) => (d?.e === "trade" ? [{ price: +d.p, qty: +d.q, buy: !d.m, time: d.T }] : null),
  },
  {
    ex: "Coinbase",
    url: () => "wss://ws-feed.exchange.coinbase.com",
    subscribe: (c) => ({ type: "subscribe", product_ids: [`${c}-USD`], channels: ["matches"] }),
    // `side` is the MAKER's side: "sell" means a buyer took it → aggressive buy.
    parse: (d) => d?.type === "error" ? "error"
      : d?.type === "match" ? [{ price: +d.price, qty: +d.size, buy: d.side === "sell", time: Date.parse(d.time) }] : null,
  },
  {
    ex: "OKX",
    url: () => "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: (c) => ({ op: "subscribe", args: [{ channel: "trades", instId: `${c}-USDT` }] }),
    ping: { everyMs: 25_000, msg: "ping" },
    parse: (d) => d?.event === "error" ? "error"
      : d?.arg?.channel === "trades" && Array.isArray(d.data)
        ? d.data.map((x: any) => ({ price: +x.px, qty: +x.sz, buy: x.side === "buy", time: +x.ts })) // eslint-disable-line @typescript-eslint/no-explicit-any
        : null,
  },
  {
    ex: "Bybit",
    url: () => "wss://stream.bybit.com/v5/public/spot",
    subscribe: (c) => ({ op: "subscribe", args: [`publicTrade.${c}USDT`] }),
    ping: { everyMs: 20_000, msg: JSON.stringify({ op: "ping" }) },
    parse: (d) => d?.op === "subscribe" && d?.success === false ? "error"
      : typeof d?.topic === "string" && d.topic.startsWith("publicTrade") && Array.isArray(d.data)
        ? d.data.map((x: any) => ({ price: +x.p, qty: +x.v, buy: x.S === "Buy", time: +x.T })) // eslint-disable-line @typescript-eslint/no-explicit-any
        : null,
  },
  {
    ex: "Bitget",
    url: () => "wss://ws.bitget.com/v2/ws/public",
    subscribe: (c) => ({ op: "subscribe", args: [{ instType: "SPOT", channel: "trade", instId: `${c}USDT` }] }),
    ping: { everyMs: 25_000, msg: "ping" },
    // First message is a snapshot of past trades — only live updates count.
    parse: (d) => d?.event === "error" ? "error"
      : d?.arg?.channel === "trade" && d?.action === "update" && Array.isArray(d.data)
        ? d.data.map((x: any) => ({ price: +x.price, qty: +x.size, buy: x.side === "buy", time: +x.ts })) // eslint-disable-line @typescript-eslint/no-explicit-any
        : null,
  },
  {
    ex: "Kraken",
    url: () => "wss://ws.kraken.com/v2",
    subscribe: (c) => ({ method: "subscribe", params: { channel: "trade", symbol: [`${c}/USD`] } }),
    // Skip the snapshot of past trades sent on subscribe.
    parse: (d) => d?.method === "subscribe" && d?.success === false ? "error"
      : d?.channel === "trade" && d?.type === "update" && Array.isArray(d.data)
        ? d.data.map((x: any) => ({ price: +x.price, qty: +x.qty, buy: x.side === "buy", time: Date.parse(x.timestamp) })) // eslint-disable-line @typescript-eslint/no-explicit-any
        : null,
  },
];
const EXCHANGES = ADAPTERS.map((a) => a.ex);

interface Props { coin: string; onOpenAuth?: (view?: "login" | "signup") => void; }

const MAX = 150;
const BIG_TRADE_THRESHOLD = 50_000; // USD
const TAPE_MIN_USD = 1_000;         // the list only; totals count every trade

type PerEx = Record<Ex, { buy: number; sell: number }>;
const emptyPerEx = (): PerEx => Object.fromEntries(EXCHANGES.map((e) => [e, { buy: 0, sell: 0 }])) as PerEx;

export function OrderFlowTape({ coin, onOpenAuth = () => {} }: Props) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [trades, setTrades]   = useState<Trade[]>([]);
  const [perEx, setPerEx]     = useState<PerEx>(emptyPerEx);
  const [status, setStatus]   = useState<Record<Ex, Status>>(() => Object.fromEntries(EXCHANGES.map((e) => [e, "connecting"])) as Record<Ex, Status>);
  const pendingRef = useRef<Trade[]>([]);
  const volRef     = useRef<PerEx>(emptyPerEx());
  const rafRef     = useRef(0);
  const listRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTrades([]);
    volRef.current = emptyPerEx();
    setPerEx(emptyPerEx());
    setStatus(Object.fromEntries(EXCHANGES.map((e) => [e, "connecting"])) as Record<Ex, Status>);
    const C = coin.toUpperCase();
    let dead = false;
    let counter = 0;
    const setSt = (ex: Ex, s: Status) => setStatus((prev) => (prev[ex] === s ? prev : { ...prev, [ex]: s }));

    const cleanups = ADAPTERS.map((a) => {
      let ws: WebSocket | null = null;
      let retry = 0, pinger = 0, gotTrade = false, unavailable = false;
      const connect = () => {
        if (dead || unavailable) return;
        try { ws = new WebSocket(a.url(C)); } catch { setSt(a.ex, "unavailable"); return; }
        ws.onopen = () => {
          setSt(a.ex, gotTrade ? "live" : "waiting");
          if (a.subscribe) ws!.send(JSON.stringify(a.subscribe(C)));
          if (a.ping) pinger = window.setInterval(() => { try { ws!.send(a.ping!.msg); } catch { /* closed */ } }, a.ping.everyMs);
        };
        ws.onmessage = (e) => {
          let d: unknown;
          try { d = JSON.parse(String(e.data)); } catch { return; } // "pong" etc.
          const out = a.parse(d);
          if (out === "error") { unavailable = true; setSt(a.ex, "unavailable"); ws?.close(); return; }
          if (!out || !out.length) return;
          if (!gotTrade) { gotTrade = true; setSt(a.ex, "live"); }
          for (const r of out) {
            if (!(r.price > 0 && r.qty > 0)) continue;
            const usd = r.price * r.qty;
            const v = volRef.current[a.ex];
            if (r.buy) v.buy += usd; else v.sell += usd;
            if (usd >= TAPE_MIN_USD) pendingRef.current.push({ id: counter++, ex: a.ex, price: r.price, usd, isBuy: r.buy, time: r.time || Date.now() });
          }
        };
        ws.onclose = () => {
          clearInterval(pinger);
          if (dead || unavailable) return;
          setSt(a.ex, "connecting");
          retry = window.setTimeout(connect, 3000);
        };
        ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
      };
      connect();
      return () => { clearTimeout(retry); clearInterval(pinger); try { ws?.close(); } catch { /* ignore */ } };
    });

    // Batch into React a few times a second (Binance alone is ~50+ trades/s).
    let last = 0;
    const flush = (now: number) => {
      if (now - last > 200) {
        last = now;
        if (pendingRef.current.length) {
          const batch = pendingRef.current.splice(0);
          setTrades((prev) => [...prev, ...batch].slice(-MAX));
        }
        setPerEx(JSON.parse(JSON.stringify(volRef.current)));
      }
      rafRef.current = requestAnimationFrame(flush);
    };
    rafRef.current = requestAnimationFrame(flush);

    return () => {
      dead = true;
      cancelAnimationFrame(rafRef.current);
      cleanups.forEach((c) => c());
      pendingRef.current = [];
    };
  }, [coin]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [trades.length]);

  const buyVol  = EXCHANGES.reduce((s, e) => s + perEx[e].buy, 0);
  const sellVol = EXCHANGES.reduce((s, e) => s + perEx[e].sell, 0);
  const delta   = buyVol - sellVol;
  const total   = buyVol + sellVol;
  const buyPct  = total > 0 ? (buyVol / total) * 100 : 50;
  const liveCount = EXCHANGES.filter((e) => status[e] === "live").length;
  const fmtUsd  = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
                              : n >= 1_000     ? `$${(n / 1_000).toFixed(1)}K`
                              : `$${n.toFixed(0)}`;
  // Signed: −$31.0K used to show as "$31.0K" (red but no minus).
  const fmtSigned = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtUsd(Math.abs(n))}`;
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="oft-root">
      <div className="oft-status">
        <span className={`oft-dot ${liveCount > 0 ? "oft-dot--live" : ""}`} />
        {liveCount > 0 ? `${t("orderFlowTape.live")} · ${t("orderFlowTape2.exchangesLive", { live: liveCount, total: EXCHANGES.length })}` : t("orderFlowTape.connecting")}
      </div>

      {/* Buy/sell volume, delta and per-exchange breakdown need an account. */}
      {!user ? (
        <LockCard
          featureName={t("orderFlowTape2.lockName")}
          plan="free"
          onOpenAuth={onOpenAuth}
          className="oft-lock"
        />
      ) : (<>
      <div className="oft-stats">
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.buyVolume")}</span>
          <span className="oft-stat-val oft-buy">{fmtUsd(buyVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.sellVolume")}</span>
          <span className="oft-stat-val oft-sell">{fmtUsd(sellVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.delta")}</span>
          <span className={`oft-stat-val ${delta >= 0 ? "oft-buy" : "oft-sell"}`}>{fmtSigned(delta)}</span>
        </div>
      </div>

      <div className="oft-pressure-wrap">
        <div className="oft-pressure-bar">
          <div className="oft-pressure-buy" style={{ width: `${buyPct}%` }} />
        </div>
        <div className="oft-pressure-labels">
          <span className="oft-buy">{buyPct.toFixed(1)}{t("orderFlowTape.buy")}</span>
          <span className="oft-sell">{(100 - buyPct).toFixed(1)}{t("orderFlowTape.sell")}</span>
        </div>
      </div>

      {/* Per exchange: feed status, share of all volume, its own delta. */}
      <div className="oft-ex-grid">
        {EXCHANGES.map((e) => {
          const v = perEx[e];
          const vol = v.buy + v.sell;
          const d = v.buy - v.sell;
          const st = status[e];
          return (
            <div key={e} className={`oft-ex oft-ex--${st}`}>
              <span className="oft-ex-name"><i className={`oft-ex-dot oft-ex-dot--${st}`} />{e}</span>
              {st === "unavailable"
                ? <span className="oft-ex-na">{t("orderFlowTape2.noMarket", { coin: coin.toUpperCase() })}</span>
                : st === "live"
                  ? <>
                      <span className="oft-ex-share">{t("orderFlowTape2.volShare", { pct: total > 0 ? ((vol / total) * 100).toFixed(0) : 0 })}</span>
                      <span className={`oft-ex-delta ${d >= 0 ? "oft-buy" : "oft-sell"}`}>{fmtSigned(d)}</span>
                    </>
                  : <span className="oft-ex-na">{st === "waiting" ? t("orderFlowTape2.waitingTrades") : t("orderFlowTape2.connecting")}</span>}
            </div>
          );
        })}
      </div>
      </>)}

      <div className="oft-tape-header oft-tape-header--ex">
        <span>{t("orderFlowTape.colPrice")}</span><span>{t("orderFlowTape.colSize")}</span><span>{t("orderFlowTape2.colExchange")}</span><span>{t("orderFlowTape.colSide")}</span><span>{t("orderFlowTape.colTime")}</span>
      </div>
      <div className="oft-tape" ref={listRef}>
        {[...trades].reverse().map((trade) => (
          <div key={trade.id} className={`oft-row oft-row--ex${trade.usd >= BIG_TRADE_THRESHOLD ? " oft-row--big" : ""} ${trade.isBuy ? "oft-row--buy" : "oft-row--sell"}`}>
            <span className="oft-col-price">{trade.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className="oft-col-size">{fmtUsd(trade.usd)}</span>
            <span className="oft-col-ex">{trade.ex}</span>
            <span className={`oft-col-side ${trade.isBuy ? "oft-buy" : "oft-sell"}`}>{trade.isBuy ? t("orderFlowTape.sideBuy") : t("orderFlowTape.sideSell")}</span>
            <span className="oft-col-time">{fmtTime(trade.time)}</span>
          </div>
        ))}
        {trades.length === 0 && <div className="oft-empty">{t("orderFlowTape.waiting")}</div>}
      </div>
      <p className="oft-note">{t("orderFlowTape2.note", { min: fmtUsd(TAPE_MIN_USD) })}</p>
    </div>
  );
}
