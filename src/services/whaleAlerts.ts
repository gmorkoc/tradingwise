export interface WhaleTx {
  id: string;
  hash: string;
  amount: number; // BTC
  time: number;   // ms
  from: string;   // entity label or truncated address
  to: string;
  fromRaw: string;
  toRaw: string;
  sentiment: "bullish" | "bearish" | "neutral";
}

const THRESHOLD_BTC = 10;
const MAX_PER_MINUTE = 20;

// Well-known exchange / institutional BTC hot wallet addresses
const KNOWN_ENTITIES: Record<string, string> = {
  // Binance
  "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo": "Binance",
  "3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb": "Binance",
  "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s": "Binance",
  "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h": "Binance",
  "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97": "Binance",
  // Coinbase
  "1FzWLkAahHooV3kzTgyx6qsswXJ6sCXkSR": "Coinbase",
  "3Cbq7aT1tY8kMxWLBkgvFCBJaVtOC8tHFm": "Coinbase",
  "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh": "Coinbase",
  // Kraken
  "3FupZp77ySr7jwoLYEJ9mwzJpvoNBXsBnE": "Kraken",
  "3AfP8f6cZbNrSgRfJDaxQTBBuGmpBqkJw5": "Kraken",
  "bc1qjasf9z3h7w3jspkhtgatgpyvvzgpa2wwd2lr0eh5tx44reyn2k7sfc27a4": "Kraken",
  // Bitfinex
  "3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r": "Bitfinex",
  "1KkjJXFbFQ6BqEbehkVLRN14k5JQQnwrXm": "Bitfinex",
  // OKX
  "3LCGsSmfr24demGvriN4e3ft8wEcDuHFqh": "OKX",
  "1GkQmKAmHtNfnD3LHhTkewJxKHVSta4m2a": "OKX",
  // Bybit
  "3MJGginXd2HXaEqG4JpJj2XtSYZrLBFJjD": "Bybit",
  // HTX (Huobi)
  "1Ak8vBMfECGNRmDnxqaJAVDRDnBDfRyNfV": "HTX",
  "1HckjUpRGcrrRAtFaaCAUaGjsPx9oYmLaZ": "HTX",
  // Gemini
  "1GvKARoASVjSYNXEEBHyFpFNaFJrXb4uoG": "Gemini",
  // Upbit
  "3LBVMPFTMauWuWMG4bXuqXicfKJGGFGiMt": "Upbit",
  // MicroStrategy
  "bc1q9d3xa5gg45q2j39szguun23rv7snkejjlm54a0": "MicroStrategy",
};

const EXCHANGES = new Set([
  "Binance", "Coinbase", "Kraken", "Bitfinex", "OKX", "Bybit", "HTX", "Gemini", "Upbit",
]);

function sentiment(fromLabel: string, toLabel: string): WhaleTx["sentiment"] {
  const fromEx = EXCHANGES.has(fromLabel);
  const toEx   = EXCHANGES.has(toLabel);
  if (toEx && !fromEx) return "bearish";
  if (fromEx && !toEx) return "bullish";
  return "neutral";
}

function truncate(addr: string): string {
  if (!addr) return "Unknown";
  if (addr.startsWith("bc1")) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function labelAddr(addr: string): string {
  return KNOWN_ENTITIES[addr] || truncate(addr);
}

// mempool.space transaction format
interface MempoolVin {
  prevout?: {
    scriptpubkey_address?: string;
    value?: number;
  };
}
interface MempoolVout {
  scriptpubkey_address?: string;
  value?: number;
}
interface MempoolTx {
  txid: string;
  vin: MempoolVin[];
  vout: MempoolVout[];
}

function parseAlert(tx: MempoolTx): WhaleTx | null {
  const inputs  = tx.vin  ?? [];
  const outputs = tx.vout ?? [];

  const amount = outputs.reduce((s, o) => s + (o.value ?? 0), 0) / 1e8;
  if (amount < THRESHOLD_BTC) return null;

  // From = input with the largest value
  const mainInput = inputs.reduce<MempoolVin | null>((best, inp) => {
    const v = inp.prevout?.value ?? 0;
    return v > ((best?.prevout?.value) ?? 0) ? inp : best;
  }, null);
  const fromAddr = mainInput?.prevout?.scriptpubkey_address ?? "";

  // To = largest output that is not a change address
  const inputAddrs = new Set(inputs.map(i => i.prevout?.scriptpubkey_address).filter(Boolean));
  const recipients = outputs.filter(o => o.scriptpubkey_address && !inputAddrs.has(o.scriptpubkey_address));
  const pool = recipients.length > 0 ? recipients : outputs;
  const mainOutput = pool.reduce<MempoolVout | null>((best, o) => {
    return (o.value ?? 0) > ((best?.value) ?? 0) ? o : best;
  }, null);
  const toAddr = mainOutput?.scriptpubkey_address ?? "";

  const fromLbl = labelAddr(fromAddr);
  const toLbl   = labelAddr(toAddr);
  return {
    id: `${tx.txid.slice(0, 10)}-${Date.now()}`,
    hash: tx.txid,
    amount,
    time: Date.now(),
    from: fromLbl,
    to: toLbl,
    fromRaw: fromAddr,
    toRaw: toAddr,
    sentiment: sentiment(fromLbl, toLbl),
  };
}

// ── WebSocket singleton ──────────────────────────────────────────────────────

type Callback = (tx: WhaleTx) => void;
type StatusCallback = (connected: boolean) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
let recentCount = 0;
const listeners = new Set<Callback>();
const statusListeners = new Set<StatusCallback>();

function notifyStatus(connected: boolean) {
  statusListeners.forEach(cb => cb(connected));
}

function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  try {
    ws = new WebSocket("wss://mempool.space/api/v1/ws");

    ws.onopen = () => {
      ws!.send(JSON.stringify({ action: "want", data: ["transactions"] }));
      notifyStatus(true);
    };

    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data as string);
        const txList: MempoolTx[] = msg["transactions"] ?? [];
        for (const tx of txList) {
          if (recentCount >= MAX_PER_MINUTE) break;
          const alert = parseAlert(tx);
          if (!alert) continue;
          recentCount++;
          if (!rateLimitTimer) {
            rateLimitTimer = setTimeout(() => {
              recentCount = 0;
              rateLimitTimer = null;
            }, 60_000);
          }
          listeners.forEach(cb => cb(alert));
        }
      } catch {}
    };

    ws.onerror = () => ws?.close();

    ws.onclose = () => {
      ws = null;
      notifyStatus(false);
      if (listeners.size > 0) reconnectTimer = setTimeout(connect, 3_000);
    };
  } catch { notifyStatus(false); }
}

export function subscribeWhaleStatus(cb: StatusCallback): () => void {
  statusListeners.add(cb);
  cb(ws?.readyState === WebSocket.OPEN);
  return () => statusListeners.delete(cb);
}

export function subscribeWhaleAlerts(cb: Callback): () => void {
  listeners.add(cb);
  if (listeners.size === 1) connect();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rateLimitTimer) clearTimeout(rateLimitTimer);
      ws?.close();
      ws = null;
    }
  };
}
