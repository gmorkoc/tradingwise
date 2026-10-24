import { registerPlugin } from "@capacitor/core";

// Bridges to ios/App/App/LiquidGlassNavPlugin.swift — a real native
// UIGlassEffect (iOS 26+) floating nav bar, replacing the CSS
// backdrop-filter approximation in FloatingNavBar.tsx/.css when available.
// isAvailable() is false on anything older (or non-iOS), and FloatingNavBar
// falls back to its own CSS rendering in that case — this plugin is never
// called at all on those platforms.
export interface LiquidGlassNavState {
  active: string | null;
  theme: "dark" | "light";
  raised: boolean;
  agentUnread: boolean;
  agentLocked: boolean;
  showcase: boolean;
}

interface LiquidGlassNavPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  show(): Promise<void>;
  hide(): Promise<void>;
  update(state: LiquidGlassNavState): Promise<void>;
  addListener(eventName: "tap", listenerFunc: (data: { label: string }) => void): Promise<{ remove: () => void }>;
}

export const LiquidGlassNav = registerPlugin<LiquidGlassNavPlugin>("LiquidGlassNav");
