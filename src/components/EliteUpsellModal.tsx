import { useAuthFirst } from "../hooks/useAuthFirst";
import { TierPlanSheet, usePhoneWidth } from "./PlanSheet";
import { DesktopTierPopup } from "./PaywallPromo";

interface Props {
  onClose: () => void;
  onOpenAuth: () => void;
}

// Elite offer — shown when a non-Elite user taps an Elite-only feature
// (Agent ready), opened on Elite: the full-screen plan screen on phones,
// the "Choose your plan" screen with Elite highlighted on desktop.
export function EliteUpsellModal({ onClose, onOpenAuth }: Props) {
  // Signed out → the sign-in window opens instead of this offer; it appears
  // once signed in, and closes if sign-in is dismissed.
  const signedIn = useAuthFirst(true, onOpenAuth, onClose);
  const phone = usePhoneWidth();
  if (!signedIn) return null;
  if (phone) return <TierPlanSheet open onClose={onClose} promoted="elite" onOpenAuth={onOpenAuth} />;
  return <DesktopTierPopup open onClose={onClose} promoted="elite" featureName="Agent ready" onOpenAuth={onOpenAuth} />;
}
