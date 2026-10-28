import { useState } from "react";
import { useAIQuota } from "../hooks/useAIQuota";
import {
  buildIndicatorWithAI, saveCustomIndicator, type CustomIndicator,
} from "../services/customIndicators";

// "Build with AI": the user describes an indicator in plain words, the AI
// returns a recipe (never code — see customIndicators.ts), it's saved to
// "My indicators" and switched on so they see it on the chart right away.
// They can keep refining it in plain words. One build = one AI request.

const EXAMPLES = [
  "EMA 21 that turns green above EMA 55 and red below",
  "Dots under candles when RSI crosses back above 30",
  "MACD histogram that's brighter when momentum is growing",
  "Band of 20 SMA ± 2 ATR",
];

interface Props {
  /** Refining an existing indicator instead of building a new one. */
  existing?: CustomIndicator;
  isPaid: boolean;
  onUpgrade?: () => void;
  /** Make sure the indicator is on the chart (new builds). */
  onAdded: (id: string) => void;
  onDone: () => void;
}

export function AIIndicatorBuilder({ existing, isPaid, onUpgrade, onAdded, onDone }: Props) {
  const { consume, exceeded, remaining } = useAIQuota();
  const [current, setCurrent] = useState<CustomIndicator | undefined>(existing);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    if (!isPaid) { onUpgrade?.(); return; }
    if (exceeded) { setError("You've used all your AI requests for this week."); return; }
    setBusy(true);
    setError(null);
    try {
      const ok = await consume();
      if (!ok) { setError("You've used all your AI requests for this week."); return; }
      const recipe = await buildIndicatorWithAI(prompt, current?.recipe);
      const ci: CustomIndicator = {
        id: current?.id ?? `ai-${Date.now().toString(36)}`,
        prompt: current ? `${current.prompt}\n→ ${prompt}` : prompt,
        recipe,
        createdAt: current?.createdAt ?? Date.now(),
      };
      saveCustomIndicator(ci);
      if (!current) onAdded(ci.id);
      setCurrent(ci);
      setText("");
    } catch (e) {
      setError((e as Error).message || "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aib">
      {current ? (
        <div className="aib-result">
          <div className="aib-result-head">
            <span className="aib-spark" aria-hidden="true">✦</span>
            <span className="aib-result-name">{current.recipe.name}</span>
            <span className="aib-result-tag">{current.recipe.placement === "pane" ? "Own panel" : "On price"}</span>
          </div>
          <p className="aib-result-desc">{current.recipe.description}</p>
          <p className="aib-result-note">Saved to My indicators and added to the chart.</p>
        </div>
      ) : (
        <>
          <div className="aib-intro">
            <span className="aib-spark" aria-hidden="true">✦</span>
            <div>
              <div className="aib-intro-title">Describe the indicator you want</div>
              <p className="aib-intro-text">The AI builds it from proven indicator blocks, saves it to My indicators and draws it on your chart.</p>
            </div>
          </div>
          <div className="aib-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="aib-example" onClick={() => setText(ex)}>{ex}</button>
            ))}
          </div>
        </>
      )}

      <div className="aib-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          placeholder={current ? "What should change? e.g. make it faster, add a signal line…" : "e.g. Show me when price closes above the 20-day high with rising volume"}
          rows={3}
          maxLength={500}
          disabled={busy}
        />
        <div className="aib-actions">
          <span className="aib-quota">
            {isPaid ? (Number.isFinite(remaining) ? `Uses 1 AI request · ${remaining} left this week` : "Uses 1 AI request") : "AI indicators are a Pro feature"}
          </span>
          {current && <button type="button" className="aib-btn aib-btn--ghost" onClick={onDone} disabled={busy}>Done</button>}
          <button type="button" className="aib-btn" onClick={() => (isPaid ? run() : onUpgrade?.())} disabled={busy || (isPaid && !text.trim())}>
            {busy ? <><span className="aib-spinner" />Building…</> : !isPaid ? "Upgrade to build" : current ? "Refine" : "Build indicator"}
          </button>
        </div>
      </div>
      {error && <p className="aib-error">{error}</p>}
    </div>
  );
}
