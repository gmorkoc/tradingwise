import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BTCData } from "../services/coinglass";
import "../styles/AlertsBuilder.css";

/* ── Types ──────────────────────────────────────────────────────────────── */
type MetricKey = keyof Pick<BTCData,
  "price" | "rsi" | "fundingRate" | "longShortRatio" | "openInterest" | "macd" |
  "liquidationAbove" | "liquidationBelow"
>;
type Operator = ">" | "<" | ">=" | "<=";

interface Condition {
  id: string;
  metric: MetricKey;
  operator: Operator;
  value: number;
}

interface AlertGroup {
  id: string;
  name: string;
  logic: "AND" | "OR";
  conditions: Condition[];
  enabled: boolean;
}

/* ── Config ─────────────────────────────────────────────────────────────── */
const METRICS: { key: MetricKey; tKey: string; defaultVal: number; step: number }[] = [
  { key: "price",            tKey: "alerts.metrics.price",            defaultVal: 90000, step: 100   },
  { key: "rsi",              tKey: "alerts.metrics.rsi",              defaultVal: 30,    step: 1     },
  { key: "fundingRate",      tKey: "alerts.metrics.fundingRate",      defaultVal: 0,     step: 0.001 },
  { key: "longShortRatio",   tKey: "alerts.metrics.longShortRatio",   defaultVal: 1.0,   step: 0.01  },
  { key: "openInterest",     tKey: "alerts.metrics.openInterest",     defaultVal: 1e9,   step: 1e7   },
  { key: "macd",             tKey: "alerts.metrics.macd",             defaultVal: 0,     step: 0.01  },
  { key: "liquidationAbove", tKey: "alerts.metrics.liquidationAbove", defaultVal: 95000, step: 100   },
  { key: "liquidationBelow", tKey: "alerts.metrics.liquidationBelow", defaultVal: 85000, step: 100   },
];

const OPERATORS: Operator[] = [">", "<", ">=", "<="];

const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_GROUP: AlertGroup = {
  id: "default",
  name: "New Alert",
  logic: "AND",
  conditions: [{ id: "default-cond", metric: "rsi", operator: "<", value: 30 }],
  enabled: true,
};

function loadGroups(): AlertGroup[] {
  try {
    const saved = JSON.parse(localStorage.getItem("alertGroups_v1") ?? "[]") as AlertGroup[];
    return saved.length > 0 ? saved : [DEFAULT_GROUP];
  }
  catch { return [DEFAULT_GROUP]; }
}

function evaluate(group: AlertGroup, data: Partial<BTCData>): boolean {
  if (!group.enabled || group.conditions.length === 0) return false;
  const results = group.conditions.map(c => {
    const actual = (data as Record<string, number>)[c.metric] ?? 0;
    if (c.operator === ">")  return actual > c.value;
    if (c.operator === "<")  return actual < c.value;
    if (c.operator === ">=") return actual >= c.value;
    if (c.operator === "<=") return actual <= c.value;
    return false;
  });
  return group.logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function metricTKey(key: MetricKey): string {
  return METRICS.find(m => m.key === key)?.tKey ?? key;
}

/* ── Component ──────────────────────────────────────────────────────────── */
interface Props { btcData: Partial<BTCData> | null }

export function AlertsBuilder({ btcData }: Props) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<AlertGroup[]>(loadGroups);
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const initial = loadGroups();
    return new Set(initial.map(g => g.id));
  });
  const [triggeredIds, setTriggeredIds] = useState<Set<string>>(new Set());
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const lastFiredRef = useRef<Record<string, number>>({});

  /* Persist */
  useEffect(() => {
    localStorage.setItem("alertGroups_v1", JSON.stringify(groups));
  }, [groups]);

  /* Evaluate on every data tick */
  useEffect(() => {
    if (!btcData) return;
    const fired = new Set<string>();
    groups.forEach(g => {
      if (evaluate(g, btcData)) {
        fired.add(g.id);
        const now = Date.now();
        const last = lastFiredRef.current[g.id] ?? 0;
        if (now - last > 5 * 60 * 1000) {
          lastFiredRef.current[g.id] = now;
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const body = g.conditions
              .map(c => `${t(metricTKey(c.metric))} ${c.operator} ${c.value}`)
              .join(g.logic === "AND" ? ` ${t("alerts.logic.and")} ` : ` ${t("alerts.logic.or")} `);
            new Notification(`coinhintz Alert: ${g.name}`, { body });
          }
        }
      }
    });
    setTriggeredIds(fired);
  }, [btcData, groups]);

  /* Actions */
  const addGroup = () => {
    const id = uid();
    const g: AlertGroup = {
      id, name: t("alerts.defaultName"), logic: "AND",
      conditions: [{ id: uid(), metric: "rsi", operator: "<", value: 30 }],
      enabled: true,
    };
    setGroups(prev => [g, ...prev]);
    setOpenIds(prev => new Set([...prev, id]));
  };

  const deleteGroup = (id: string) => setGroups(prev => prev.filter(g => g.id !== id));

  const toggleOpen = (id: string) =>
    setOpenIds(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const updateGroup = (id: string, patch: Partial<AlertGroup>) =>
    setGroups(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g));

  const addCondition = (groupId: string) =>
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, conditions: [...g.conditions, { id: uid(), metric: "price", operator: ">", value: 100000 }] }
        : g
    ));

  const updateCondition = (groupId: string, condId: string, patch: Partial<Condition>) =>
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, conditions: g.conditions.map(c => c.id === condId ? { ...c, ...patch } : c) }
        : g
    ));

  const removeCondition = (groupId: string, condId: string) =>
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, conditions: g.conditions.filter(c => c.id !== condId) }
        : g
    ));

  const requestNotif = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
  };

  return (
    <div className="alerts-card">
      <div className="alerts-header">
        <h3 className="alerts-title">{t("alerts.title")}</h3>
        <div className="alerts-header-right">
          {notifPerm !== "granted" && (
            <button className="alerts-notify-btn" onClick={requestNotif}>
              {t("alerts.enableNotifications")}
            </button>
          )}
          {notifPerm === "granted" && (
            <span className="alerts-notify-btn alerts-notify-btn--granted">{t("alerts.notificationsOn")}</span>
          )}
          <button className="alerts-add-btn" onClick={addGroup}>{t("alerts.newAlert")}</button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="alerts-empty">
          <div className="alerts-empty-icon">{t("alerts.empty.icon")}</div>
          <div className="alerts-empty-text">{t("alerts.empty.text")}</div>
          <div className="alerts-empty-hint">{t("alerts.empty.hint")}</div>
        </div>
      ) : (
        <div className="alerts-list">
          {groups.map(group => {
            const isOpen = openIds.has(group.id);
            const isTriggered = triggeredIds.has(group.id);
            return (
              <div key={group.id}
                className={`alert-group${isTriggered ? " alert-group--triggered" : ""}`}>

                {/* Header */}
                <div className="alert-group-header" onClick={() => toggleOpen(group.id)}>
                  <input
                    className="alert-group-name-input"
                    value={group.name}
                    onChange={e => updateGroup(group.id, { name: e.target.value })}
                    onClick={e => e.stopPropagation()}
                    placeholder="Alert name…"
                  />

                  <span
                    className={`alert-logic-badge alert-logic-badge--${group.logic.toLowerCase()}`}
                    onClick={e => {
                      e.stopPropagation();
                      updateGroup(group.id, { logic: group.logic === "AND" ? "OR" : "AND" });
                    }}
                    title="Click to toggle AND / OR"
                  >
                    {group.logic}
                  </span>

                  {isTriggered && <span className="alert-triggered-badge">TRIGGERED</span>}

                  <label className="alert-group-toggle" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={group.enabled}
                      onChange={e => updateGroup(group.id, { enabled: e.target.checked })} />
                    <span className="alert-toggle-track" />
                  </label>

                  <button className="alert-delete-btn"
                    onClick={e => { e.stopPropagation(); deleteGroup(group.id); }}
                    title="Delete alert">✕</button>

                  <span className={`alert-group-chevron${isOpen ? " alert-group-chevron--open" : ""}`}>▼</span>
                </div>

                {/* Expandable body */}
                {isOpen && (
                  <div className="alert-group-body">
                    {group.conditions.map((cond, idx) => (
                      <div key={cond.id} className="alert-condition">
                        {idx > 0 && (
                          <span style={{ fontSize: "0.7rem", fontWeight: 700,
                            color: group.logic === "AND" ? "#38bdf8" : "#a78bfa",
                            flexShrink: 0, minWidth: 24, textAlign: "center" }}>
                            {group.logic}
                          </span>
                        )}
                        {idx === 0 && <span style={{ minWidth: 24, flexShrink: 0 }} />}

                        <select className="alert-select alert-select--metric" value={cond.metric}
                          onChange={e => updateCondition(group.id, cond.id, { metric: e.target.value as MetricKey })}>
                          {METRICS.map(m => <option key={m.key} value={m.key}>{t(m.tKey)}</option>)}
                        </select>

                        <select className="alert-select alert-select--op" value={cond.operator}
                          onChange={e => updateCondition(group.id, cond.id, { operator: e.target.value as Operator })}>
                          {OPERATORS.map(op => <option key={op} value={op}>{op}</option>)}
                        </select>

                        <input className="alert-value-input" type="number"
                          value={cond.value}
                          step={METRICS.find(m => m.key === cond.metric)?.step ?? 1}
                          onChange={e => updateCondition(group.id, cond.id, { value: parseFloat(e.target.value) || 0 })} />

                        <button className="alert-remove-btn"
                          onClick={() => removeCondition(group.id, cond.id)}
                          title="Remove condition">✕</button>
                      </div>
                    ))}

                    <button className="alert-add-condition-btn"
                      onClick={() => addCondition(group.id)}>
                      + Add Condition
                    </button>

                    {btcData && (
                      <div className="alert-live-hint">
                        Live: Price ${btcData.price?.toLocaleString()} · RSI {btcData.rsi?.toFixed(1)} ·
                        Funding {((btcData.fundingRate ?? 0) * 100).toFixed(4)}% ·
                        L/S {btcData.longShortRatio?.toFixed(2)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
