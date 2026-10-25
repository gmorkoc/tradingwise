import { registerPlugin } from "@capacitor/core";

// Bridges to ios/App/App/HeaderGlassPlugin.swift — real native UIGlassEffect
// (iOS 26+) for the top header's menu/chart-toggle/notifications buttons,
// replacing the CSS backdrop-filter approximation when available. Mirrors
// services/liquidGlassNav.ts's own pattern for the bottom nav bar.
export interface HeaderGlassState {
  mode: "chart" | "orderbook";
  unreadCount: number;
}

interface HeaderGlassPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  show(): Promise<void>;
  hide(): Promise<void>;
  update(state: HeaderGlassState): Promise<void>;
  addListener(eventName: "tap", listenerFunc: (data: { label: string }) => void): Promise<{ remove: () => void }>;
}

export const HeaderGlass = registerPlugin<HeaderGlassPlugin>("HeaderGlass");
