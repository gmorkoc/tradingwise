// Shared predictions link: https://www.coinhintz.io/chart/<coin>?predict=1
// (opens the iOS app when installed — /chart/* is a Universal Link).
// The link's coin is remembered here until the chart can open predictions —
// right away for signed-in users, or after sign-in / sign-up for guests.

const KEY = "pendingPredictCoin";
export const PENDING_PREDICT_EVENT = "pending-predict";

export function setPendingPredict(coin: string) {
  try { sessionStorage.setItem(KEY, coin); } catch { /* ignore */ }
  window.dispatchEvent(new Event(PENDING_PREDICT_EVENT));
}

export function getPendingPredict(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export function clearPendingPredict() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** The public link that opens predictions for a coin. */
export function predictShareUrl(coinName: string): string {
  const slug = coinName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `https://www.coinhintz.io/chart/${slug}?predict=1`;
}
