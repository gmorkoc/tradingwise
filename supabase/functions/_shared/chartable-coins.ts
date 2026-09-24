// Ported twin of the COINS list in src/services/coinglass.ts (same
// "edge functions never import from src/" reasoning as indicators.ts) —
// just the symbols, which is all buy-signal-scan needs. Keep in sync by
// hand when the source list changes.
//
// HYPE and GRASS are excluded — coinglass.ts's own NO_BINANCE_SPOT set
// confirms neither has a real HYPEUSDT/GRASSUSDT spot pair, so a klines
// fetch for either 400s.
export const SCAN_COINS = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOT", "ATOM", "TRX",
  "ETC", "LTC", "BCH", "NEAR", "ICP", "FIL", "AR", "TIA", "EGLD", "APT",
  "SUI", "STX", "CFX", "DASH", "ZEC", "XLM", "LINK", "UNI", "AAVE", "CRV",
  "INJ", "ENS", "COMP", "LDO", "DYDX", "SNX", "YFI", "UMA", "TRB", "LPT",
  "NMR", "AUCTION", "KSM", "ZEN", "SSV", "OP", "ARB", "TAO", "WLD", "ORDI",
  "BERA", "ENA", "JTO", "VIRTUAL", "RENDER", "ONDO", "DOGE", "SHIB", "PEPE",
  "FLOKI", "BONK", "WIF", "TRUMP", "MEME", "BOME", "NOT", "GALA", "CHZ",
  "APE", "AXS", "SAND", "MANA", "ENJ",
];
