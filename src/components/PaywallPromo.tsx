import type { ReactNode } from "react";
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
  return (
    <BottomSheet
      open={open && signedIn}
      onClose={onClose}
      desktopModal
      className={`paywall-promo-sheet paywall-promo-sheet--${requiredTier === "elite" ? "elite" : "pro"}`}
      ariaLabel={t("paywallPromo.ariaLabel", { feature: featureName })}
    >
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
    </BottomSheet>
  );
}
