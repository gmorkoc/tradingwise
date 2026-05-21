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

const THRESHOLD_BTC = 100;
const MAX_PER_MINUTE = 5;

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
  if (toEx && !fromEx) return "bearish";  // deposit → exchange (selling intent)
  if (fromEx && !toEx) return "bullish";  // withdrawal from exchange (self-custody)
  return "neutral";
}

function truncate(addr: string): string {
  if (!addr) return "Unknown";
  if (addr.startsWith("bc1")) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function label(addr: string): string {
  return KNOWN_ENTITIES[addr] || truncate(addr);
}

function parseAlert(tx: Record<string, unknown>): WhaleTx | null {
  const inputs = (tx.inputs as { prev_out?: { addr?: string; value?: number } }[]) ?? [];
  const outputs = (tx.out as { addr?: string; value?: number }[]) ?? [];

  // Total BTC moved (sum of outputs)
  const amount = outputs.reduce((s, o) => s + (o.value ?? 0), 0) / 1e8;
  if (amount < THRESHOLD_BTC) return null;

  // From = address with the largest input value
  const mainInput = inputs.reduce<typeof inputs[number] | null>((best, inp) => {
    const v = inp.prev_out?.value ?? 0;
    return v > ((best?.prev_out?.value) ?? 0) ? inp : best;
  }, null);
  const fromAddr = mainInput?.prev_out?.addr ?? "";

  // To = largest output that is NOT a change address (i.e. not an input address)
  const inputAddrs = new Set(inputs.map(i => i.prev_out?.addr).filter(Boolean));
  const recipients = outputs.filter(o => o.addr && !inputAddrs.has(o.addr));
  const pool = recipients.length > 0 ? recipients : outputs;
  const mainOutput = pool.reduce<typeof outputs[number] | null>((best, o) => {
    return (o.value ?? 0) > ((best?.value) ?? 0) ? o : best;
  }, null);
  const toAddr = mainOutput?.addr ?? "";

  const fromLabel = label(fromAddr);
  const toLabel   = label(toAddr);
  return {
    id: `${(tx.hash as string).slice(0, 10)}-${Date.now()}`,
    hash: tx.hash as string,
    amount,
    time: Date.now(),
    from: fromLabel,
    to: toLabel,
    fromRaw: fromAddr,
    toRaw: toAddr,
    sentiment: sentiment(fromLabel, toLabel),
  };
}

// ── WebSocket singleton ──────────────────────────────────────────────────────

type Callback = (tx: WhaleTx) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
let recentCount = 0;
const listeners = new Set<Callback>();

function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  try {
    ws = new WebSocket("wss://ws.blockchain.info/inv");

    ws.onopen = () => {
      ws!.send(JSON.stringify({ op: "unconfirmed_sub" }));
    };

    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data as string);
        if (msg.op !== "utx") return;
        if (recentCount >= MAX_PER_MINUTE) return;

        const alert = parseAlert(msg.x);
        if (!alert) return;

        recentCount++;
        if (!rateLimitTimer) {
          rateLimitTimer = setTimeout(() => {
            recentCount = 0;
            rateLimitTimer = null;
          }, 60_000);
        }

        listeners.forEach(cb => cb(alert));
      } catch {}
    };

    ws.onerror = () => ws?.close();

    ws.onclose = () => {
      ws = null;
      if (listeners.size > 0) reconnectTimer = setTimeout(connect, 8_000);
    };
  } catch {}
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
