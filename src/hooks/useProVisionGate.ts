import { useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { hasProVisionPlan } from "../services/supabase";
import { useProVision } from "./useProVision";
import { useProVisionAccess, type PvLockReason } from "./useProVisionAccess";

// One place that answers "can this user run ProVision on this coin?" and
// opens the ProVision sales sheet when not. Every ProVision switch (top bar,
// Advance toolbar, mobile side menu) and the chart itself go through this.

const PAYWALL_EVT = "provision-paywall";

export interface PaywallRequest { reason: PvLockReason; coin?: string }

/** Ask the app-level ProVisionPaywallHost to open the sales sheet. */
export function openProVisionPaywall(req: PaywallRequest) {
  window.dispatchEvent(new CustomEvent<PaywallRequest>(PAYWALL_EVT, { detail: req }));
}
export function onProVisionPaywall(fn: (req: PaywallRequest) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<PaywallRequest>).detail);
  window.addEventListener(PAYWALL_EVT, h);
  return () => window.removeEventListener(PAYWALL_EVT, h);
}

export function useProVisionGate() {
  const { user, profile, tier } = useAuth();
  const [on, setOn] = useProVision();
  const access = useProVisionAccess({
    signedIn: !!user,
    tier,
    hasPlan: hasProVisionPlan(profile),
    trialStartedAt: profile?.provision_trial_started_at ?? null,
  });

  /** A ProVision switch was tapped while looking at `coin`. */
  const toggle = useCallback((coin: string) => {
    if (on) { setOn(false); return; }
    const reason = access.lockReason(coin);
    if (reason) { openProVisionPaywall({ reason, coin }); return; }
    setOn(true);
  }, [on, setOn, access]);

  return {
    /** User's switch position. */
    on,
    setOn,
    access,
    /** Switch is on AND this coin is unlocked. */
    activeFor: (coin: string) => on && access.allowed(coin),
    toggle,
  };
}
