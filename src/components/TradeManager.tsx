import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import { getTradeReview, TradeReviewResult, callOpenAI } from "../services/openai";
import "../styles/RiskCalculator.css";

interface TP { price: string; pct: string; }
type ExpLevel = "beginner" | "experienced";

interface Props {
  onOpenAuth?:    () => void;
  onOpenUpgrade?: () => void;
}

const VERDICT_META: Record<string, { key: string; cls: string }> = {
  solid:  { key: "solid",  cls: "rcp-verdict--solid"  },
  adjust: { key: "adjust", cls: "rcp-verdict--adjust" },
  risky:  { key: "risky",  cls: "rcp-verdict--risky"  },
};
const GRADE_CLS: Record<string, string> = { A: "rcp-grade--a", B: "rcp-grade--b", C: "rcp-grade--c", D: "rcp-grade--d" };

function fmtPrice(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rrColor(rr: number) {
  return rr >= 3 ? "rcp-good" : rr >= 2 ? "rcp-ok" : rr >= 1 ? "rcp-warn" : "rcp-danger";
}

// ── Shared calculation hook ──────────────────────────────────────────────────
function useTradeCalc(entry: string, stopLoss: string, accountSize: string, riskPct: string, tps: TP[], direction: "long" | "short", invalidation: string) {
  const ep       = parseFloat(entry);
  const sl       = parseFloat(stopLoss);
  const acc      = parseFloat(accountSize);
  const rPct     = parseFloat(riskPct) / 100;
  const invPrice = parseFloat(invalidation);

  const riskUnit   = ep && sl ? Math.abs(ep - sl) : 0;
  const riskPctVal = ep ? riskUnit / ep : 0;
  const dollarRisk = acc && rPct ? acc * rPct : 0;
  const posSize    = riskUnit && ep ? (dollarRisk / riskUnit) * ep : 0;
  const units      = posSize && ep ? posSize / ep : 0;

  const tpMetrics = tps.map(tp => {
    const tpP   = parseFloat(tp.price);
    const tpPct = parseFloat(tp.pct) / 100;
    if (!tpP || !ep || !riskUnit) return null;
    const reward = Math.abs(tpP - ep);
    const rr     = riskUnit > 0 ? reward / riskUnit : 0;
    const profit = posSize && ep ? units * reward * tpPct : 0;
    return { tpP, rr, profit };
  });

  const totalTpPct      = tps.reduce((s, tp) => s + (parseFloat(tp.pct) || 0), 0);
  const pctOk           = Math.abs(totalTpPct - 100) < 0.1;
  const invalidBreached = invPrice && ep && sl
    ? (direction === "long" ? invPrice >= sl : invPrice <= sl) : false;

  return { ep, sl, acc, rPct, invPrice, riskUnit, riskPctVal, dollarRisk, posSize, units, tpMetrics, totalTpPct, pctOk, invalidBreached };
}

// ── AI hook ──────────────────────────────────────────────────────────────────
function useAiReview(isPro: boolean, user: any, onOpenAuth?: () => void, onOpenUpgrade?: () => void) {
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult,  setAiResult]  = useState<TradeReviewResult | null>(null);
  const [aiError,   setAiError]   = useState<string | null>(null);
  const cancelRef = useRef(false);

  async function runReview(input: Parameters<typeof getTradeReview>[0]) {
    if (!user) { onOpenAuth?.(); return; }
    if (!isPro) { onOpenUpgrade?.(); return; }
    cancelRef.current = false;
    setAiLoading(true); setAiResult(null); setAiError(null);
    const res = await getTradeReview(input);
    if (cancelRef.current) return;
    setAiLoading(false);
    if (res.success && res.result) setAiResult(res.result);
    else setAiError(res.error ?? "AI review failed");
  }

  function cancel() { cancelRef.current = true; setAiLoading(false); }

  return { aiLoading, aiResult, aiError, runReview, cancel };
}

// ── Level Picker ──────────────────────────────────────────────────────────────
function LevelPicker({ onSelect }: { onSelect: (l: ExpLevel) => void }) {
  const { t } = useTranslation();
  return (
    <div className="rc-root">
      <div className="rc-picker">
        <div className="rc-picker-header">
          <div className="rc-picker-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 4H8"/><path d="M3 4h.01"/><path d="M21 12H11"/><path d="M3 12h.01"/><path d="M21 20H8"/><path d="M3 20h.01"/><path d="M8 2v4"/><path d="M11 10v4"/><path d="M8 18v4"/>
            </svg>
          </div>
          <h2 className="rc-picker-title">{t("posCalc.picker.title")}</h2>
          <p className="rc-picker-sub">{t("posCalc.picker.sub")}</p>
        </div>
        <div className="rc-picker-cards">
          <button className="rc-picker-card rc-picker-card--beginner" onClick={() => onSelect("beginner")}>
            <div className="rc-card-icon">📚</div>
            <p className="rc-card-name">{t("posCalc.picker.beginnerName")}</p>
            <p className="rc-card-desc">{t("posCalc.picker.beginnerDesc")}</p>
            <span className="rc-card-arrow">{t("posCalc.picker.beginnerCta")}</span>
          </button>
          <button className="rc-picker-card rc-picker-card--exp" onClick={() => onSelect("experienced")}>
            <div className="rc-card-icon">⚡</div>
            <p className="rc-card-name">{t("posCalc.picker.expName")}</p>
            <p className="rc-card-desc">{t("posCalc.picker.expDesc")}</p>
            <span className="rc-card-arrow">{t("posCalc.picker.expCta")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Beginner Wizard ───────────────────────────────────────────────────────────
function BeginnerWizard({ onSwitchMode, onOpenAuth, onOpenUpgrade }: { onSwitchMode: () => void; onOpenAuth?: () => void; onOpenUpgrade?: () => void }) {
  const { t } = useTranslation();
  const { tier, user } = useAuth();
  const isPro = hasAccess(tier, "pro");

  const [step,        setStep]        = useState(1);
  const [direction,   setDirection]   = useState<"long" | "short">("long");
  const [entry,       setEntry]       = useState("");
  const [stopLoss,    setStopLoss]    = useState("");
  const [invalidation,setInvalidation]= useState("");
  const [accountSize, setAccountSize] = useState("");
  const [riskPct,     setRiskPct]     = useState("1");
  const [tps, setTps] = useState<TP[]>([{ price: "", pct: "50" }, { price: "", pct: "50" }]);

  const { ep, sl, invPrice, riskUnit, dollarRisk, posSize, units, tpMetrics, totalTpPct, pctOk, invalidBreached } =
    useTradeCalc(entry, stopLoss, accountSize, riskPct, tps, direction, invalidation);

  const { aiLoading, aiResult, aiError, runReview, cancel } = useAiReview(isPro, user, onOpenAuth, onOpenUpgrade);

  const [tipLoading, setTipLoading] = useState(false);
  const [tipText,    setTipText]    = useState<string | null>(null);
  const [tipError,   setTipError]   = useState<string | null>(null);
  const [tipStep,    setTipStep]    = useState<number | null>(null);
  const tipCancel = useRef(false);

  async function askStepAI() {
    if (!user) { onOpenAuth?.(); return; }
    if (!isPro) { onOpenUpgrade?.(); return; }

    const rPct = parseFloat(riskPct) || 1;
    const dr   = dollarRisk > 0 ? `$${fmtPrice(dollarRisk)} at risk per trade` : "";
    const tpLines = tpMetrics
      .map((m, i) => m ? `TP${i + 1}: $${fmtPrice(m.tpP)} = ${m.rr.toFixed(2)}R (${tps[i].pct}% of position)` : null)
      .filter(Boolean).join("\n") || "No targets set yet";

    const prompts: Record<number, string> = {
      1: `You are a professional crypto risk manager. Give brief, direct advice.
Account Size: ${accountSize ? `$${fmtPrice(parseFloat(accountSize))}` : "not set"}
Risk Per Trade: ${rPct}%${dr ? ` (${dr})` : ""}
In 2-3 sentences: is this risk % sound? What is the professional standard and why? Plain text only.`,

      2: `You are a professional crypto trader. The user is deciding their trade direction.
Chosen direction: ${direction.toUpperCase()}
In 2-3 sentences: what key signals should confirm this direction, and what would invalidate it? Plain text only.`,

      3: `You are a professional crypto risk manager. Review this trade structure.
Direction: ${direction.toUpperCase()}
Entry: ${ep > 0 ? `$${fmtPrice(ep)}` : "not set"}
Stop Loss: ${sl > 0 ? `$${fmtPrice(sl)}` : "not set"}
Stop Distance: ${ep > 0 && sl > 0 ? `${(riskUnit / ep * 100).toFixed(2)}%` : "not calculated"}
${dr ? `Dollar at Risk: ${dr}` : ""}
In 2-3 sentences: is this stop placement logical? What should a trader consider when placing a stop loss? Plain text only.`,

      4: `You are a professional crypto trader. Review these take profit targets.
Direction: ${direction.toUpperCase()}
Entry: ${ep > 0 ? `$${fmtPrice(ep)}` : "not set"} | Stop: ${sl > 0 ? `$${fmtPrice(sl)}` : "not set"}
${tpLines}
In 2-3 sentences: is this TP structure sensible? What R:R minimums should traders aim for and why? Plain text only.`,

      5: `You are a professional crypto risk manager. Briefly assess this complete trade plan.
Direction: ${direction.toUpperCase()} | Entry: ${ep > 0 ? `$${fmtPrice(ep)}` : "?"} | Stop: ${sl > 0 ? `$${fmtPrice(sl)}` : "?"}
${tpLines}
Risk: ${rPct}%${dr ? ` (${dr})` : ""}
In 2-3 sentences: how does this plan look overall? Is it well-structured? Plain text only.`,
    };

    tipCancel.current = false;
    setTipLoading(true);
    setTipText(null);
    setTipError(null);
    setTipStep(step);

    try {
      const res = await callOpenAI({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompts[step] }],
        temperature: 0.4,
        max_tokens: 200,
      });
      if (tipCancel.current) return;
      setTipText(res?.choices?.[0]?.message?.content ?? "No response");
    } catch {
      if (!tipCancel.current) setTipError("AI tip failed — try again");
    } finally {
      if (!tipCancel.current) setTipLoading(false);
    }
  }

  const rPctNum = parseFloat(riskPct) || 1;
  const riskLevel = rPctNum <= 1 ? "low" : rPctNum <= 2.5 ? "mid" : "high";
  const riskMsg = rPctNum <= 1
    ? t("posCalc.s1.riskLow")
    : rPctNum <= 2.5
    ? t("posCalc.s1.riskMid")
    : t("posCalc.s1.riskHigh");

  const STEPS = [t("posCalc.steps.account"), t("posCalc.steps.direction"), t("posCalc.steps.levels"), t("posCalc.steps.targets"), t("posCalc.steps.review")];

  const canNext: Record<number, boolean> = {
    1: !!accountSize && parseFloat(accountSize) > 0,
    2: true,
    3: !!(ep && sl),
    4: tps.some(tp => parseFloat(tp.price) > 0),
    5: true,
  };

  async function handleAiTake() {
    const validTps = tpMetrics
      .map((m, i) => m ? { price: m.tpP, allocationPct: parseFloat(tps[i].pct) || 0, rr: m.rr, profit: m.profit } : null)
      .filter(Boolean) as { price: number; allocationPct: number; rr: number; profit: number }[];
    await runReview({
      direction, entry: ep, stopLoss: sl,
      riskPct: rPctNum,
      positionSize: posSize || undefined,
      dollarRisk: dollarRisk || undefined,
      invalidation: invPrice || undefined,
      tps: validTps,
    });
  }

  return (
    <div className="rc-root rcw-root">
      {/* Top bar */}
      <div className="rcw-top">
        <div className="rcw-progress">
          {STEPS.map((_, i) => (
            <div key={i} className={`rcw-dot ${i + 1 < step ? "rcw-dot--done" : i + 1 === step ? "rcw-dot--active" : ""}`} />
          ))}
          <span className="rcw-step-label" style={{ marginLeft: 8 }}>{STEPS[step - 1]}</span>
        </div>
        <span className="rcw-switch-row">{t("posCalc.mode.beginner")} <button className="rcw-switch" onClick={onSwitchMode}>{t("posCalc.mode.switchToPro")}</button></span>
      </div>

      {/* Step body */}
      <div className="rcw-body" key={step}>
        {step === 1 && (
          <>
            <div className="rcw-step-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
            </div>
            <h2 className="rcw-step-title">{t("posCalc.s1.title")}</h2>
            <p className="rcw-step-desc">{t("posCalc.s1.desc")}</p>
            <div className="rcw-fields">
              <div className="rcw-field">
                <label className="rcw-field-label">{t("posCalc.s1.accountSize")}</label>
                <div className="rcw-input-wrap">
                  <span className="rcw-prefix">$</span>
                  <input className="rcw-input rcw-input--has-prefix" type="number" placeholder="10000" value={accountSize} onChange={e => setAccountSize(e.target.value)} autoFocus />
                </div>
              </div>
              <div className="rcw-field">
                <label className="rcw-field-label">{t("posCalc.s1.riskPerTrade")}</label>
                <div className="rcw-slider-row">
                  <input className="rcw-slider" type="range" min="0.25" max="5" step="0.25" value={riskPct} onChange={e => setRiskPct(e.target.value)} />
                  <span className="rcw-slider-val">{riskPct}%</span>
                </div>
                <div className={`rcw-risk-meter rcw-risk-meter--${riskLevel}`}>
                  <div className="rcw-risk-dot" />
                  {accountSize && parseFloat(accountSize) > 0
                    ? t("posCalc.s1.wouldRisk", { amount: fmtPrice(parseFloat(accountSize) * parseFloat(riskPct) / 100) }) + " "
                    : ""}
                  {riskMsg}
                </div>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="rcw-step-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </div>
            <h2 className="rcw-step-title">{t("posCalc.s2.title")}</h2>
            <p className="rcw-step-desc" dangerouslySetInnerHTML={{ __html: t("posCalc.s2.desc") }} />
            <div className="rcw-dir-cards">
              <button className={`rcw-dir-card rcw-dir-card--long${direction === "long" ? " rcw-dir-card--active" : ""}`} onClick={() => setDirection("long")}>
                <span className="rcw-dir-emoji">📈</span>
                <p className="rcw-dir-name">{t("posCalc.s2.longName")}</p>
                <p className="rcw-dir-desc" dangerouslySetInnerHTML={{ __html: t("posCalc.s2.longDesc") }} />
              </button>
              <button className={`rcw-dir-card rcw-dir-card--short${direction === "short" ? " rcw-dir-card--active" : ""}`} onClick={() => setDirection("short")}>
                <span className="rcw-dir-emoji">📉</span>
                <p className="rcw-dir-name">{t("posCalc.s2.shortName")}</p>
                <p className="rcw-dir-desc" dangerouslySetInnerHTML={{ __html: t("posCalc.s2.shortDesc") }} />
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="rcw-step-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-5"/></svg>
            </div>
            <h2 className="rcw-step-title">{t("posCalc.s3.title")}</h2>
            <p className="rcw-step-desc" dangerouslySetInnerHTML={{ __html: t("posCalc.s3.desc") }} />
            <div className="rcw-fields">
              <div className="rcw-field">
                <label className="rcw-field-label">{t("posCalc.s3.entryLabel")}</label>
                <div className="rcw-input-wrap">
                  <span className="rcw-prefix">$</span>
                  <input className="rcw-input rcw-input--has-prefix" type="number" placeholder="e.g. 65000" value={entry} onChange={e => setEntry(e.target.value)} />
                </div>
                <p className="rcw-field-hint">{direction === "long" ? t("posCalc.s3.entryHintLong") : t("posCalc.s3.entryHintShort")}</p>
              </div>
              <div className="rcw-field">
                <label className="rcw-field-label">{t("posCalc.s3.slLabel")}</label>
                <div className="rcw-input-wrap">
                  <span className="rcw-prefix">$</span>
                  <input className={`rcw-input rcw-input--has-prefix rcw-input--sl`} type="number"
                    placeholder={direction === "long" ? "e.g. 62000" : "e.g. 68000"}
                    value={stopLoss} onChange={e => setStopLoss(e.target.value)} />
                </div>
                <p className="rcw-field-hint">{t("posCalc.s3.slHint")}<br />
                  {direction === "long" ? t("posCalc.s3.slBelowEntry") : t("posCalc.s3.slAboveEntry")}</p>
              </div>
              <div className="rcw-field">
                <label className="rcw-field-label">{t("posCalc.s3.invLabel")} <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, opacity: 0.7 }}>{t("posCalc.s3.invOptional")}</span></label>
                <div className="rcw-input-wrap">
                  <span className="rcw-prefix">$</span>
                  <input className={`rcw-input rcw-input--has-prefix rcw-input--sl${invalidBreached ? " rcw-input--breached" : ""}`} type="number"
                    placeholder="e.g. 61000" value={invalidation} onChange={e => setInvalidation(e.target.value)} />
                </div>
                {invalidBreached && <span style={{ fontSize: "0.72rem", color: "#ef4444" }}>{t("posCalc.s3.invWarn")}</span>}
                <p className="rcw-field-hint">{t("posCalc.s3.invHint")}</p>
              </div>
              {ep > 0 && sl > 0 && riskUnit > 0 && (
                <div className={`rcw-risk-meter rcw-risk-meter--${dollarRisk ? "low" : "mid"}`}>
                  <div className="rcw-risk-dot" />
                  {t("posCalc.s3.stopDist")} <strong>{(riskUnit / ep * 100).toFixed(2)}%</strong>
                  {dollarRisk > 0 && <> · {t("posCalc.s3.dollarRisk")} <strong>${fmtPrice(dollarRisk)}</strong></>}
                </div>
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="rcw-step-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 3.9 2.4-7.4L2 9.4h7.6z"/></svg>
            </div>
            <h2 className="rcw-step-title">{t("posCalc.s4.title")}</h2>
            <p className="rcw-step-desc" dangerouslySetInnerHTML={{ __html: t("posCalc.s4.desc") }} />
            <div className="rcw-fields">
              {tps.map((tp, i) => {
                const m = tpMetrics[i];
                return (
                  <div className="rcw-tp-row" key={i}>
                    <div className="rcw-tp-badge">TP{i + 1}</div>
                    <div className="rcw-field" style={{ flex: 1 }}>
                      <label className="rcw-field-label">{t("posCalc.s4.targetLabel", { n: i + 1 })}</label>
                      <div className="rcw-input-wrap">
                        <span className="rcw-prefix">$</span>
                        <input className="rcw-input rcw-input--has-prefix rcw-input--tp" type="number"
                          placeholder={direction === "long" ? t("posCalc.s4.above") : t("posCalc.s4.below")}
                          value={tp.price}
                          onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
                      </div>
                    </div>
                    <div className="rcw-field" style={{ width: 80 }}>
                      <label className="rcw-field-label">{t("posCalc.s4.closeLabel")}</label>
                      <div className="rcw-input-wrap">
                        <input className="rcw-input" type="number" placeholder="50" value={tp.pct}
                          onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                        <span className="rcw-suffix">%</span>
                      </div>
                    </div>
                    <div className="rcw-tp-rr">
                      {m ? <span className={rrColor(m.rr)}>{m.rr.toFixed(1)}R</span> : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                    </div>
                    {tps.length > 1 && (
                      <button style={{ background: "none", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: "0.9rem", marginTop: 18, padding: "0 2px" }}
                        onClick={() => setTps(p => p.filter((_, j) => j !== i))}>✕</button>
                    )}
                  </div>
                );
              })}
              {tps.length < 4 && (
                <button className="rcp-add-tp" onClick={() => setTps(p => [...p, { price: "", pct: "0" }])}>{t("posCalc.s4.addTarget")}</button>
              )}
              {!pctOk && tps.some(tp => tp.pct) && (
                <div className={`rcw-risk-meter rcw-risk-meter--${totalTpPct > 100 ? "high" : "mid"}`}>
                  <div className="rcw-risk-dot" />
                  {t("posCalc.s4.pctWarn", { total: totalTpPct })}
                </div>
              )}
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <div className="rcw-step-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
            </div>
            <h2 className="rcw-step-title">{t("posCalc.s5.title")}</h2>
            <p className="rcw-step-desc">{t("posCalc.s5.desc")}</p>
            <div className="rcw-summary">
              <div className="rcw-summary-card">
                <div className="rcw-summary-card-title">{t("posCalc.s5.posSummary")}</div>
                <div className="rcw-summary-grid">
                  <div className="rcw-summary-stat">
                    <span className="rcw-summary-stat-label">{t("posCalc.s5.direction")}</span>
                    <span className="rcw-summary-stat-val" style={{ color: direction === "long" ? "#22c55e" : "#ef4444" }}>
                      {direction === "long" ? t("posCalc.s5.long") : t("posCalc.s5.short")}
                    </span>
                  </div>
                  <div className="rcw-summary-stat">
                    <span className="rcw-summary-stat-label">{t("posCalc.s5.entry")}</span>
                    <span className="rcw-summary-stat-val">{ep ? `$${fmtPrice(ep)}` : "—"}</span>
                  </div>
                  <div className="rcw-summary-stat">
                    <span className="rcw-summary-stat-label">{t("posCalc.s5.stopLoss")}</span>
                    <span className="rcw-summary-stat-val" style={{ color: "#ef4444" }}>{sl ? `$${fmtPrice(sl)}` : "—"}</span>
                  </div>
                  <div className="rcw-summary-stat">
                    <span className="rcw-summary-stat-label">{t("posCalc.s5.dollarAtRisk")}</span>
                    <span className="rcw-summary-stat-val" style={{ color: "#ef4444" }}>{dollarRisk ? `$${fmtPrice(dollarRisk)}` : "—"}</span>
                  </div>
                  {posSize > 0 && (
                    <>
                      <div className="rcw-summary-stat">
                        <span className="rcw-summary-stat-label">{t("posCalc.s5.positionSize")}</span>
                        <span className="rcw-summary-stat-val">${fmtPrice(posSize)}</span>
                      </div>
                      <div className="rcw-summary-stat">
                        <span className="rcw-summary-stat-label">{t("posCalc.s5.units")}</span>
                        <span className="rcw-summary-stat-val">{units.toFixed(4)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {tpMetrics.some(m => m) && (
                <div className="rcw-summary-card">
                  <div className="rcw-summary-card-title">{t("posCalc.s5.tpTargets")}</div>
                  {tpMetrics.map((m, i) => m && (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--color-border)" }}>
                      <span style={{ fontSize: "0.82rem" }}>TP{i + 1} @ ${fmtPrice(m.tpP)} <span style={{ color: "var(--color-text-secondary)" }}>({tps[i].pct}%)</span></span>
                      <span>
                        <span className={rrColor(m.rr)} style={{ fontWeight: 800, fontSize: "0.86rem", marginRight: 12 }}>{m.rr.toFixed(2)}R</span>
                        {m.profit > 0 && <span className="rcp-good" style={{ fontSize: "0.8rem" }}>+${fmtPrice(m.profit)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* AI Take */}
              {onOpenAuth !== undefined && (
                <button
                  className={`rcp-ai-btn${!(ep && sl) ? " rcp-ai-btn--disabled" : ""}`}
                  onClick={handleAiTake}
                  disabled={aiLoading || !(ep && sl)}
                >
                  {aiLoading ? (
                    <><span className="rcp-ai-spinner" /> {t("posCalc.ai.analyzing")}
                      <button className="rcp-ai-cancel" onClick={e => { e.stopPropagation(); cancel(); }}>✕</button>
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/><path d="M18 2v4h4"/></svg>
                      {t("posCalc.ai.aiTake")}
                      {!isPro && <span className="rcp-ai-badge">PRO</span>}
                    </>
                  )}
                </button>
              )}
              {aiError && <div style={{ fontSize: "0.78rem", color: "#fca5a5", padding: "4px 0" }}>⚠ {aiError}</div>}
              {aiResult && <AiResultPanel result={aiResult} />}
            </div>
          </>
        )}
        {/* Per-step AI tip — shown on steps 1-4; step 5 has full AI Take */}
        {onOpenAuth !== undefined && step < 5 && (
          <div className="rcw-ai-tip-wrap">
            <button
              className="rcw-ai-tip-btn"
              onClick={askStepAI}
              disabled={tipLoading}
            >
              {tipLoading && tipStep === step ? (
                <><span className="rcw-ai-tip-spinner" /> {t("posCalc.ai.askingAi")}
                  <button className="rcw-ai-tip-cancel" onClick={e => { e.stopPropagation(); tipCancel.current = true; setTipLoading(false); }}>✕</button>
                </>
              ) : (
                <>
                  ✦
                  {t("posCalc.ai.askStep")}
                  {!isPro && <span className="rcw-ai-tip-badge">PRO</span>}
                </>
              )}
            </button>
            {tipStep === step && tipText && (
              <div className="rcw-ai-tip-result">
                <span style={{ color: "#a78bfa", flexShrink: 0, fontSize: "0.9rem" }}>✦</span>
                <span>{tipText}</span>
              </div>
            )}
            {tipStep === step && tipError && (
              <p className="rcw-ai-tip-error">⚠ {tipError}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="rcw-footer">
        {step > 1
          ? <button className="rcw-btn-back" onClick={() => setStep(s => s - 1)}>{t("posCalc.wcNav.back")}</button>
          : <span />
        }
        {step < 5 ? (
          <button className="rcw-btn-next" onClick={() => setStep(s => s + 1)} disabled={!canNext[step]}>
            {step === 4 ? t("posCalc.wcNav.reviewPlan") : t("posCalc.wcNav.continue")}
          </button>
        ) : (
          <button className="rcw-btn-next" onClick={() => { setStep(1); }}>
            {t("posCalc.wcNav.startOver")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── AI result shared panel ────────────────────────────────────────────────────
function AiResultPanel({ result }: { result: TradeReviewResult }) {
  const { t } = useTranslation();
  const verdictMeta = VERDICT_META[result.verdict] ?? VERDICT_META.adjust;
  const gradeCls    = GRADE_CLS[result.grade] ?? "";
  return (
    <div className="rcp-ai-result">
      <div className="rcp-ai-result-header">
        <div className="rcp-ai-result-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
          {t("posCalc.ai.reviewTitle")}
        </div>
        <div className="rcp-ai-badges">
          <span className={`rcp-verdict ${verdictMeta.cls}`}>{t(`posCalc.ai.${verdictMeta.key}`)}</span>
          <span className={`rcp-grade ${gradeCls}`}>{result.grade}</span>
        </div>
      </div>
      <div className="rcp-ai-rows">
        <div className="rcp-ai-row"><span className="rcp-ai-row-lbl">{t("posCalc.ai.rrLabel")}</span><span className="rcp-ai-row-val">{result.rrAssessment}</span></div>
        <div className="rcp-ai-row"><span className="rcp-ai-row-lbl">{t("posCalc.ai.sizeLabel")}</span><span className="rcp-ai-row-val">{result.positionFeedback}</span></div>
        <div className="rcp-ai-row"><span className="rcp-ai-row-lbl">{t("posCalc.ai.targetsLabel")}</span><span className="rcp-ai-row-val">{result.tpStructureFeedback}</span></div>
        <div className={`rcp-ai-row rcp-ai-row--risk`}><span className="rcp-ai-row-lbl">{t("posCalc.ai.riskLabel")}</span><span className="rcp-ai-row-val">{result.keyRisk}</span></div>
        {result.suggestion !== "Setup looks good as-is" && (
          <div className="rcp-ai-row rcp-ai-row--suggest"><span className="rcp-ai-row-lbl">{t("posCalc.ai.tipLabel")}</span><span className="rcp-ai-row-val">{result.suggestion}</span></div>
        )}
      </div>
      <p className="rcp-ai-summary">{result.summary}</p>
    </div>
  );
}

// ── Experienced / Pro UI ──────────────────────────────────────────────────────
function ExperiencedView({ onSwitchMode, onOpenAuth, onOpenUpgrade }: { onSwitchMode: () => void; onOpenAuth?: () => void; onOpenUpgrade?: () => void }) {
  const { t } = useTranslation();
  const { tier, user } = useAuth();
  const isPro = hasAccess(tier, "pro");

  const [direction,    setDirection]    = useState<"long" | "short">("long");
  const [entry,        setEntry]        = useState("");
  const [stopLoss,     setStopLoss]     = useState("");
  const [invalidation, setInvalidation] = useState("");
  const [accountSize,  setAccountSize]  = useState("");
  const [riskPct,      setRiskPct]      = useState("1");
  const [tps, setTps] = useState<TP[]>([{ price: "", pct: "25" }, { price: "", pct: "50" }, { price: "", pct: "25" }]);

  const { ep, sl, invPrice, riskUnit, riskPctVal, dollarRisk, posSize, units, tpMetrics, totalTpPct, pctOk, invalidBreached } =
    useTradeCalc(entry, stopLoss, accountSize, riskPct, tps, direction, invalidation);

  const { aiLoading, aiResult, aiError, runReview, cancel } = useAiReview(isPro, user, onOpenAuth, onOpenUpgrade);

  const canAsk = !!(ep && sl && onOpenAuth !== undefined);

  async function handleAiTake() {
    const validTps = tpMetrics
      .map((m, i) => m ? { price: m.tpP, allocationPct: parseFloat(tps[i].pct) || 0, rr: m.rr, profit: m.profit } : null)
      .filter(Boolean) as { price: number; allocationPct: number; rr: number; profit: number }[];
    await runReview({
      direction, entry: ep, stopLoss: sl,
      riskPct: parseFloat(riskPct) || undefined,
      positionSize: posSize || undefined,
      dollarRisk: dollarRisk || undefined,
      invalidation: invPrice || undefined,
      tps: validTps,
    });
  }

  // ── Visual trade map ─────────────────────────────────────────────────────
  const mapLevels: Array<{ type: "tp" | "sl" | "inv"; label: string; price: number; rr?: number }> = [];
  tps.forEach((tp, i) => {
    const m = tpMetrics[i];
    const p = parseFloat(tp.price);
    if (p > 0) mapLevels.push({ type: "tp", label: `TP${i + 1}`, price: p, rr: m?.rr });
  });
  if (sl > 0) mapLevels.push({ type: "sl", label: t("posCalc.exp.stopLabel"), price: sl });
  if (invPrice > 0) mapLevels.push({ type: "inv", label: t("posCalc.exp.invLabel"), price: invPrice });

  const allPrices = [ep, ...mapLevels.map(l => l.price)].filter(Boolean);
  const maxPrice  = allPrices.length ? Math.max(...allPrices) : 0;
  const minPrice  = allPrices.length ? Math.min(...allPrices) : 0;
  const totalRange = maxPrice - minPrice || 1;

  // Sort for display: tps above entry (high to low), entry, sl/inv below (low to high)
  const tpLevels  = mapLevels.filter(l => l.type === "tp").sort((a, b) => b.price - a.price);
  const slLevels  = mapLevels.filter(l => l.type !== "tp").sort((a, b) => b.price - a.price);

  const barWidth = (price: number) => `${Math.max(8, (Math.abs(price - ep) / totalRange) * 100)}%`;

  return (
    <div className="rc-root">
      {onSwitchMode && (
        <div className="rcp-switch-mode">
          <span>{t("posCalc.mode.experienced")}</span>
          <button onClick={onSwitchMode}>{t("posCalc.mode.switchToBeginner")}</button>
        </div>
      )}
      <div className="rcp-root">
        {/* ── LEFT: Inputs ── */}
        <div className="rcp-inputs">
          {/* Direction */}
          <div className="rcp-dir-row">
            <button className={`rcp-dir${direction === "long"  ? " rcp-dir--long"  : ""}`} onClick={() => setDirection("long")}>▲ Long</button>
            <button className={`rcp-dir${direction === "short" ? " rcp-dir--short" : ""}`} onClick={() => setDirection("short")}>▼ Short</button>
          </div>

          {/* Account & Risk */}
          <div className="rcp-group">
            <span className="rcp-group-label">{t("posCalc.exp.acctRisk")}</span>
            <div className="rcp-field-grid">
              <div className="rcp-field">
                <label className="rcp-field-label">{t("posCalc.exp.accountSize")}</label>
                <div className="rcp-input-wrap">
                  <span className="rcp-prefix">$</span>
                  <input className="rcp-input rcp-input--pfx" type="number" placeholder="10000" value={accountSize} onChange={e => setAccountSize(e.target.value)} />
                </div>
              </div>
              <div className="rcp-field">
                <label className="rcp-field-label">{t("posCalc.exp.riskPct")}</label>
                <div className="rcp-risk-row">
                  <input className="rcp-slider" type="range" min="0.25" max="5" step="0.25" value={riskPct} onChange={e => setRiskPct(e.target.value)} />
                  <span className="rcp-risk-val">{riskPct}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Trade Levels */}
          <div className="rcp-group">
            <span className="rcp-group-label">{t("posCalc.exp.tradeLevels")}</span>
            <div className="rcp-field-grid">
              <div className="rcp-field">
                <label className="rcp-field-label">{t("posCalc.exp.entry")}</label>
                <div className="rcp-input-wrap">
                  <span className="rcp-prefix">$</span>
                  <input className="rcp-input rcp-input--pfx" type="number" placeholder="Price" value={entry} onChange={e => setEntry(e.target.value)} />
                </div>
              </div>
              <div className="rcp-field">
                <label className="rcp-field-label">{t("posCalc.exp.stopLoss")}</label>
                <div className="rcp-input-wrap">
                  <span className="rcp-prefix">$</span>
                  <input className="rcp-input rcp-input--pfx rcp-input--sl" type="number" placeholder="Price" value={stopLoss} onChange={e => setStopLoss(e.target.value)} />
                </div>
              </div>
              <div className="rcp-field rcp-field--full">
                <label className="rcp-field-label">{t("posCalc.exp.inv")} <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, opacity: 0.6 }}>{t("posCalc.exp.hardClose")}</span></label>
                <div className="rcp-input-wrap">
                  <span className="rcp-prefix">$</span>
                  <input className={`rcp-input rcp-input--pfx rcp-input--inv${invalidBreached ? " rcp-input--breached" : ""}`} type="number" placeholder="Price" value={invalidation} onChange={e => setInvalidation(e.target.value)} />
                </div>
                {invalidBreached && <span className="rcp-inv-warn">{t("posCalc.exp.invWarn")}</span>}
              </div>
            </div>
          </div>

          {/* Take Profits */}
          <div className="rcp-group">
            <span className="rcp-group-label">
              {t("posCalc.exp.takeProfits")}
              <span className={`rcp-pct-total ${pctOk ? "rcp-good" : "rcp-warn"}`}>{totalTpPct}%</span>
            </span>
            <div className="rcp-tp-rows">
              {tps.map((tp, i) => (
                <div className="rcp-tp-row" key={i}>
                  <span className="rcp-tp-lbl">TP{i + 1}</span>
                  <div className="rcp-input-wrap" style={{ flex: 1 }}>
                    <span className="rcp-prefix">$</span>
                    <input className="rcp-input rcp-input--pfx rcp-input--tp" type="number" placeholder="Price" value={tp.price}
                      onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
                  </div>
                  <div className="rcp-input-wrap" style={{ width: 64 }}>
                    <input className="rcp-input" type="number" placeholder="%" value={tp.pct} style={{ paddingRight: 24 }}
                      onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                    <span className="rcp-suffix">%</span>
                  </div>
                  {tps.length > 1 && (
                    <button className="rcp-remove-tp" onClick={() => setTps(p => p.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              {tps.length < 5 && (
                <button className="rcp-add-tp" onClick={() => setTps(p => [...p, { price: "", pct: "0" }])}>{t("posCalc.exp.addTarget")}</button>
              )}
            </div>
          </div>

          {/* AI Button */}
          {onOpenAuth !== undefined && (
            <>
              <button
                className={`rcp-ai-btn${!canAsk ? "" : ""}`}
                onClick={handleAiTake}
                disabled={aiLoading || !canAsk}
              >
                {aiLoading ? (
                  <><span className="rcp-ai-spinner" /> {t("posCalc.exp.aiAnalyzing")}
                    <button className="rcp-ai-cancel" onClick={e => { e.stopPropagation(); cancel(); }}>✕</button>
                  </>
                ) : (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
                    {t("posCalc.exp.aiTake")}
                    {!isPro && <span className="rcp-ai-badge">PRO</span>}
                  </>
                )}
              </button>
              {!canAsk && <p className="rcp-ai-hint">{t("posCalc.exp.fillHint")}</p>}
            </>
          )}
        </div>

        {/* ── RIGHT: Results ── */}
        <div className="rcp-results">
          {/* Trade map */}
          <div className="rcp-map">
            <div className="rcp-map-title">{t("posCalc.exp.tradeMap")}</div>
            {!ep ? (
              <div className="rcp-map-empty">{t("posCalc.exp.mapEmpty")}</div>
            ) : (
              <div className="rcp-map-inner">
                {/* TPs (above entry) */}
                {tpLevels.map((l, i) => (
                  <div key={i} className={`rcp-map-level rcp-map--${l.type}`} style={{ paddingBottom: 14 }}>
                    <div className="rcp-map-dot" />
                    <div className="rcp-map-bar" style={{ width: barWidth(l.price) }} />
                    <div className="rcp-map-info">
                      <span className="rcp-map-label">{l.label}</span>
                      <span className="rcp-map-price">${fmtPrice(l.price)}</span>
                      {l.rr != null && <span className={`rcp-map-rr ${rrColor(l.rr)}`}>{l.rr.toFixed(2)}R</span>}
                    </div>
                  </div>
                ))}

                {/* Entry line */}
                <div className="rcp-map-entry-line">
                  <div className="rcp-map-entry-dot" />
                  <span className="rcp-map-entry-label">{t("posCalc.exp.entry")}</span>
                  <span className="rcp-map-entry-price">${fmtPrice(ep)}</span>
                </div>

                {/* SL / Inv (below entry) */}
                {slLevels.map((l, i) => (
                  <div key={i} className={`rcp-map-level rcp-map--${l.type}`} style={{ paddingTop: 14 }}>
                    <div className="rcp-map-dot" />
                    <div className="rcp-map-bar" style={{ width: barWidth(l.price) }} />
                    <div className="rcp-map-info">
                      <span className="rcp-map-label">{l.label}</span>
                      <span className="rcp-map-price">${fmtPrice(l.price)}</span>
                      {l.type === "sl" && riskUnit > 0 && (
                        <span className="rcp-map-rr rcp-danger">-1R</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Position summary */}
          {(posSize > 0 || ep > 0) && (
            <div className="rcp-summary">
              <div className="rcp-stat">
                <span className="rcp-stat-label">{t("posCalc.exp.positionSize")}</span>
                <span className="rcp-stat-val">{posSize ? `$${fmtPrice(posSize)}` : "—"}</span>
              </div>
              <div className="rcp-stat">
                <span className="rcp-stat-label">{t("posCalc.exp.units")}</span>
                <span className="rcp-stat-val">{units ? units.toFixed(4) : "—"}</span>
              </div>
              <div className="rcp-stat">
                <span className="rcp-stat-label">{t("posCalc.exp.dollarAtRisk")}</span>
                <span className="rcp-stat-val rcp-danger">{dollarRisk ? `$${fmtPrice(dollarRisk)}` : "—"}</span>
              </div>
              <div className="rcp-stat">
                <span className="rcp-stat-label">{t("posCalc.exp.stopDist")}</span>
                <span className="rcp-stat-val rcp-danger">{riskPctVal ? `${(riskPctVal * 100).toFixed(2)}%` : "—"}</span>
              </div>
            </div>
          )}

          {/* TP breakdown */}
          <div className="rcp-targets">
            <div className="rcp-targets-title">{t("posCalc.exp.targetBreakdown")}</div>
            {tpMetrics.some(m => m) ? tpMetrics.map((m, i) => m && (
              <div className="rcp-tp-result" key={i}>
                <div className="rcp-tp-result-left">
                  <span className="rcp-tp-result-name">
                    <span style={{ color: "#22c55e" }}>TP{i + 1}</span>
                    <span className="rcp-tp-result-pct">{tps[i].pct}%</span>
                  </span>
                  <span className="rcp-tp-result-price">@ ${fmtPrice(m.tpP)}</span>
                </div>
                <div className="rcp-tp-result-right">
                  <span className={`rcp-tp-result-rr ${rrColor(m.rr)}`}>{m.rr.toFixed(2)}R</span>
                  {m.profit > 0 && <span className="rcp-tp-result-profit">+${fmtPrice(m.profit)}</span>}
                </div>
              </div>
            )) : (
              <p className="rcp-hint">{t("posCalc.exp.tpHint")}</p>
            )}
          </div>

          {/* AI error / result */}
          {aiError && (
            <div className="rcp-ai-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {aiError}
            </div>
          )}
          {aiResult && <AiResultPanel result={aiResult} />}
        </div>
      </div>
    </div>
  );
}

// ── Simple embedded view (used inside OrderFlowFramework tabs) ────────────────
function EmbeddedView() {
  const { t } = useTranslation();
  const [direction,    setDirection]    = useState<"long" | "short">("long");
  const [entry,        setEntry]        = useState("");
  const [stopLoss,     setStopLoss]     = useState("");
  const [invalidation, setInvalidation] = useState("");
  const [accountSize,  setAccountSize]  = useState("");
  const [riskPct,      setRiskPct]      = useState("1");
  const [tps, setTps] = useState<TP[]>([{ price: "", pct: "25" }, { price: "", pct: "50" }, { price: "", pct: "25" }]);

  const { ep, sl, invPrice, riskPctVal, dollarRisk, posSize, units, tpMetrics, totalTpPct, pctOk, invalidBreached } =
    useTradeCalc(entry, stopLoss, accountSize, riskPct, tps, direction, invalidation);

  const ladderLevels = [
    ...tps.map((tp, i) => ({ label: `TP${i + 1}`, price: parseFloat(tp.price), type: "tp" })),
    { label: t("tradeManager.entry"), price: ep, type: "entry" },
    { label: t("tradeManager.stop"),  price: sl, type: "sl" },
    ...(invPrice ? [{ label: t("tradeManager.invalid"), price: invPrice, type: "inv" }] : []),
  ].filter(l => l.price > 0)
   .sort((a, b) => direction === "long" ? b.price - a.price : a.price - b.price);

  return (
    <div className="tm-root">
      <div className="tm-layout">
        <div className="tm-inputs">
          <div className="tm-dir-row">
            <button className={`tm-dir${direction === "long"  ? " tm-dir--long"  : ""}`} onClick={() => setDirection("long")}>{t("tradeManager.long")}</button>
            <button className={`tm-dir${direction === "short" ? " tm-dir--short" : ""}`} onClick={() => setDirection("short")}>{t("tradeManager.short")}</button>
          </div>
          <div className="tm-section-label">{t("tradeManager.accountRisk")}</div>
          <div className="tm-field-grid">
            <div className="tm-field"><label>{t("tradeManager.accountSize")}</label>
              <input className="tm-input" type="number" placeholder="10000" value={accountSize} onChange={e => setAccountSize(e.target.value)} /></div>
            <div className="tm-field"><label>{t("tradeManager.riskPct")}</label>
              <input className="tm-input" type="number" placeholder="1" value={riskPct} onChange={e => setRiskPct(e.target.value)} step="0.1" /></div>
          </div>
          <div className="tm-section-label">{t("tradeManager.tradeLevels")}</div>
          <div className="tm-field-grid">
            <div className="tm-field"><label>{t("tradeManager.entryPrice")}</label>
              <input className="tm-input" type="number" placeholder={t("tradeManager.price")} value={entry} onChange={e => setEntry(e.target.value)} /></div>
            <div className="tm-field"><label>{t("tradeManager.stopLoss")}</label>
              <input className="tm-input tm-input--sl" type="number" placeholder={t("tradeManager.price")} value={stopLoss} onChange={e => setStopLoss(e.target.value)} /></div>
            <div className="tm-field tm-field--full">
              <label>{t("tradeManager.invalidationLevel")} <span className="tm-label-hint">({t("tradeManager.hardClose")})</span></label>
              <input className={`tm-input tm-input--inv${invalidBreached ? " tm-input--breached" : ""}`} type="number" placeholder={t("tradeManager.price")} value={invalidation} onChange={e => setInvalidation(e.target.value)} />
              {invalidBreached && <span className="tm-inv-warn">{t("tradeManager.invWarn")}</span>}
            </div>
          </div>
          <div className="tm-section-label">{t("tradeManager.takeProfits")}<span className={`tm-pct-total ${pctOk ? "tm-good" : "tm-warn"}`}>{totalTpPct}%</span></div>
          <div className="tm-tps">
            {tps.map((tp, i) => (
              <div className="tm-tp-row" key={i}>
                <span className="tm-tp-label">TP{i + 1}</span>
                <input className="tm-input tm-input--tp" type="number" placeholder={t("tradeManager.price")} value={tp.price}
                  onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
                <input className="tm-input tm-input--pct" type="number" placeholder="%" value={tp.pct}
                  onChange={e => setTps(p => p.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                <span className="tm-pct-unit">%</span>
                {tps.length > 1 && <button className="tm-remove-tp" onClick={() => setTps(p => p.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            {tps.length < 5 && <button className="tm-add-tp" onClick={() => setTps(p => [...p, { price: "", pct: "0" }])}>{t("tradeManager.addTP")}</button>}
          </div>
        </div>
        <div className="tm-results">
          <div className="tm-results-block">
            <div className="tm-results-title">{t("tradeManager.positionSummary")}</div>
            <div className="tm-results-grid">
              <div className="tm-res"><span>{t("tradeManager.positionSize")}</span><strong>{posSize ? `$${fmtPrice(posSize)}` : "—"}</strong></div>
              <div className="tm-res"><span>{t("tradeManager.units")}</span><strong>{units ? units.toFixed(4) : "—"}</strong></div>
              <div className="tm-res"><span>{t("tradeManager.dollarRisk")}</span><strong className="tm-danger">{dollarRisk ? `$${fmtPrice(dollarRisk)}` : "—"}</strong></div>
              <div className="tm-res"><span>{t("tradeManager.riskOnEntry")}</span><strong className="tm-danger">{riskPctVal ? `${(riskPctVal * 100).toFixed(2)}%` : "—"}</strong></div>
            </div>
          </div>
          <div className="tm-results-block">
            <div className="tm-results-title">{t("tradeManager.targetBreakdown")}</div>
            {tpMetrics.map((m, i) => m && (
              <div className="tm-tp-result" key={i}>
                <div className="tm-tp-result-top"><span>TP{i + 1} <span className="tm-tp-pct">({tps[i].pct}%)</span></span><span className={rrColor(m.rr).replace("rcp-", "tm-")}>{m.rr.toFixed(2)}R</span></div>
                <div className="tm-tp-result-bot"><span>@ ${fmtPrice(m.tpP)}</span><span className="tm-good">+${fmtPrice(m.profit)}</span></div>
              </div>
            ))}
            {tpMetrics.every(m => !m) && <p className="tm-hint">{t("tradeManager.fillHint")}</p>}
          </div>
          {ladderLevels.length >= 2 && (
            <div className="tm-results-block">
              <div className="tm-results-title">{t("tradeManager.priceLadder")}</div>
              <div className="tm-ladder">
                {ladderLevels.map((l, i) => (
                  <div key={i} className={`tm-ladder-row tm-ladder--${l.type}`}>
                    <span className="tm-ladder-lbl">{l.label}</span>
                    <div className="tm-ladder-line"><div className="tm-ladder-dot" /></div>
                    <span className="tm-ladder-price">${fmtPrice(l.price)}</span>
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

// ── Main export ───────────────────────────────────────────────────────────────
export function TradeManager({ onOpenAuth, onOpenUpgrade }: Props) {
  const standalone = onOpenAuth !== undefined;

  const [expLevel, setExpLevel] = useState<ExpLevel | null>(null);

  function selectLevel(l: ExpLevel) {
    setExpLevel(l);
  }



  if (!standalone) return <EmbeddedView />;
  if (!expLevel)   return <LevelPicker onSelect={selectLevel} />;
  if (expLevel === "beginner") return <BeginnerWizard onSwitchMode={() => selectLevel("experienced")} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />;
  return <ExperiencedView onSwitchMode={() => selectLevel("beginner")} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />;
}
