import { type ReactNode } from "react";
import { TierPlanSheet, usePhoneWidth } from "./PlanSheet";
import { UpgradeModal } from "./UpgradeModal";
import { useAuthFirst } from "../hooks/useAuthFirst";
import type { Tier } from "../services/supabase";

interface Props {
  open: boolean;
  onClose: () => void;
  requiredTier: Tier;
  featureName: string;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  // Analyze a Chart: adds that feature to the phone screen's Pro list.
  extraFeature?: { icon: ReactNode; title: string; desc: string };
}

// Tapping a locked page in the menu shows its upgrade promo here without
// navigating, so the user stays on the page they were on. Phones: the
// full-screen plan screen. Desktop: the "Choose your plan" screen with the
// feature's plan highlighted. Opening a locked page's URL directly still
// shows the full-page paywall (BlurGate in place).
export function PaywallPromo({ open, onClose, requiredTier, featureName, onOpenAuth, extraFeature }: Props) {
  // Signed out → the sign-in window opens instead; the promo appears only
  // once signed in (and closes if sign-in is dismissed).
  const signedIn = useAuthFirst(open, onOpenAuth, onClose);
  const phone = usePhoneWidth();
  const promoted = requiredTier === "elite" ? "elite" : "pro";
  if (phone) {
    return (
      <TierPlanSheet
        open={open && signedIn}
        onClose={onClose}
        promoted={promoted}
        onOpenAuth={onOpenAuth}
        withAnalyzeChart={!!extraFeature}
      />
    );
  }
  return (
    <DesktopTierPopup
      open={open && signedIn}
      onClose={onClose}
      promoted={promoted}
      featureName={featureName}
      onOpenAuth={onOpenAuth}
    />
  );
}

/**
 * Desktop: the "Choose your plan" screen (UpgradeModal — Free / Pro /
 * Elite side by side), opened with the promoted plan highlighted and, when
 * it came from a locked feature, "X is part of Pro" above the title.
 */
export function DesktopTierPopup({ open, onClose, promoted, featureName, onOpenAuth }: {
  open: boolean;
  onClose: () => void;
  promoted: "pro" | "elite";
  featureName?: string;
  onOpenAuth: () => void;
}) {
  if (!open) return null;
  return <UpgradeModal onClose={onClose} onOpenAuth={onOpenAuth} focus={promoted} feature={featureName} />;
}
