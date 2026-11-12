import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BlurGate } from "./MembershipGate";
import { BottomSheet } from "./BottomSheet";
import { useAuthFirst } from "../hooks/useAuthFirst";
import type { Tier } from "../services/supabase";
import "../styles/PaywallPromo.css";

interface Props {
  open: boolean;
  onClose: () => void;
  requiredTier: Tier;
  featureName: string;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  // Extra first item in the card's feature list (e.g. Analyze a Chart).
  extraFeature?: { icon: ReactNode; title: string; desc: string };
}

// Tapping a locked page in the menu shows its upgrade promo here — the
// shared bottom sheet on phones, a centered popup on desktop — without
// navigating, so the user stays on the page they were on. Opening a locked
// page's URL directly still shows the full-page paywall (BlurGate in place).
// The card itself is BlurGate's, so pricing/checkout/upgrade logic is the
// same everywhere; PaywallPromo.css lays it out flat inside the sheet.
export function PaywallPromo({ open, onClose, requiredTier, featureName, onOpenAuth, onOpenUpgrade, extraFeature }: Props) {
  // Signed out → the sign-in window opens instead; this sheet appears only
  // once signed in (and closes if sign-in is dismissed).
  const signedIn = useAuthFirst(open, onOpenAuth, onClose);
  const { t } = useTranslation();
  const planName = requiredTier === "elite" ? "Elite" : "Pro";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const gate = (
    <BlurGate
      requiredTier={requiredTier}
      featureName={featureName}
      // Stays open under the sign-in window, so it's still here (now with
      // the signed-in upgrade button) once sign-in / sign-up finishes.
      onOpenAuth={() => { onOpenAuth(); }}
      onOpenUpgrade={() => { onClose(); onOpenUpgrade(); }}
      className="bg-root--promo"
      extraFeature={extraFeature}
      eyebrow={t("paywallPromo.eyebrow", { feature: featureName, plan: planName })}
    >
      <div />
    </BlurGate>
  );
  // Phones: the same full-screen page as the Elite upsell (EliteUpsellModal)
  // — its background, ✕ top-right, scrolling card — not a bottom sheet.
  if (phone) {
    if (!open || !signedIn) return null;
    return createPortal(
      <div className="bg-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          className={`bg-elite-card bg-elite-card--modal paywall-promo-modal paywall-promo-modal--${requiredTier === "elite" ? "elite" : "pro"}`}
          role="dialog"
          aria-label={t("paywallPromo.ariaLabel", { feature: featureName })}
        >
          <button className="bg-modal-close" onClick={onClose} aria-label={t("eliteUpsell.close")}>✕</button>
          {gate}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <BottomSheet
      open={open && signedIn}
      onClose={onClose}
      desktopModal
      className={`paywall-promo-sheet paywall-promo-sheet--${requiredTier === "elite" ? "elite" : "pro"}`}
      ariaLabel={t("paywallPromo.ariaLabel", { feature: featureName })}
    >
      {gate}
    </BottomSheet>
  );
}
