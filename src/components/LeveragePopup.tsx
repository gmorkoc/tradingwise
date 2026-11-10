import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LeveragePanel } from "./LeveragePanel";
import { BottomSheet } from "./BottomSheet";
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

  // Shared bottom sheet: full height on phones, centred popup on desktop.
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={t("leverage.title")}
      className="lev-sheet"
      bodyClassName="bs-body--pad lev-sheet-body"
      desktopModal
      startFull
    >
      <LeveragePanel currentPrice={currentPrice} zone={zone} coin={coin} hideHeader />
    </BottomSheet>
  );
};
