import { BottomSheet } from "./BottomSheet";

// "How to use Pro Vision" — shown the first time Pro Vision is switched on,
// and from the Signal check card's "How to use" link any time after.

// What each piece on the chart means.
const ON_CHART: { title: string; text: string }[] = [
  { title: "Painted ribbon", text: "A fan of moving averages behind the candles. The band paints green while buyers are in control and red while sellers are — flips in color are where trends turn." },
  { title: "Colored candles", text: "Green or red when a real trend is underway, yellow when there isn’t one." },
  { title: "TP", text: "Marks where a past Buy or Sell would have closed in profit." },
  { title: "BUY / SELL", text: "Fires only when most of the 7 checks agree and the bigger-picture trend points the same way. On charts under 4h the new trend must also hold for 3 candles with solid strength. A ✓ marks past signals that ended in profit." },
  { title: "Invalidation zone", text: "The glowing band and dashed line show where the latest signal would be proven wrong, tagged with its Δ Volume." },
  { title: "⚡ Spikes", text: "Sudden, news-like candles. Signals that bet against a fresh spike are skipped for a few candles." },
  { title: "Event countdown", text: "Big scheduled US releases — Fed decisions, CPI, jobs, GDP — show up to a day ahead. Signals pause from 30 minutes before until an hour after each one." },
  { title: "Sideways tag + range box", text: "When price drifts in a range, a grey box marks its ceiling and floor. Trend signals hold off on charts under 4h; from 1h up, range mode adds R·BUY near the floor and R·SELL near the ceiling until price breaks out." },
  { title: "Thin market tag", text: "Shows when too little is trading for reliable signals. BUY/SELL switch off until volume returns." },
  { title: "“Signals: 15m” tag", text: "On 1m and 5m charts, signals come from the 15m chart and are placed on yours, so you get 15m direction with short-chart timing." },
];

const BEST_USES: { title: string; text: string }[] = [
  {
    title: "Confirm before you enter",
    text: "Glance at the Signal check verdict first. When most checks point one way, think twice before taking the other side.",
  },
  {
    title: "Set your stop with a reason",
    text: "The dashed invalidation line marks where the signal stops making sense. It’s a ready-made stop level, and the gap to it tells you how big a position to take.",
  },
  {
    title: "See the trend instantly",
    text: "Colored candles show a market that’s moving with purpose. A chart full of grey is a market without direction — often a good time to wait.",
  },
  {
    title: "Catch stretched moves",
    text: "A strong trend with RSI or Stochastic at an extreme may be running out of steam. Late entries there carry extra risk.",
  },
  {
    title: "Follow the real money",
    text: "Δ Volume uses actual market buys and sells from the exchange. A signal backed by heavy one-sided volume is stronger than one without it.",
  },
  {
    title: "Check the track record",
    text: "Before trusting a signal, look at how this chart’s past ones did — not just how often they won, but average win vs. loss and the result per trade after fees.",
  },
  {
    title: "Let winners run",
    text: "From 15m up, the track record trails your stop behind the price and exits when the trend turns. Expect fewer wins but much bigger ones — cutting winners early is what hurts most.",
  },
];

// Classic weak spots of chart signals — and what Pro Vision does about each.
const SAFEGUARDS: { title: string; text: string }[] = [
  { title: "Tiny moves on 1m–5m", text: "Short candles move less than fees, so these charts borrow the 15m chart’s signals. You get 15m direction with short-chart timing." },
  { title: "Choppy ranges", text: "Trend signals step aside when price goes sideways. From 1h up, range mode trades bounces off the box edges instead; below 1h it marks the box and waits for a breakout." },
  { title: "Scheduled news", text: "Fed decisions, CPI, jobs and GDP are flagged up to a day ahead, and signals pause from 30 minutes before to an hour after." },
  { title: "Sudden shocks", text: "Outsized candles are marked ⚡, and signals that bet against a fresh shock are skipped." },
  { title: "Thin markets", text: "When too little is trading, signals switch off instead of guessing." },
];

// What no safeguard can remove.
const LIMITS: { title: string; text: string }[] = [
  { title: "Surprise headlines", text: "Unscheduled news can’t be seen coming on any chart — size positions for the unexpected." },
  { title: "Past ≠ future", text: "Track records come from this chart’s recent history. Markets change, and small samples can flatter or mislead." },
];

const WORKFLOW = [
  "Take your direction from the 4h or daily chart.",
  "Act on signals from 15m up; on 1m–5m they’re the 15m signals, so use the short chart to time your entry.",
  "Place your stop at the invalidation line, then trail it as price moves your way.",
  "Check the track record pays off after fees.",
  "Try the setup in Paper Trading first.",
];

export function ProVisionGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={<>How to use ProVision</>}
      ariaLabel="How to use ProVision"
      className="pvg-sheet"
      desktopModal
    >
      <div className="pvg">
        <section className="pvg-section">
          <h3 className="pvg-h">What you’re seeing</h3>
          <ul className="pvg-list">
            {ON_CHART.map((o) => (
              <li key={o.title} className="pvg-item">
                <span className="pvg-dot pvg-dot--blue" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{o.title}:</strong> {o.text}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">Best uses</h3>
          <ol className="pvg-list">
            {BEST_USES.map((u, i) => (
              <li key={u.title} className="pvg-item">
                <span className="pvg-num" aria-hidden="true">{i + 1}</span>
                <span className="pvg-body">
                  <strong>{u.title}.</strong> {u.text}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">Built-in safeguards</h3>
          <ul className="pvg-list">
            {SAFEGUARDS.map((w) => (
              <li key={w.title} className="pvg-item">
                <span className="pvg-dot pvg-dot--green" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{w.title}:</strong> {w.text}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">Still worth knowing</h3>
          <ul className="pvg-list">
            {LIMITS.map((w) => (
              <li key={w.title} className="pvg-item">
                <span className="pvg-dot" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{w.title}:</strong> {w.text}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">A sensible workflow</h3>
          <ol className="pvg-steps">
            {WORKFLOW.map((s, i) => (
              <li key={s} className="pvg-step">
                <span className="pvg-step-num" aria-hidden="true">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>

        <button type="button" className="pvg-done" onClick={onClose}>Got it</button>
      </div>
    </BottomSheet>
  );
}
