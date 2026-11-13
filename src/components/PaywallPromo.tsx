import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BlurGate } from "./MembershipGate";
import { BottomSheet } from "./BottomSheet";
import { PlanIcon, TierPlanSheet, tierFeatures, usePhoneWidth } from "./PlanSheet";
import { useAuth } from "../contexts/AuthContext";
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

// Tapping a locked page in the menu shows its upgrade promo here without
// navigating, so the user stays on the page they were on. Phones: the
// full-screen plan screen. Desktop: the upgrade popup with Pro | Elite tabs.
// Opening a locked page's URL directly still shows the full-page paywall
// (BlurGate in place).
export function PaywallPromo({ open, onClose, requiredTier, featureName, onOpenAuth, onOpenUpgrade, extraFeature }: Props) {
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
      onOpenUpgrade={onOpenUpgrade}
      extraFeature={extraFeature}
    />
  );
}

/**
 * Desktop upgrade popup: the Pro / Elite card (BlurGate's, so pricing,
 * checkout and Pro→Elite proration are the same as everywhere) with
 * Pro | Elite tabs on top — the promoted plan first and selected. Tabs only
 * for free users (a Pro user has nothing to buy on the Pro tab).
 */
export function DesktopTierPopup({ open, onClose, promoted, featureName, onOpenAuth, onOpenUpgrade, extraFeature }: {
  open: boolean;
  onClose: () => void;
  promoted: "pro" | "elite";
  featureName?: string;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  extraFeature?: { icon: ReactNode; title: string; desc: string };
}) {
  const { t } = useTranslation();
  const { tier } = useAuth();
  const [tab, setTab] = useState<"pro" | "elite">(promoted);
  useEffect(() => { if (open) setTab(promoted); }, [open, promoted]);
  const showTabs = tier === "free";
  const order: ("pro" | "elite")[] = promoted === "elite" ? ["elite", "pro"] : ["pro", "elite"];
  const planName = tab === "elite" ? "Elite" : "Pro";
  // The tab's own card element: the sheet's background follows it.
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      desktopModal
      className={`paywall-promo-sheet paywall-promo-sheet--${tab}${showTabs ? " paywall-promo-sheet--tabs" : ""}`}
      ariaLabel={featureName ? t("paywallPromo.ariaLabel", { feature: featureName }) : planName}
    >
      {showTabs && (
        <div className="pp-tabs" role="tablist">
          {order.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`pp-tab pp-tab--${id}${tab === id ? " pp-tab--on" : ""}`}
              onClick={() => setTab(id)}
            >
              {id === "elite" ? "Elite" : "Pro"}
            </button>
          ))}
        </div>
      )}
      {/* Both plans' cards sit in the same grid cell; the other one is
          hidden but still takes up room, so the popup keeps the same size
          when switching tabs. */}
      <div className="pp-cards">
        {(showTabs ? order : [tab]).map((id) => {
          const name = id === "elite" ? "Elite" : "Pro";
          return (
            <div key={id} className={`pp-card-slot${id === tab ? "" : " pp-card-slot--hidden"}`} aria-hidden={id !== tab}>
              <BlurGate
                requiredTier={id}
                featureName={featureName ?? name}
                // Stays open under the sign-in window, so it's still here (now
                // with the signed-in upgrade button) once sign-in finishes.
                onOpenAuth={() => { onOpenAuth(); }}
                onOpenUpgrade={() => { onClose(); onOpenUpgrade(); }}
                className="bg-root--promo"
                // Same benefits as the phone plan screen, as a compact list.
                featureList={tierFeatures(id, t, !!extraFeature).map((f) => ({ key: f.key, icon: <PlanIcon name={f.icon} size={18} />, label: f.label }))}
                // "Candle Insights is part of Pro" — only on the plan it's about.
                eyebrow={featureName && id === promoted ? t("paywallPromo.eyebrow", { feature: featureName, plan: name }) : undefined}
              >
                <div />
              </BlurGate>
            </div>
          );
        })}
      </div>
    </BottomSheet>
  );
}
