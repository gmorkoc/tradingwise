import { BottomSheet } from "./BottomSheet";
import "../styles/CoinUnavailableSheet.css";

// Bottom sheet on phones, centered modal on desktop (desktopModal).
// Shown when someone taps a coin anywhere in the app (Markets, movers,
// search, notifications…) that the chart doesn't have data for yet —
// instead of opening an empty chart.
interface Props {
  symbol: string | null;
  onClose: () => void;
  /** Opens the coin picker so they can pick one that's available. */
  onBrowse: () => void;
}

export function CoinUnavailableSheet({ symbol, onClose, onBrowse }: Props) {
  return (
    <BottomSheet open={!!symbol} onClose={onClose} title={<>Coming soon</>} className="cu-sheet" ariaLabel="Coin not available yet" desktopModal>
      <div className="cu-body">
        <div className="cu-badge">
          <img
            src={`https://assets.coincap.io/assets/icons/${(symbol ?? "").toLowerCase()}@2x.png`}
            alt=""
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <span>{symbol?.slice(0, 1)}</span>
        </div>
        <h3 className="cu-title">{symbol} charts aren't available yet</h3>
        <p className="cu-text">
          We don't have live chart data for {symbol} yet. We're adding new coins all the time —
          it's on our list, so check back soon.
        </p>
        <div className="cu-actions">
          <button type="button" className="cu-btn cu-btn--primary" onClick={() => { onClose(); onBrowse(); }}>
            Browse available coins
          </button>
          <button type="button" className="cu-btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </BottomSheet>
  );
}
