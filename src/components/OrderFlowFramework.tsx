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
  { id: "planner", labelKey: "orderFlowFramework.tabPlanner", d: ["M12 22V12", "m17 7-5-5-5 5", "M4 7h16", "M4 12h5", "M4 17h3"] },
  { id: "manager", labelKey: "orderFlowFramework.tabManager", d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5", "M8 12h.01", "M12 9h.01"] },
  { id: "profile", labelKey: "orderFlowFramework.tabProfile", d: ["M3 3v18h18", "M8 17V9", "M12 17V5", "M16 17v-4"] },
];

interface Props { coin: string; }

export function OrderFlowFramework({ coin }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("flow");

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

      <div className="off-body">
        {tab === "flow"    && <OrderFlowTape   coin={coin} />}
        {tab === "planner" && <ExecutionPlanner />}
        {tab === "manager" && <TradeManager />}
        {tab === "profile" && <VolumeProfile coin={coin} />}
      </div>
    </div>
  );
}
