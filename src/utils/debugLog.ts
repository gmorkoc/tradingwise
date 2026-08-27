type Listener = (lines: string[]) => void;

const buffer: string[] = [];
const listeners = new Set<Listener>();
const MAX_LINES = 40;

export function logDebug(msg: string): void {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
  // Deferred: logDebug is called from inside component render bodies (e.g.
  // AppGate's render-decision logging), so notifying listeners synchronously
  // would be a setState-during-another-component's-render call.
  queueMicrotask(() => listeners.forEach(l => l([...buffer])));
}

export function subscribeDebug(listener: Listener): () => void {
  listener([...buffer]);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
