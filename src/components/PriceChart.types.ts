export type ZoneSignal = "strong-buy" | "buy" | "neutral" | "oversold" | "overbought" | "sell" | "strong-sell";

export interface ZoneResult {
  buyZone:  { upper: number; lower: number };
  sellZone: { upper: number; lower: number };
  signal:   ZoneSignal;
}
