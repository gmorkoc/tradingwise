import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LeveragePanel } from "./LeveragePanel";
import { ZoneResult } from "./PriceChart.types";
import "../styles/LeveragePanel.css";

interface LeveragePopupProps {
  isOpen: boolean;
  onClose: () => void;
  zone: ZoneResult | null;
  currentPrice: number;
  coin: string;
}

export const LeveragePopup: React.FC<LeveragePopupProps> = ({
  isOpen, onClose, zone, currentPrice, coin,
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="lev-popup-overlay" onClick={onClose}>
      <div className="lev-popup-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lev-popup-header">
          <span className="lev-popup-title">{t("leverage.title")}</span>
          <button className="lev-popup-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <LeveragePanel currentPrice={currentPrice} zone={zone} coin={coin} hideHeader />
      </div>
    </div>
  );
};
