import type { ReactNode } from "react";
import { BlurGate } from "./MembershipGate";
import { BottomSheet } from "./BottomSheet";
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
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      desktopModal
      className={`paywall-promo-sheet paywall-promo-sheet--${requiredTier === "elite" ? "elite" : "pro"}`}
      ariaLabel={`${featureName} — upgrade`}
    >
      <BlurGate
        requiredTier={requiredTier}
        featureName={featureName}
        onOpenAuth={() => { onClose(); onOpenAuth(); }}
        onOpenUpgrade={() => { onClose(); onOpenUpgrade(); }}
        className="bg-root--promo"
        extraFeature={extraFeature}
        eyebrow={`${featureName} is part of ${requiredTier === "elite" ? "Elite" : "Pro"}`}
      >
        <div />
      </BlurGate>
    </BottomSheet>
  );
}
