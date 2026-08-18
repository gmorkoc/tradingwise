import { StockTickerStrip } from "./StockTickerStrip";
import { StockChart } from "./StockChart";
import { FinanceNewsGrid } from "./FinanceNewsGrid";
import { StockMovers } from "./StockMovers";
import "../styles/StocksHome.css";

interface Props {
  theme: "dark" | "light";
}

// Composes the Stocks tab's Yahoo-Finance-style homepage: ticker strip on
// top, then chart + news on the left and movers in the right sidebar. Each
// section fetches and loads independently — a slow/missing TwelveData key
// shouldn't block the news grid, and vice versa.
export function StocksHome({ theme }: Props) {
  return (
    <div className="sh-wrap">
      <StockTickerStrip />
      <div className="sh-grid">
        <div className="sh-main">
          <StockChart theme={theme} />
          <FinanceNewsGrid />
        </div>
        <div className="sh-sidebar">
          <StockMovers />
        </div>
      </div>
    </div>
  );
}
