import { useState } from "react";

interface TP { price: string; pct: string; }

export function TradeManager() {
  const [direction,   setDirection]   = useState<"long" | "short">("long");
  const [entry,       setEntry]       = useState("");
  const [stopLoss,    setStopLoss]    = useState("");
  const [invalidation,setInvalidation]= useState("");
  const [accountSize, setAccountSize] = useState("");
  const [riskPct,     setRiskPct]     = useState("1");
  const [tps, setTps] = useState<TP[]>([
    { price: "", pct: "25" },
    { price: "", pct: "50" },
    { price: "", pct: "25" },
  ]);

  const ep       = parseFloat(entry);
  const sl       = parseFloat(stopLoss);
  const acc      = parseFloat(accountSize);
  const rPct     = parseFloat(riskPct) / 100;
  const invPrice = parseFloat(invalidation);

  const riskUnit    = ep && sl ? Math.abs(ep - sl) : 0;
  const riskPctVal  = ep ? riskUnit / ep : 0;
  const dollarRisk  = acc && rPct ? acc * rPct : 0;
  const posSize     = riskUnit && ep ? (dollarRisk / riskUnit) * ep : 0;
  const units       = posSize && ep ? posSize / ep : 0;

  const tpMetrics = tps.map(t => {
    const tpP = parseFloat(t.price);
    const tpPct = parseFloat(t.pct) / 100;
    if (!tpP || !ep || !riskUnit) return null;
    const reward   = Math.abs(tpP - ep);
    const rr       = riskUnit > 0 ? reward / riskUnit : 0;
    const profit   = posSize && ep ? units * reward * tpPct : 0;
    const partialUnits = units * tpPct;
    return { tpP, rr, profit, partialUnits };
  });

  const totalTpPct  = tps.reduce((s, t) => s + (parseFloat(t.pct) || 0), 0);
  const pctOk       = Math.abs(totalTpPct - 100) < 0.1;
  const invalidBreached = invPrice && ep && sl
    ? (direction === "long" ? invPrice >= sl : invPrice <= sl)
    : false;

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rrColor = (rr: number) => rr >= 3 ? "tm-good" : rr >= 2 ? "tm-ok" : rr >= 1 ? "tm-warn" : "tm-danger";

  // Price ladder levels
  const ladderLevels = [
    ...tps.map((t, i) => ({ label: `TP${i + 1}`, price: parseFloat(t.price), type: "tp" })),
    { label: "Entry", price: ep, type: "entry" },
    { label: "Stop",  price: sl, type: "sl"    },
    ...(invPrice ? [{ label: "Invalid.", price: invPrice, type: "inv" }] : []),
  ].filter(l => l.price > 0)
   .sort((a, b) => direction === "long" ? b.price - a.price : a.price - b.price);

  return (
    <div className="tm-root">
      <div className="tm-layout">
        {/* ── Left: Inputs ───────────────────────────────────────────── */}
        <div className="tm-inputs">
          <div className="tm-dir-row">
            <button className={`tm-dir${direction === "long"  ? " tm-dir--long"  : ""}`} onClick={() => setDirection("long")}>▲ Long</button>
            <button className={`tm-dir${direction === "short" ? " tm-dir--short" : ""}`} onClick={() => setDirection("short")}>▼ Short</button>
          </div>

          <div className="tm-section-label">Account & Risk</div>
          <div className="tm-field-grid">
            <div className="tm-field">
              <label>Account Size ($)</label>
              <input className="tm-input" type="number" placeholder="10000" value={accountSize} onChange={e => setAccountSize(e.target.value)} />
            </div>
            <div className="tm-field">
              <label>Risk (%)</label>
              <input className="tm-input" type="number" placeholder="1" value={riskPct} onChange={e => setRiskPct(e.target.value)} step="0.1" />
            </div>
          </div>

          <div className="tm-section-label">Trade Levels</div>
          <div className="tm-field-grid">
            <div className="tm-field">
              <label>Entry Price</label>
              <input className="tm-input" type="number" placeholder="Price" value={entry} onChange={e => setEntry(e.target.value)} />
            </div>
            <div className="tm-field">
              <label>Stop Loss</label>
              <input className="tm-input tm-input--sl" type="number" placeholder="Price" value={stopLoss} onChange={e => setStopLoss(e.target.value)} />
            </div>
            <div className="tm-field tm-field--full">
              <label>Invalidation Level <span className="tm-label-hint">(hard close)</span></label>
              <input className={`tm-input tm-input--inv${invalidBreached ? " tm-input--breached" : ""}`} type="number" placeholder="Price" value={invalidation} onChange={e => setInvalidation(e.target.value)} />
              {invalidBreached && <span className="tm-inv-warn">⚠ Invalidation is beyond your stop — review placement</span>}
            </div>
          </div>

          <div className="tm-section-label">
            Take Profits
            <span className={`tm-pct-total ${pctOk ? "tm-good" : "tm-warn"}`}>{totalTpPct}%</span>
          </div>
          <div className="tm-tps">
            {tps.map((t, i) => (
              <div className="tm-tp-row" key={i}>
                <span className="tm-tp-label">TP{i + 1}</span>
                <input className="tm-input tm-input--tp" type="number" placeholder="Price" value={t.price}
                  onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
                <input className="tm-input tm-input--pct" type="number" placeholder="%" value={t.pct}
                  onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                <span className="tm-pct-unit">%</span>
                {tps.length > 1 && (
                  <button className="tm-remove-tp" onClick={() => setTps(p => p.filter((_, j) => j !== i))}>✕</button>
                )}
              </div>
            ))}
            {tps.length < 5 && (
              <button className="tm-add-tp" onClick={() => setTps(p => [...p, { price: "", pct: "0" }])}>+ Add TP</button>
            )}
          </div>
        </div>

        {/* ── Right: Results ──────────────────────────────────────────── */}
        <div className="tm-results">
          <div className="tm-results-block">
            <div className="tm-results-title">Position Summary</div>
            <div className="tm-results-grid">
              <div className="tm-res"><span>Position Size</span><strong>{posSize ? `$${fmt(posSize)}` : "—"}</strong></div>
              <div className="tm-res"><span>Units</span><strong>{units ? units.toFixed(4) : "—"}</strong></div>
              <div className="tm-res"><span>Dollar Risk</span><strong className="tm-danger">{dollarRisk ? `$${fmt(dollarRisk)}` : "—"}</strong></div>
              <div className="tm-res"><span>Risk on Entry</span><strong className="tm-danger">{riskPctVal ? `${(riskPctVal * 100).toFixed(2)}%` : "—"}</strong></div>
            </div>
          </div>

          <div className="tm-results-block">
            <div className="tm-results-title">Target Breakdown</div>
            {tpMetrics.map((m, i) => m && (
              <div className="tm-tp-result" key={i}>
                <div className="tm-tp-result-top">
                  <span>TP{i + 1} <span className="tm-tp-pct">({tps[i].pct}%)</span></span>
                  <span className={rrColor(m.rr)}>{m.rr.toFixed(2)}R</span>
                </div>
                <div className="tm-tp-result-bot">
                  <span>@ ${fmt(m.tpP)}</span>
                  <span className="tm-good">+${fmt(m.profit)}</span>
                </div>
              </div>
            ))}
            {tpMetrics.every(m => !m) && <p className="tm-hint">Fill in entry, stop, and TP levels to see your breakdown.</p>}
          </div>

          {/* Price ladder */}
          {ladderLevels.length >= 2 && (
            <div className="tm-results-block">
              <div className="tm-results-title">Price Ladder</div>
              <div className="tm-ladder">
                {ladderLevels.map((l, i) => (
                  <div key={i} className={`tm-ladder-row tm-ladder--${l.type}`}>
                    <span className="tm-ladder-lbl">{l.label}</span>
                    <div className="tm-ladder-line">
                      <div className="tm-ladder-dot" />
                    </div>
                    <span className="tm-ladder-price">${fmt(l.price)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
