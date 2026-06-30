export interface WhaleTx {
  id: string;
  hash: string;
  amount: number; // BTC
  time: number;   // ms
  from: string;
  to: string;
  fromRaw: string;
  toRaw: string;
  sentiment: "bullish" | "bearish" | "neutral";
}

const THRESHOLD_BTC = 25;
const THRESHOLD_SAT = Math.round(THRESHOLD_BTC * 1e8);
const POLL_MS = 60_000;
const MAX_PER_POLL = 10;

const BLOCKCHAIR_URL =
  `https://api.blockchair.com/bitcoin/mempool/transactions` +
  `?q=output_total(${THRESHOLD_SAT}..)&limit=${MAX_PER_POLL}&s=id(desc)`;

// ── Singleton polling state ──────────────────────────────────────────────────

type Callback = (tx: WhaleTx) => void;

interface BlockchairTx {
  id: number;
  hash: string;
  output_total: number;
  time: string;
}

const listeners = new Set<Callback>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastMaxId = 0;
let seeded = false;

async function poll() {
  try {
    const res = await fetch(BLOCKCHAIR_URL);
    if (!res.ok) return;
    const json = await res.json();
    const txs: BlockchairTx[] = json.data ?? [];
    if (!txs.length) return;

    const newMaxId = Math.max(...txs.map(t => t.id));

    if (!seeded) {
      // First poll: seed the cursor, don't fire alerts (avoid flood on mount)
      lastMaxId = newMaxId;
      seeded = true;
      return;
    }

    const newTxs = txs.filter(t => t.id > lastMaxId);
    lastMaxId = Math.max(lastMaxId, newMaxId);

    for (const tx of newTxs) {
      const alert: WhaleTx = {
        id: `${tx.hash.slice(0, 10)}-${Date.now()}`,
        hash: tx.hash,
        amount: tx.output_total / 1e8,
        time: Date.now(),
        from: "Unknown",
        to: "Unknown",
        fromRaw: "",
        toRaw: "",
        sentiment: "neutral",
      };
      listeners.forEach(cb => cb(alert));
    }
  } catch { /* silently ignore network errors */ }
}

function scheduleNext() {
  pollTimer = setTimeout(async () => {
    await poll();
    if (listeners.size > 0) scheduleNext();
  }, POLL_MS);
}

function startPolling() {
  poll();         // immediate seed poll
  scheduleNext(); // then every 60 s
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  seeded = false;
  lastMaxId = 0;
}

export function subscribeWhaleAlerts(cb: Callback): () => void {
  listeners.add(cb);
  if (listeners.size === 1) startPolling();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopPolling();
  };
}
