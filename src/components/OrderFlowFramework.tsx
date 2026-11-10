import { useState } from "react";
import { useTranslation } from "react-i18next";
import { OrderFlowTape }   from "./OrderFlowTape";
import { ExecutionPlanner } from "./ExecutionPlanner";
import { TradeManager }    from "./TradeManager";
import { VolumeProfile }   from "./VolumeProfile";
import "../styles/OrderFlowFramework.css";

type Tab = "flow" | "planner" | "manager" | "profile";

const TAB_IDS: { id: Tab; labelKey: string; d: string[] }[] = [
  { id: "flow",    labelKey: "orderFlowFramework.tabFlow",    d: ["M2 12h4l3-9 4 18 3-9h6"] },
  { id: "profile", labelKey: "orderFlowFramework.tabProfile", d: ["M3 3v18h18", "M8 17V9", "M12 17V5", "M16 17v-4"] },
  { id: "planner", labelKey: "orderFlowFramework.tabPlanner", d: ["M12 22V12", "m17 7-5-5-5 5", "M4 7h16", "M4 12h5", "M4 17h3"] },
  { id: "manager", labelKey: "orderFlowFramework.tabManager", d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5", "M8 12h.01", "M12 9h.01"] },
];

// Plain-language explainer for each tab: what it shows, how it works, how
// traders use it. Shown under the tab bar behind a "What is this?" toggle.
// Text lives in src/locales/extra/<lang>/orderFlowGuide.json; resolved via t().
const TAB_INFO: Record<Tab, { what: string; how: string; use: string }> = {
  flow:    { what: "orderFlowGuide.flow.what",    how: "orderFlowGuide.flow.how",    use: "orderFlowGuide.flow.use" },
  profile: { what: "orderFlowGuide.profile.what", how: "orderFlowGuide.profile.how", use: "orderFlowGuide.profile.use" },
  planner: { what: "orderFlowGuide.planner.what", how: "orderFlowGuide.planner.how", use: "orderFlowGuide.planner.use" },
  manager: { what: "orderFlowGuide.manager.what", how: "orderFlowGuide.manager.how", use: "orderFlowGuide.manager.use" },
};

interface Props { coin: string; onOpenAuth?: (view?: "login" | "signup") => void; }

export function OrderFlowFramework({ coin, onOpenAuth }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("flow");
  const info = TAB_INFO[tab];
  const tabName = t(TAB_IDS.find(d => d.id === tab)!.labelKey);

  return (
    <div className="off-root">
      <div className="off-header">
        <div className="off-header-top">
          <div>
            <h1 className="off-title">{t("orderFlowFramework.title")}</h1>
            <p className="off-subtitle">{t("orderFlowFramework.subtitle")}</p>
          </div>
          <span className="off-coin-badge">{coin}/USDT</span>
        </div>
        <div className="off-tabs">
          {TAB_IDS.map(tabDef => (
            <button key={tabDef.id} className={`off-tab${tab === tabDef.id ? " off-tab--active" : ""}`} onClick={() => setTab(tabDef.id)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {tabDef.d.map((p, i) => <path key={i} d={p} />)}
              </svg>
              {t(tabDef.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* What this tab is, how it works and how to read it — always shown. */}
      <div className="off-info">
        <dl className="off-guide" aria-label={t("orderFlowGuide.guideAria", { tab: tabName })}>
          <div className="off-guide-row"><dt>{t("orderFlowGuide.rowWhat")}</dt><dd>{t(info.what)}</dd></div>
          <div className="off-guide-row"><dt>{t("orderFlowGuide.rowHow")}</dt><dd>{t(info.how)}</dd></div>
          <div className="off-guide-row"><dt>{t("orderFlowGuide.rowUse")}</dt><dd>{t(info.use)}</dd></div>
        </dl>
      </div>

      <div className="off-body">
        {tab === "flow"    && <OrderFlowTape   coin={coin} onOpenAuth={onOpenAuth} />}
        {tab === "planner" && <ExecutionPlanner />}
        {tab === "manager" && <TradeManager />}
        {tab === "profile" && <VolumeProfile coin={coin} />}
      </div>
    </div>
  );
}
