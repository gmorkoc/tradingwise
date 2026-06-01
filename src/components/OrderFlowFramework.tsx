import { useState } from "react";
import { OrderFlowTape }   from "./OrderFlowTape";
import { ExecutionPlanner } from "./ExecutionPlanner";
import { TradeManager }    from "./TradeManager";
import { VolumeProfile }   from "./VolumeProfile";
import "../styles/OrderFlowFramework.css";

type Tab = "flow" | "planner" | "manager" | "profile";

const TABS: { id: Tab; label: string; d: string[] }[] = [
  {
    id: "flow", label: "Live Flow",
    d: ["M2 12h4l3-9 4 18 3-9h6"],
  },
  {
    id: "planner", label: "Execution Planner",
    d: ["M12 22V12", "m17 7-5-5-5 5", "M4 7h16", "M4 12h5", "M4 17h3"],
  },
  {
    id: "manager", label: "Trade Manager",
    d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5", "M8 12h.01", "M12 9h.01"],
  },
  {
    id: "profile", label: "Volume Profile",
    d: ["M3 3v18h18", "M8 17V9", "M12 17V5", "M16 17v-4"],
  },
];

interface Props { coin: string; }

export function OrderFlowFramework({ coin }: Props) {
  const [tab, setTab] = useState<Tab>("flow");

  return (
    <div className="off-root">
      <div className="off-header">
        <div className="off-header-top">
          <div>
            <h1 className="off-title">Order Flow <span className="off-title-amp">&amp;</span> Institutional Framework</h1>
            <p className="off-subtitle">Institutional-grade execution tools for entries, management, and exits</p>
          </div>
          <span className="off-coin-badge">{coin}/USDT</span>
        </div>
        <div className="off-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`off-tab${tab === t.id ? " off-tab--active" : ""}`} onClick={() => setTab(t.id)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {t.d.map((p, i) => <path key={i} d={p} />)}
              </svg>
              {t.label}
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
