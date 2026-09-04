import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { COINS, CoinSymbol, coinglass } from "../services/coinglass";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../services/supabase";
import {
  StrategyAlert, StrategyCondition, StrategyFire, IndicatorId, ConditionType, Timeframe, ComparisonTarget,
  TEMPLATES, StrategyTemplate, INDICATOR_LABELS,
  fetchMyStrategies, createStrategy, setStrategyEnabled, deleteStrategy, duplicateStrategy, fetchRecentFires,
  evaluateStrategyPreview,
} from "../services/strategyAlerts";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import "../styles/StrategyAlerts.css";

type Tab = "templates" | "builder" | "mystrategies";

const INDICATORS: IndicatorId[] = ["price", "ema", "rsi", "macd", "macdHist", "bb", "atr", "tema", "volRatio"];
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w"];
const PERIOD_INDICATORS = new Set<IndicatorId>(["ema", "rsi", "atr", "tema", "volRatio"]);
const DEFAULT_PERIOD: Partial<Record<IndicatorId, number>> = { ema: 20, rsi: 14, atr: 14, tema: 14, volRatio: 20 };

let condIdSeq = 0;
const newConditionId = () => `c${Date.now()}-${condIdSeq++}`;

function defaultCondition(): StrategyCondition {
  return {
    id: newConditionId(), indicator: "rsi", params: { period: 14 }, timeframe: "1h",
    type: "threshold", operator: "<", target: { kind: "value", value: 30 },
  };
}

function targetKindValue(target: ComparisonTarget): string {
  if (target.kind === "value") return "value";
  if (target.kind === "price") return "price";
  return target.indicator;
}

function conditionLabel(c: StrategyCondition): string {
  return `${INDICATOR_LABELS[c.indicator]}${c.params?.period ? `(${c.params.period})` : ""}`;
}

export function StrategyAlerts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("templates");

  // ── Builder state ──────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [logic, setLogic] = useState<"AND" | "OR">("AND");
  const [conditions, setConditions] = useState<StrategyCondition[]>([defaultCondition()]);
  const [coins, setCoins] = useState<string[]>(["BTC"]);
  const [cooldown, setCooldown] = useState(60);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [coinPickerOpen, setCoinPickerOpen] = useState(false);
  const [webPushSubscribed, setWebPushSubscribed] = useState(false);
  const [webPushLoading, setWebPushLoading] = useState(false);
  const [webPushError, setWebPushError] = useState<string | null>(null);

  useEffect(() => {
    if (isWebPushAvailable()) isWebPushSubscribed().then(setWebPushSubscribed);
  }, []);

  async function handleEnableWebPush() {
    if (!user) return;
    setWebPushLoading(true);
    setWebPushError(null);
    const result = await subscribeWebPush(user.id);
    setWebPushSubscribed(result.ok);
    if (!result.ok) setWebPushError(result.error ?? "Couldn't enable browser notifications");
    setWebPushLoading(false);
  }

  // ── My Strategies state ───────────────────────────────────────────────
  const [strategies, setStrategies] = useState<StrategyAlert[]>([]);
  const [fires, setFires] = useState<StrategyFire[]>([]);
  const [loadingMy, setLoadingMy] = useState(false);

  const loadMyStrategies = useCallback(async () => {
    if (!user) return;
    setLoadingMy(true);
    try {
      const [s, f] = await Promise.all([fetchMyStrategies(), fetchRecentFires()]);
      setStrategies(s);
      setFires(f);
    } finally {
      setLoadingMy(false);
    }
  }, [user]);

  useEffect(() => {
    if (tab === "mystrategies") loadMyStrategies();
  }, [tab, loadMyStrategies]);

  // Tapping a "strategy fired" push notification routes here (App.tsx
  // handles the section switch) — jump straight to the fired list.
  useEffect(() => {
    const onOpenStrategyAlert = () => setTab("mystrategies");
    window.addEventListener("open-strategy-alert", onOpenStrategyAlert);
    return () => window.removeEventListener("open-strategy-alert", onOpenStrategyAlert);
  }, []);

  // Live "would this have fired recently" — real WebSocket delivery for
  // deployed strategies happens via strategy_fires below; this is just a
  // one-shot query per keystroke for the currently-open coin.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("strategy_fires_live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "strategy_fires", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as { id: number; strategy_id: string; coin: string; timeframe: string; summary: string; fired_at: string };
          setFires((prev) => [
            { id: row.id, strategyId: row.strategy_id, coin: row.coin, timeframe: row.timeframe, summary: row.summary, firedAt: row.fired_at },
            ...prev,
          ].slice(0, 20));
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    if (conditions.length === 0 || coins.length === 0) { setPreviewCount(null); return; }
    setPreviewLoading(true);
    const coin = coins[0];
    const timeframe = conditions[0].timeframe;
    coinglass.getCandles(coin as CoinSymbol, timeframe, 300)
      .then((candles) => { if (!cancelled) setPreviewCount(evaluateStrategyPreview(logic, conditions, candles)); })
      .catch(() => { if (!cancelled) setPreviewCount(null); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [conditions, logic, coins]);

  function useTemplate(tpl: StrategyTemplate) {
    setName(tpl.name);
    setLogic(tpl.logic);
    setConditions(tpl.conditions.map((c) => ({ ...c, id: newConditionId() })));
    setCoins(tpl.defaultCoins);
    setCooldown(tpl.defaultCooldownMinutes);
    setTemplateId(tpl.id);
    setDeployError(null);
    setTab("builder");
  }

  function startFromScratch() {
    setName("");
    setLogic("AND");
    setConditions([defaultCondition()]);
    setCoins(["BTC"]);
    setCooldown(60);
    setTemplateId(null);
    setDeployError(null);
    setTab("builder");
  }

  function addCondition() { setConditions((prev) => [...prev, defaultCondition()]); }
  function removeCondition(id: string) { setConditions((prev) => prev.filter((c) => c.id !== id)); }
  function updateCondition(id: string, patch: Partial<StrategyCondition>) {
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function toggleCoin(sym: string) {
    setCoins((prev) => (prev.includes(sym) ? prev.filter((c) => c !== sym) : [...prev, sym]));
  }

  function handleIndicatorChange(cond: StrategyCondition, indicator: IndicatorId) {
    const params = PERIOD_INDICATORS.has(indicator) ? { period: DEFAULT_PERIOD[indicator] ?? 14 } : undefined;
    updateCondition(cond.id, { indicator, params });
  }

  function handleTargetKindChange(cond: StrategyCondition, kind: string) {
    if (kind === "value") return updateCondition(cond.id, { target: { kind: "value", value: 0 } });
    if (kind === "price") return updateCondition(cond.id, { target: { kind: "price" } });
    const indicator = kind as IndicatorId;
    const params = PERIOD_INDICATORS.has(indicator) ? { period: DEFAULT_PERIOD[indicator] ?? 14 } : undefined;
    updateCondition(cond.id, { target: { kind: "indicator", indicator, params } });
  }

  async function handleDeploy() {
    if (!user || !name.trim() || conditions.length === 0 || coins.length === 0) return;
    setDeploying(true);
    setDeployError(null);
    try {
      await createStrategy({ userId: user.id, name: name.trim(), templateId, logic, conditions, coins, cooldownMinutes: cooldown });
      setTab("mystrategies");
      loadMyStrategies();
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : "Failed to deploy strategy");
    } finally {
      setDeploying(false);
    }
  }

  async function handleToggleEnabled(s: StrategyAlert) {
    setStrategies((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    try { await setStrategyEnabled(s.id, !s.enabled); } catch { loadMyStrategies(); }
  }
  async function handleDelete(s: StrategyAlert) {
    setStrategies((prev) => prev.filter((x) => x.id !== s.id));
    try { await deleteStrategy(s.id); } catch { loadMyStrategies(); }
  }
  async function handleDuplicate(s: StrategyAlert) {
    await duplicateStrategy(s);
    loadMyStrategies();
  }

  const deployDisabled = !name.trim() || conditions.length === 0 || coins.length === 0 || deploying;

  return (
    <div className="sa-root">
      <div className="sa-tabs">
        <button className={`sa-tab${tab === "templates" ? " is-active" : ""}`} onClick={() => setTab("templates")}>
          ★ {t("strategyAlerts.tabs.templates", "Templates")} <span className="n">{TEMPLATES.length}</span>
        </button>
        <button className={`sa-tab${tab === "builder" ? " is-active" : ""}`} onClick={() => setTab("builder")}>
          ⚙ {t("strategyAlerts.tabs.builder", "Builder")}
        </button>
        <button className={`sa-tab${tab === "mystrategies" ? " is-active" : ""}`} onClick={() => setTab("mystrategies")}>
          ◧ {t("strategyAlerts.tabs.mystrategies", "My Strategies")} <span className="n">{strategies.length}</span>
        </button>
      </div>

      <div className="sa-body">
        {tab === "templates" && (
          <div className="tpl-grid">
            {TEMPLATES.map((tpl) => (
              <div className="tpl-card" key={tpl.id}>
                <div className="tpl-card-top">
                  <div className="tpl-glyph" style={{ color: tpl.color, background: `${tpl.color}20`, borderColor: `${tpl.color}4d` }}>{tpl.glyph}</div>
                  <div className="tpl-name">{tpl.name}</div>
                </div>
                <div className="tpl-desc">{tpl.desc}</div>
                <div className="tpl-cond-preview">{tpl.previewText}</div>
                <button className="tpl-use-btn" onClick={() => useTemplate(tpl)}>
                  {t("strategyAlerts.useTemplate", "Use Template")} →
                </button>
              </div>
            ))}
            <div className="tpl-card tpl-card--blank" onClick={startFromScratch}>
              <div className="tpl-blank-icon">+</div>
              <div className="tpl-name">{t("strategyAlerts.startFromScratch", "Start from scratch")}</div>
              <div className="tpl-desc">{t("strategyAlerts.startFromScratchDesc", "Build a custom condition set from any indicator.")}</div>
            </div>
          </div>
        )}

        {tab === "builder" && (
          <div className="bld-grid">
            <div>
              <div className="bld-field-label">{t("strategyAlerts.name", "Strategy Name")}</div>
              <input
                className="bld-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("strategyAlerts.namePlaceholder", "e.g. RSI Reversal + Volume Confirm")}
              />

              <div className="bld-field-label">{t("strategyAlerts.watching", "Watching")}</div>
              <div className="bld-coins">
                {coins.map((sym) => (
                  <span className="coin-chip" key={sym}>
                    {sym}
                    <button className="coin-chip-x" onClick={() => toggleCoin(sym)}>✕</button>
                  </span>
                ))}
                <span className="coin-chip add" onClick={() => setCoinPickerOpen((o) => !o)}>+ {t("strategyAlerts.addCoin", "Add coin")}</span>
                {coinPickerOpen && (
                  <div className="coin-picker">
                    {COINS.map((c) => (
                      <button
                        key={c.symbol}
                        className={`coin-picker-item${coins.includes(c.symbol) ? " is-selected" : ""}`}
                        onClick={() => toggleCoin(c.symbol)}
                      >
                        {c.symbol} <span className="coin-picker-name">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="logic-row">
                <div className="logic-toggle">
                  <button className={`logic-btn${logic === "AND" ? " is-active" : ""}`} onClick={() => setLogic("AND")}>AND</button>
                  <button className={`logic-btn${logic === "OR" ? " is-active" : ""}`} onClick={() => setLogic("OR")}>OR</button>
                </div>
                <span className="logic-hint">
                  {logic === "AND"
                    ? t("strategyAlerts.andHint", "all conditions must be true")
                    : t("strategyAlerts.orHint", "any condition can be true")}
                </span>
              </div>

              <div className="cond-thead">
                <span className="cond-tcell lbl">{t("strategyAlerts.col.indicator", "Indicator")}</span>
                <span className="cond-tcell lbl">{t("strategyAlerts.col.type", "Type")}</span>
                <span className="cond-tcell lbl">{t("strategyAlerts.col.timeframe", "Timeframe")}</span>
                <span className="cond-tcell lbl">{t("strategyAlerts.col.comparison", "Comparison")}</span>
                <span></span>
              </div>
              <div className="cond-table">
                {conditions.map((cond) => (
                  <div className="cond-trow" key={cond.id}>
                    <div className="cond-tcell-group">
                      <select className="cond-select" value={cond.indicator} onChange={(e) => handleIndicatorChange(cond, e.target.value as IndicatorId)}>
                        {INDICATORS.map((id) => <option key={id} value={id}>{INDICATOR_LABELS[id]}</option>)}
                      </select>
                      {cond.params?.period !== undefined && (
                        <input
                          type="number" className="cond-period-input" value={cond.params.period}
                          onChange={(e) => updateCondition(cond.id, { params: { period: Number(e.target.value) || 1 } })}
                        />
                      )}
                    </div>

                    <select
                      className="cond-select"
                      value={cond.type}
                      onChange={(e) => updateCondition(cond.id, { type: e.target.value as ConditionType })}
                    >
                      <option value="threshold">{t("strategyAlerts.type.threshold", "Threshold")}</option>
                      <option value="crossover">{t("strategyAlerts.type.crossover", "Crossover")}</option>
                    </select>

                    <select className="cond-select" value={cond.timeframe} onChange={(e) => updateCondition(cond.id, { timeframe: e.target.value as Timeframe })}>
                      {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                    </select>

                    <div className="cond-tcell-group cond-comparison">
                      {cond.type === "threshold" ? (
                        <select className="cond-select cond-select--sm" value={cond.operator} onChange={(e) => updateCondition(cond.id, { operator: e.target.value as StrategyCondition["operator"] })}>
                          <option value=">">&gt;</option>
                          <option value="<">&lt;</option>
                          <option value=">=">&gt;=</option>
                          <option value="<=">&lt;=</option>
                        </select>
                      ) : (
                        <select className="cond-select cond-select--sm" value={cond.direction ?? "either"} onChange={(e) => updateCondition(cond.id, { direction: e.target.value === "either" ? undefined : (e.target.value as "above" | "below") })}>
                          <option value="either">↕</option>
                          <option value="above">↗ {t("strategyAlerts.above", "above")}</option>
                          <option value="below">↘ {t("strategyAlerts.below", "below")}</option>
                        </select>
                      )}
                      <select className="cond-select cond-select--sm" value={targetKindValue(cond.target)} onChange={(e) => handleTargetKindChange(cond, e.target.value)}>
                        <option value="value">{t("strategyAlerts.fixedValue", "Fixed Value")}</option>
                        <option value="price">Price</option>
                        {INDICATORS.map((id) => <option key={id} value={id}>{INDICATOR_LABELS[id]}</option>)}
                      </select>
                      {cond.target.kind === "value" && (
                        <input
                          type="number" className="cond-value-input" value={cond.target.value}
                          onChange={(e) => updateCondition(cond.id, { target: { kind: "value", value: Number(e.target.value) || 0 } })}
                        />
                      )}
                    </div>

                    <button className="cond-remove" onClick={() => removeCondition(cond.id)} disabled={conditions.length === 1}>✕</button>
                  </div>
                ))}
              </div>
              <button className="add-cond-btn" onClick={addCondition}>+ {t("strategyAlerts.addCondition", "Add condition")}</button>
            </div>

            <div className="bld-side">
              <div className="side-card">
                <div className="side-card-title">{t("strategyAlerts.livePreview", "Live Preview")}</div>
                {previewLoading ? (
                  <div className="preview-hit preview-hit--loading">{t("strategyAlerts.checking", "Checking…")}</div>
                ) : previewCount === null ? (
                  <div className="preview-hit preview-hit--muted">{t("strategyAlerts.noData", "Not enough data yet")}</div>
                ) : (
                  <div className="preview-hit">
                    ✓ {t("strategyAlerts.wouldHaveFired", "Would have fired {{count}}× recently", { count: previewCount })}
                  </div>
                )}
                <div className="cooldown-row">
                  <label>{t("strategyAlerts.cooldown", "Cooldown")}</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="number" className="cooldown-input" value={cooldown} onChange={(e) => setCooldown(Math.max(1, Number(e.target.value) || 1))} />
                    <span className="cooldown-unit">min</span>
                  </div>
                </div>
                <div className="channel-line">
                  {t("strategyAlerts.deliversVia", "Delivers via")} <b>Push + In-App</b>
                </div>
                {isWebPushAvailable() && (
                  webPushSubscribed ? (
                    <div className="webpush-status">✓ {t("strategyAlerts.webPushOn", "Browser notifications on")}</div>
                  ) : (
                    <button className="webpush-enable-btn" onClick={handleEnableWebPush} disabled={webPushLoading}>
                      🔔 {webPushLoading ? t("strategyAlerts.enabling", "Enabling…") : t("strategyAlerts.enableWebPush", "Enable browser notifications")}
                    </button>
                  )
                )}
                {webPushError && <div className="deploy-error">{webPushError}</div>}
                {deployError && <div className="deploy-error">{deployError}</div>}
                <button className="deploy-btn" onClick={handleDeploy} disabled={deployDisabled}>
                  {deploying ? t("strategyAlerts.deploying", "Deploying…") : t("strategyAlerts.deploy", "Deploy Strategy")}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "mystrategies" && (
          <div>
            {loadingMy ? (
              <div className="sa-loading">{t("strategyAlerts.loading", "Loading…")}</div>
            ) : strategies.length === 0 ? (
              <div className="sa-empty">
                {t("strategyAlerts.emptyStrategies", "No strategies deployed yet.")}{" "}
                <button className="sa-empty-link" onClick={() => setTab("templates")}>{t("strategyAlerts.browseTemplates", "Browse templates")}</button>
              </div>
            ) : (
              <div className="my-list">
                {strategies.map((s) => (
                  <div className="my-row" key={s.id}>
                    <span className={`my-status-dot${s.enabled ? "" : " is-off"}`} />
                    <div className="my-main">
                      <div className="my-name">{s.name}</div>
                      <div className="my-meta">
                        {s.coins.join(", ")} · {s.conditions.map(conditionLabel).join(` ${s.logic} `)}
                        {!s.enabled && ` · ${t("strategyAlerts.disabled", "disabled")}`}
                      </div>
                    </div>
                    <div className="my-actions">
                      <button className="my-icon-btn" title={t("strategyAlerts.duplicate", "Duplicate")} onClick={() => handleDuplicate(s)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                      <button className="my-icon-btn" title={t("strategyAlerts.delete", "Delete")} onClick={() => handleDelete(s)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                      </button>
                      <span className={`my-toggle-track${s.enabled ? "" : " is-off"}`} onClick={() => handleToggleEnabled(s)} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="fires-head">
              <span className="live-dot" />
              <span className="fires-title">{t("strategyAlerts.recentFires", "Recent Fires")} — {t("strategyAlerts.live", "live")}</span>
            </div>
            {fires.length === 0 ? (
              <div className="sa-empty sa-empty--sm">{t("strategyAlerts.noFires", "Nothing has fired yet.")}</div>
            ) : (
              <div className="fire-list">
                {fires.map((f) => (
                  <div className="fire-row" key={f.id}>
                    <span className="fire-coin-dot">{f.coin[0]}</span>
                    <span className="fire-summary">{f.summary} — {f.coin}</span>
                    <span className="fire-time">{new Date(f.firedAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
