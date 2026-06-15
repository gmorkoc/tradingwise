import { useState } from "react";
import { useTranslation } from "react-i18next";

type Model = "duplet" | "triplet" | "convergence";

interface Leg { price: string; size: string; }
interface Factor { name: string; price: string; strength: number; }

const LEG_COUNTS: Record<Model, number> = { duplet: 2, triplet: 3, convergence: 0 };

const FACTOR_PRESETS = [
  "Support Level", "Resistance Level", "EMA 20", "EMA 50", "EMA 200",
  "Order Block", "Fair Value Gap", "Liquidity Level", "VWAP", "POC",
];

export function ExecutionPlanner() {
  const { t } = useTranslation();
  const [model, setModel]         = useState<Model>("duplet");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [stopLoss, setStopLoss]   = useState("");
  const [target, setTarget]       = useState("");
  const [legs, setLegs]           = useState<Leg[]>([
    { price: "", size: "" }, { price: "", size: "" },
  ]);
  const [factors, setFactors]     = useState<Factor[]>([
    { name: "Support Level", price: "", strength: 4 },
    { name: "Order Block",   price: "", strength: 5 },
    { name: "EMA 200",       price: "", strength: 3 },
  ]);

  const switchModel = (m: Model) => {
    setModel(m);
    if (m !== "convergence") {
      const n = LEG_COUNTS[m];
      setLegs(prev => {
        const base = prev.slice(0, n);
        while (base.length < n) base.push({ price: "", size: "" });
        return base;
      });
    }
  };

  const updateLeg = (i: number, f: keyof Leg, v: string) =>
    setLegs(p => p.map((l, j) => j === i ? { ...l, [f]: v } : l));

  const updateFactor = (i: number, f: keyof Factor, v: string | number) =>
    setFactors(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));

  const activeLegCount = LEG_COUNTS[model] || 0;
  const activeLeg = model === "convergence" ? [] : legs.slice(0, activeLegCount);
  const validLegs = activeLeg.filter(l => l.price && l.size && +l.price > 0 && +l.size > 0);
  const totalSize = validLegs.reduce((s, l) => s + +l.size, 0);
  const avgEntry  = totalSize > 0
    ? validLegs.reduce((s, l) => s + +l.price * +l.size, 0) / totalSize : 0;

  const sl = parseFloat(stopLoss);
  const tp = parseFloat(target);
  const riskUnit   = avgEntry && sl ? Math.abs(avgEntry - sl) : 0;
  const rewardUnit = avgEntry && tp ? Math.abs(tp - avgEntry) : 0;
  const rr         = riskUnit > 0 ? rewardUnit / riskUnit : 0;
  const totalRisk  = avgEntry > 0 && riskUnit > 0 ? (riskUnit / avgEntry) * totalSize : 0;

  const validF = factors.filter(f => f.price && +f.price > 0);
  const totalStrength = validF.reduce((s, f) => s + f.strength, 0);
  const convZone = totalStrength > 0
    ? validF.reduce((s, f) => s + +f.price * f.strength, 0) / totalStrength : 0;

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rrColor = rr >= 3 ? "ep-good" : rr >= 2 ? "ep-ok" : rr >= 1 ? "ep-warn" : "ep-danger";

  return (
    <div className="ep-root">
      <div className="ep-model-tabs">
        {(["duplet", "triplet", "convergence"] as Model[]).map(m => (
          <button key={m} className={`ep-model-tab${model === m ? " ep-model-tab--active" : ""}`} onClick={() => switchModel(m)}>
            {m === "duplet" ? t("executionPlanner.duplet") : m === "triplet" ? t("executionPlanner.triplet") : t("executionPlanner.convergence")}
          </button>
        ))}
      </div>

      <div className="ep-body">
        {model !== "convergence" ? (
          <div className="ep-split">
            <div className="ep-left">
              <div className="ep-dir-row">
                <button className={`ep-dir${direction === "long" ? " ep-dir--long" : ""}`} onClick={() => setDirection("long")}>{t("executionPlanner.long")}</button>
                <button className={`ep-dir${direction === "short" ? " ep-dir--short" : ""}`} onClick={() => setDirection("short")}>{t("executionPlanner.short")}</button>
              </div>

              <div className="ep-legs">
                {activeLeg.map((leg, i) => (
                  <div className="ep-leg" key={i}>
                    <div className="ep-leg-num">{t("executionPlanner.entryN", { n: i + 1 })}</div>
                    <input className="ep-input" type="number" placeholder={t("executionPlanner.price")} value={leg.price} onChange={e => updateLeg(i, "price", e.target.value)} />
                    <input className="ep-input" type="number" placeholder={t("executionPlanner.size")} value={leg.size} onChange={e => updateLeg(i, "size", e.target.value)} />
                  </div>
                ))}
              </div>

              <div className="ep-sltp">
                <div className="ep-field">
                  <label>{t("executionPlanner.stopLoss")}</label>
                  <input className="ep-input ep-input--sl" type="number" placeholder={t("executionPlanner.price")} value={stopLoss} onChange={e => setStopLoss(e.target.value)} />
                </div>
                <div className="ep-field">
                  <label>{t("executionPlanner.takeProfit")}</label>
                  <input className="ep-input ep-input--tp" type="number" placeholder={t("executionPlanner.price")} value={target} onChange={e => setTarget(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="ep-right">
              <div className="ep-results-title">{t("executionPlanner.summary")}</div>
              <div className="ep-results">
                <div className="ep-result-row"><span>{t("executionPlanner.avgEntry")}</span><strong>{avgEntry ? `$${fmt(avgEntry)}` : "—"}</strong></div>
                <div className="ep-result-row"><span>{t("executionPlanner.totalPosition")}</span><strong>{totalSize ? `$${totalSize.toLocaleString()}` : "—"}</strong></div>
                <div className="ep-result-row"><span>{t("executionPlanner.riskPerLeg")}</span><strong className="ep-danger">{riskUnit ? `${((riskUnit / avgEntry) * 100).toFixed(2)}%` : "—"}</strong></div>
                <div className="ep-result-row"><span>{t("executionPlanner.totalRisk")}</span><strong className="ep-danger">{totalRisk ? `$${fmt(totalRisk)}` : "—"}</strong></div>
                <div className="ep-result-row ep-result-row--rr">
                  <span>{t("executionPlanner.rrRatio")}</span>
                  <strong className={rrColor}>{rr ? `${rr.toFixed(2)}R` : "—"}</strong>
                </div>
              </div>

              {validLegs.length >= 2 && (
                <div className="ep-breakdown">
                  <div className="ep-breakdown-title">{t("executionPlanner.legBreakdown")}</div>
                  {validLegs.map((l, i) => {
                    const legRisk = riskUnit > 0 && avgEntry > 0
                      ? ((riskUnit / avgEntry) * +l.size) : 0;
                    const wt = totalSize > 0 ? (+l.size / totalSize) * 100 : 0;
                    return (
                      <div className="ep-breakdown-row" key={i}>
                        <span>{t("executionPlanner.entryN", { n: i + 1 })}</span>
                        <span>${(+l.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span>{wt.toFixed(0)}%</span>
                        <span className="ep-danger">{legRisk ? `$${fmt(legRisk)}` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="ep-split">
            <div className="ep-left">
              <p className="ep-conv-desc">{t("executionPlanner.convDesc")}</p>
              <div className="ep-conv-factors">
                {factors.map((f, i) => (
                  <div className="ep-conv-factor" key={i}>
                    <select className="ep-input ep-input--select" value={f.name}
                      onChange={e => updateFactor(i, "name", e.target.value)}>
                      {FACTOR_PRESETS.map(p => <option key={p}>{p}</option>)}
                    </select>
                    <input className="ep-input" type="number" placeholder={t("executionPlanner.priceLevel")} value={f.price}
                      onChange={e => updateFactor(i, "price", e.target.value)} />
                    <div className="ep-strength-dots">
                      {[1,2,3,4,5].map(s => (
                        <button key={s}
                          className={`ep-sdot${f.strength >= s ? " ep-sdot--on" : ""}`}
                          onClick={() => updateFactor(i, "strength", s)} />
                      ))}
                    </div>
                    <button className="ep-remove-factor" onClick={() => setFactors(p => p.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <button className="ep-add-factor" onClick={() => setFactors(p => [...p, { name: "Support Level", price: "", strength: 3 }])}>
                  {t("executionPlanner.addFactor")}
                </button>
              </div>
            </div>

            <div className="ep-right">
              <div className="ep-results-title">{t("executionPlanner.convergenceZone")}</div>
              {convZone > 0 ? (
                <>
                  <div className="ep-conv-zone-price">${fmt(convZone)}</div>
                  <div className="ep-conv-zone-sub">
                    {validF.length === 1
                      ? t("executionPlanner.weightedAvg", { count: validF.length })
                      : t("executionPlanner.weightedAvgPlural", { count: validF.length })}
                  </div>
                  <div className="ep-conv-bars">
                    {validF.map((f, i) => (
                      <div className="ep-conv-bar-row" key={i}>
                        <span className="ep-conv-bar-name">{f.name}</span>
                        <div className="ep-conv-bar-track">
                          <div className="ep-conv-bar-fill" style={{ width: `${(f.strength / 5) * 100}%` }} />
                        </div>
                        <span className="ep-conv-bar-price">${fmt(+f.price)}</span>
                        <span className="ep-conv-bar-str">{"★".repeat(f.strength)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="ep-conv-hint">{t("executionPlanner.addFactorsHint")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
