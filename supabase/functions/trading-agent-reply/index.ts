import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCryptoNews, NewsItem } from "../_shared/news.ts";
import { MarketContext, getMarketContext } from "../_shared/market.ts";

// Invoked synchronously from TradingAgent.tsx (request/response, not
// fire-and-forget like market-pulse-reply) — this is a private 1:1
// conversation, so the reply comes straight back as the HTTP response
// instead of arriving later via a realtime row.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

// Deno edge functions can't import src/services/coinglass.ts's COINS list
// (never import from src/ — see _shared/chartable-coins.ts) and this
// function only needs tickers, not names, so it's its own small copy —
// same "keep in sync by hand" convention as chartable-coins.ts.
const KNOWN_TICKERS = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOT", "ATOM", "TRX",
  "ETC", "LTC", "BCH", "NEAR", "ICP", "FIL", "AR", "TIA", "EGLD", "APT",
  "SUI", "STX", "CFX", "DASH", "ZEC", "XLM", "LINK", "UNI", "AAVE", "CRV",
  "INJ", "ENS", "COMP", "LDO", "DYDX", "SNX", "YFI", "UMA", "TRB", "LPT",
  "NMR", "AUCTION", "KSM", "ZEN", "SSV", "OP", "ARB", "TAO", "WLD", "ORDI",
  "BERA", "ENA", "JTO", "VIRTUAL", "RENDER", "ONDO", "DOGE", "SHIB", "PEPE",
  "FLOKI", "BONK", "WIF", "TRUMP", "MEME", "BOME", "NOT", "GALA", "CHZ",
  "APE", "AXS", "SAND", "MANA", "ENJ",
];
// A handful of common full names traders actually type instead of the
// ticker — not exhaustive, just the obvious high-frequency ones.
const NAME_ALIASES: Record<string, string> = {
  BITCOIN: "BTC", ETHEREUM: "ETH", SOLANA: "SOL", DOGECOIN: "DOGE",
  RIPPLE: "XRP", CARDANO: "ADA", POLKADOT: "DOT", LITECOIN: "LTC",
  CHAINLINK: "LINK", AVALANCHE: "AVAX",
};

interface HistoryTurn {
  role: "user" | "agent";
  content: string;
}

function scanForTicker(text: string): string | null {
  const words = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  for (const w of words) {
    if (KNOWN_TICKERS.includes(w)) return w;
    if (NAME_ALIASES[w]) return NAME_ALIASES[w];
  }
  return null;
}

// Same scan as scanForTicker but collects every distinct match instead of
// stopping at the first — a message naming 2+ coins ("compare BTC and
// ETH", "long BTC, ETH and SOL") is the clearest signal the user wants a
// multi-coin (basket) answer, not a single-coin one.
function scanAllTickers(text: string): string[] {
  const words = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const found: string[] = [];
  for (const w of words) {
    const ticker = KNOWN_TICKERS.includes(w) ? w : NAME_ALIASES[w];
    if (ticker && !found.includes(ticker)) found.push(ticker);
  }
  return found;
}

const BASKET_PHRASING = /\b(basket|spread (it )?across|diversify|top movers|my (focus|watchlist)|each of (my|the))\b/i;
// An open-ended screening ask ("find me good crypto plays", "what should
// I buy", "any good setups right now") names no coin at all — it still
// needs a candidate list to actually screen, or the model has nothing to
// reason over and just falls back to generic chat instead of proposing
// anything. Deliberately broad; a false positive here just means fetching
// a few extra coins' market data, which is cheap.
const SCREENING_PHRASING = /\b(find me|good (crypto )?(plays|setups|trades|picks)|best coins?|recommend|suggest|any (good )?(opportunit|setup|play)|ideas|screen|scan|what should i (buy|trade|long|short)|top (performers?|picks?))\b/i;
// Used when screening is requested with no stated focus coins to fall back
// on — a small, liquid default universe, not an exhaustive list.
const DEFAULT_SCREEN_UNIVERSE = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX"];

// Resolves one or more coins to analyze. Multiple explicit tickers in the
// message, basket-style phrasing with no explicit ticker ("build me a
// basket from my focus coins"), or an open-ended screening ask ("find me
// good crypto plays") all resolve to a coin LIST — everything else falls
// back through the original single-coin chain: current message, then
// history newest-first (so "notify me when ready to buy" right after a
// BTC discussion resolves to BTC), then the user's stated focus coin
// (outranks the generic `selectedCoin` hint, which is just whatever chart
// happens to be open), and only then `selectedCoin` as the last resort.
function resolveCoins(message: string, history: HistoryTurn[], focusCoins: string[], selectedCoin?: string | null): string[] {
  const direct = scanAllTickers(message);
  if (direct.length > 0) return direct;
  if (BASKET_PHRASING.test(message) && focusCoins.length > 1) return focusCoins.map((c) => c.toUpperCase());
  if (SCREENING_PHRASING.test(message)) {
    return focusCoins.length > 0 ? focusCoins.map((c) => c.toUpperCase()) : DEFAULT_SCREEN_UNIVERSE;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    // All tickers from the most recent matching turn, not just one — a
    // prior screening reply naming "BTC — ... ETH — ..." needs the full
    // set to carry forward when the user answers a follow-up like "$1,000"
    // with no ticker of its own.
    const found = scanAllTickers(history[i].content);
    if (found.length > 0) return found;
  }
  if (focusCoins.length > 0) return [focusCoins[0].toUpperCase()];
  return selectedCoin ? [selectedCoin.toUpperCase()] : [];
}

interface PortfolioSnapshot {
  cashBalance: number;
  positions: {
    coin: string; market: "spot" | "futures"; side: "long" | "short"; qty: number;
    avgEntryPrice: number; leverage: number;
  }[];
  typicalTradeUsd: number | null;
  allowLeverage: boolean;
  focusCoins: string[];
}

interface AgentAction {
  side: "buy" | "sell";
  coin: string;
  market: "spot" | "futures";
  amountUsd: number;
  leverage: number;
  takeProfit: number | null;
  stopLoss: number | null;
  reason: string;
  price: number | null;
}

interface AgentWatch {
  coin: string;
  condition: string;
}

interface AgentQuestionOption {
  label: string;
  description: string;
}

interface AgentQuestion {
  prompt: string;
  options: AgentQuestionOption[];
}

interface BalanceUpdate {
  newBalance: number;
  reason: string;
}

interface AgentResponse {
  reply: string;
  action: AgentAction | null;
  basket: AgentAction[] | null;
  watch: AgentWatch | null;
  question: AgentQuestion | null;
  balanceUpdate: BalanceUpdate | null;
  newsSources: NewsItem[] | null;
}

// Raw shape the model actually returns — "newsRefs" are indices into the
// headlines list we gave it, not real NewsItem objects, so they can't be
// trusted/shown directly (the model could invent a title/URL). The server
// maps them back to the real fetched headlines before anything reaches the
// client — see resolveNewsSources below.
interface RawAgentResponse extends Omit<AgentResponse, "newsSources"> {
  newsRefs?: number[] | null;
}

function resolveNewsSources(newsRefs: number[] | null | undefined, news: NewsItem[]): NewsItem[] | null {
  if (!newsRefs || newsRefs.length === 0) return null;
  const resolved = newsRefs
    .filter((i): i is number => Number.isInteger(i) && i >= 0 && i < news.length)
    .map((i) => news[i]);
  return resolved.length > 0 ? resolved : null;
}

function formatMarketLine(market: MarketContext): string {
  return `${market.coin} — price $${market.price.toLocaleString()}, RSI(14) ${market.rsi?.toFixed(1) ?? "n/a"}, MACD histogram ${market.macdHist?.toFixed(4) ?? "n/a"}, Bollinger %B ${market.bbPct != null ? (market.bbPct * 100).toFixed(0) + "%" : "n/a"}, ATR ${market.atr?.toFixed(2) ?? "n/a"} (${market.riskPct != null ? market.riskPct.toFixed(2) + "% of price" : "n/a"} — a reasonable per-trade invalidation distance), volume ratio ${market.volRatio?.toFixed(2) ?? "n/a"}, 4h trend bias: ${market.htfTrend ?? "n/a"}.`;
}

// LLM arithmetic on dollar figures is not trustworthy enough to show
// directly as actionable trade numbers — it's confused a "2% away" risk
// distance for a literal "$2" price before. So takeProfit/stopLoss are
// never taken from the model: they're always computed here, deterministically,
// from the real live price + ATR for the coin the leg is actually on.
// Keeps the model's job to picking side/coin/size/leverage and writing the
// prose "reason" — nothing it can get arithmetically wrong ends up
// user-facing as a specific dollar figure.
function roundPrice(n: number): number {
  if (n >= 100) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 10000) / 10000;
  return Math.round(n * 1e8) / 1e8;
}

function computeTPSL(side: "buy" | "sell", price: number, atr: number | null): { takeProfit: number; stopLoss: number } {
  const distance = atr && atr > 0 ? atr * 1.25 : price * 0.02;
  const reward = distance * 2;
  return side === "buy"
    ? { takeProfit: roundPrice(price + reward), stopLoss: roundPrice(Math.max(price - distance, 0.00000001)) }
    : { takeProfit: roundPrice(Math.max(price - reward, 0.00000001)), stopLoss: roundPrice(price + distance) };
}

function applyServerComputedTPSL(action: AgentAction | null, marketByCoin: Map<string, MarketContext>): AgentAction | null {
  if (!action) return null;
  const market = marketByCoin.get(action.coin.toUpperCase());
  if (!market) return { ...action, price: null, takeProfit: null, stopLoss: null };
  // Take-profit/stop-loss are a leveraged-futures concept here (liquidation
  // risk, margin at stake) — a spot buy just owns the coin outright, so
  // there's no position to protect with an exit order; showing one implied
  // a working safety net that doesn't exist for spot.
  if (action.market === "spot") return { ...action, price: market.price, takeProfit: null, stopLoss: null };
  const { takeProfit, stopLoss } = computeTPSL(action.side, market.price, market.atr);
  return { ...action, takeProfit, stopLoss, price: market.price };
}

// Defense in depth against a malformed/hallucinated number reaching the
// client as an actionable "set your balance to this" proposal — the client
// re-validates on confirm too, but better to drop an obviously bad value
// here than show a broken proposal card at all.
function sanitizeBalanceUpdate(bu: BalanceUpdate | null | undefined): BalanceUpdate | null {
  if (!bu || !Number.isFinite(bu.newBalance) || bu.newBalance < 0) return null;
  return { newBalance: bu.newBalance, reason: typeof bu.reason === "string" ? bu.reason : "" };
}

// Delimiter the model is instructed to emit between its free-text
// "thinking out loud" narration and the structured JSON payload — lets one
// completion serve both the live "what the agent is noticing" stream the
// UI shows while waiting, and the actual structured action/basket/
// watch/question it ends with. Unlikely to collide with real output
// (upper-case, dashes, no spaces) but checked as a whole-line match below
// anyway, not a substring, to be sure.
const JSON_DELIMITER = "===JSON===";

async function streamReply(
  message: string, history: HistoryTurn[], markets: MarketContext[], portfolio: PortfolioSnapshot,
  marketByCoin: Map<string, MarketContext>, news: NewsItem[]
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  if (!OPENAI_API_KEY) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`E:no OPENAI_API_KEY in env\n`));
        controller.close();
      },
    });
  }

  const marketLine = markets.length
    ? markets.map(formatMarketLine).join("\n")
    : "No live market data available for the coin(s) mentioned (if any) — do not propose a trade without a real current price.";
  const newsLine = news.length
    ? news.map((n, i) => `[${i}] ${n.source}: "${n.title}"`).join("\n")
    : "No recent crypto headlines were available this run.";
  const positionsLine = portfolio.positions.length
    ? portfolio.positions.map((p) =>
        p.market === "spot"
          ? `${p.coin} spot: ${p.qty} @ avg $${p.avgEntryPrice.toLocaleString()}`
          : `${p.coin} futures ${p.side} ${p.leverage}x: ${p.qty} @ avg $${p.avgEntryPrice.toLocaleString()}`
      ).join("; ")
    : "no open positions";
  const prefsLine = [
    portfolio.typicalTradeUsd ? `typical trade size ~$${portfolio.typicalTradeUsd.toLocaleString()}` : null,
    portfolio.focusCoins.length ? `focused on trading: ${portfolio.focusCoins.join(", ")}` : null,
  ].filter(Boolean).join("; ") || "no stated preferences yet";

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Full gpt-4o, not mini — this one's job is to reason carefully
        // through real indicator data like an experienced trader would,
        // not just produce a plausible-sounding reply.
        model: "gpt-4o",
        // No response_format: json_object here — the output is free-text
        // narration followed by JSON_DELIMITER then the JSON payload, not
        // a pure JSON document, so json_object mode would reject it. That
        // also means there's no structural guarantee the trailing JSON is
        // well-formed (json_object mode used to give us that for free) —
        // generous max_tokens heads off the most common cause of broken
        // JSON, getting cut off mid-object on a long basket reply.
        stream: true,
        max_tokens: 2000,
        messages: [
          {
            role: "system",
            content: `You are an expert crypto technical analyst and trader embedded in a paper-trading app — think and reason the way a seasoned prop desk trader would, not a generic assistant. This is SIMULATED trading only (no real money, no real exchange), so you act directly on the user's instructions rather than just suggesting.

Portfolio: cash $${portfolio.cashBalance.toLocaleString()}, open positions: ${positionsLine}. User preferences: ${prefsLine}. Leveraged futures trading is ${portfolio.allowLeverage ? "ENABLED" : "DISABLED"} for this user${portfolio.allowLeverage ? "" : " — you may ONLY propose spot trades (\"market\": \"spot\", \"leverage\": 1); if they ask for leverage/margin/long/short/futures, tell them plainly it's off in their settings and that they can enable it from the onboarding/consent screen, and do not propose a futures action"}.

Live market data: ${marketLine}

Recent crypto headlines (index — source: "title"), freshest first:
${newsLine}

Before answering, actually reason through what's given, top-down like a real desk trader: start with the 4h trend bias — "up" or "down" means there's a dominant trend, "range" means there isn't one to lean on. A 1h setup that agrees with the 4h trend deserves more conviction; a setup that fights it (e.g. a "buy" signal while the 4h trend is "down") needs a materially stronger reason, and you should say so explicitly rather than ignoring the conflict. Within that frame: RSI above 70 or below 30 signals overbought/oversold; MACD histogram sign and its trend (not just its value) signals momentum shifting; Bollinger %B near 0 or 1 signals a band-edge test; an elevated volume ratio alongside a directional move signals conviction vs a low-volume drift. Weigh these together into one coherent read rather than listing them — a real trader synthesizes signals into a single thesis, they don't recite indicator values.

Also weigh the headlines above into your read, same as a real trader scanning the news before acting — a headline about the SPECIFIC coin in play, or genuinely market-moving macro/regulatory news (an ETF ruling, an exchange collapse, a major hack, a Fed move, a stablecoin depeg), can outweigh a purely technical setup; routine/unrelated headlines shouldn't be forced in just because they exist. Set "newsRefs" to the index numbers (from the list above) of any headlines that actually informed your read — an empty array if none were relevant, never invented indices. If a headline does inform your read, say so concretely in your narration/reply (e.g. "CoinDesk's piece on the ETF inflows lines up with the volume pickup here") rather than vaguely gesturing at "the news."

Risk management is not optional color, it's part of the job: never suggest sizing a trade so large relative to the stated typical trade size or portfolio cash that one bad move would be ruinous — if the user asks to size up aggressively into a counter-trend or low-conviction setup, say so plainly instead of just complying. Use the ATR-based risk % given above to frame how far price could reasonably move against the position, and fold that into "reason" (e.g. "~2% ATR risk, with-trend on the 4h — sized at typical size"). Factor the user's stated typical trade size and preferences into both whether you'd size a suggested trade up/down and the tone of your read (e.g. a stated preference for majors vs small-caps should shape how you frame risk).

Respond ONLY as JSON matching exactly this shape, nothing else:
{"reply": string, "action": {"side": "buy"|"sell", "coin": string, "market": "spot"|"futures", "amountUsd": number, "leverage": number, "takeProfit": number|null, "stopLoss": number|null, "reason": string} | null, "basket": [{same shape as action}] | null, "watch": {"coin": string, "condition": string} | null, "question": {"prompt": string, "options": [{"label": string, "description": string}]} | null, "balanceUpdate": {"newBalance": number, "reason": string} | null, "newsRefs": number[]}

Exactly ONE of "action", "basket", "watch", "question", "balanceUpdate" may be non-null at a time (all five null is also valid — plain chat). Never set two of them together.

Set "action" to a real object ONLY when the user's message is a concrete instruction to buy/sell/long/short ONE specific coin (e.g. "buy $200 of BTC", "sell half my ETH", "long SOL 3x", "short BTC with 5x leverage") AND you have real live price data for that coin above — never invent a price or propose a trade for a coin with no market data. You support BOTH plain spot trading (own the asset outright, "buy"/"sell") and leveraged futures (margin-based "long"/"short", mapped to "buy"/"sell" in this schema). Default to "market": "spot" unless the user explicitly asks for leverage, margin, a long/short, or futures/perps — never add leverage the user didn't ask for. When they do ask for futures: "amountUsd" is the MARGIN they're putting up (not notional — notional = amountUsd * leverage), and "leverage" must be a deliberate, reasonable choice (1-20x), not a reflex — lean toward 2-3x for a lower-conviction or counter-trend setup, up to 5-8x only for a clean, with-trend, high-conviction setup on a major, and stay conservative (1-3x) on volatile small-caps/memecoins regardless of conviction; if the user asks for something reckless (e.g. 20x on a memecoin) either talk them down with a lower number and say why, or comply explicitly only if they insist, but never silently comply with an obviously ruinous size. For a spot action, set "leverage" to 1. If the user states an explicit budget/amount for THIS trade (e.g. "my budget is 20k, buy spot"), use that full stated amount as "amountUsd" by default — do not silently size it down to a fraction of what they said. The one exception is sizing down for a genuinely weak/mixed/conflicting setup (e.g. RSI not yet oversold, range-bound trend, negative MACD) — that's a legitimate, professional call (scaling in at half size rather than full size, or passing on the setup entirely), but if you make it, you MUST say so explicitly and specifically in "reply" itself (e.g. "Sizing at $10k, half your stated budget — RSI isn't fully oversold and the 4h trend is range-bound, so I'd rather scale in than go full size here"), not just in "reason" where the user won't see it, and not leave it as an unexplained gap between what they asked for and what you proposed. If the signals are weak enough that you wouldn't take the trade at all, set "action" to null and say plainly why you're passing rather than taking a token position anyway just because they asked. Ground "amountUsd" in actual numbers (if the user says a coin quantity instead of a dollar amount, convert it using the live price above; if the user gives no size at all but asks you to act, default to their typical trade size when known). "reason" must read like an expert's actual justification — name the specific signal(s) driving it (e.g. "RSI at 24 with MACD histogram turning positive — oversold bounce setup"), never generic boilerplate like "market looks good." Set "action" to null for anything that isn't a concrete trade instruction (questions, opinions, "what do you think", general chat) — "reply" should still be a sharp, substantive, expert-level read in that case, not vague hedging, while staying clearly framed as one read of the data rather than guaranteed fact. Keep "reply" proportional to the question: a trade's own justification should stay tight (well under 400 characters), but a genuine advisory question deserves real depth and should NOT be artificially cut short to fit that same budget — see the next paragraph.

Timing/entry/exit questions ("when's the right time to buy", "what should I wait for before entering", "what would make me hold vs exit this", "is now a good time to buy the dip") are where this agent is judged on whether it can actually think, not just execute — answer them like a desk trader walking a junior through their actual checklist, not a one-line platitude. Concretely: name 2-4 SPECIFIC, checkable conditions grounded in the real live data given above, each paired with the current reading next to the threshold that would flip it — e.g. "RSI needs to clear below 30 to call this oversold — it's at 42 now, not there yet", "the 4h trend needs to flip from range to up — watch for the SMA20 crossing back above the SMA50", "volume ratio should climb back above ~1.3x to confirm real participation rather than a dead-cat bounce, it's at 0.8x currently". For a question about EXITING or HOLDING an existing position, pull their actual entry price/side from the portfolio snapshot above and frame conditions relative to it (e.g. "you're in at $84,200 — a clean invalidation would be a close back below that on rising volume, not just a wick"). Never answer with a vague generic like "wait for a pullback" or "watch the trend" with no number attached — if you don't have a concrete number for a condition, say what you'd need to see instead of hand-waving. When it would genuinely help, mention in "reply" that you can set up a watch for the clearest one of these conditions so they don't have to keep checking back manually (e.g. "say the word and I'll watch for RSI to cross below 30") — but don't set "watch" in the same turn as this (every field must still follow the one-of-five rule below); only act on it if they then ask for it. This kind of answer can run to a real paragraph if the analysis genuinely calls for it — don't pad for length, but don't truncate a multi-condition answer into something vague just to stay short.

Set "basket" (and leave "action" null) when the request spans MULTIPLE coins at once — e.g. "long BTC, ETH and SOL", "build me a basket from my focus coins", "spread $2000 across the strongest alts" — including when the current message is just the answer to your own prior clarifying "question" (e.g. you screened BTC/ETH/SOL and asked about budget, and the user just replied "$1,000" — that's still a basket across the coins you already named, now that you have a size). You'll be given live market data for every candidate coin above; use it to decide which ones actually deserve a position (don't force a leg for a coin whose setup is weak just because it was named — say in "reply" why you dropped one if you do) and size/leverage/TP/SL each leg exactly as you would a single "action", including the same leverage and risk-management discipline. Divide the user's stated total budget across legs (equal split unless conviction clearly differs and you say so), or use their typical trade size per leg if no total was given.

Set "takeProfit" and "stopLoss" to null on every leg of an "action" or "basket" — never try to compute dollar figures for them yourself. For a "futures" leg the app computes the actual price levels itself from live ATR data once it has your side/coin/entry/leverage, so you can reference the ATR-based risk % qualitatively in "reason" (e.g. "~2% ATR stop"), just never state a specific take-profit/stop-loss dollar price in "reply" or "reason" since the number you'd write isn't the one that will actually show. For a "spot" leg, there is no take-profit/stop-loss at all — a spot buy just owns the coin outright with no margin or liquidation at stake, so don't frame your reasoning as if an exit order is protecting the position; a spot "reason" should read like a thesis for owning the coin, not a leveraged-trade risk writeup.

Set "watch" to a real object ONLY when the user is asking to be notified/alerted/watched for something rather than asking for an immediate trade (e.g. "notify me when it's ready to buy", "let me know if RSI gets oversold", "watch ETH for a breakout above $4000"). Resolve "coin" using the conversation so far if the current message doesn't name one itself (e.g. a prior message about BTC followed by "notify me when ready to buy" means coin: "BTC") — never guess a coin with no basis in the conversation. Phrase "condition" as a concrete, re-checkable technical condition (e.g. "RSI(14) drops below 30" or "price breaks above $4000"), not a vague restatement.

Set "balanceUpdate" ONLY when the user explicitly asks to change their overall paper account balance/budget itself (e.g. "update my budget to $5,000", "set my cash balance to 10k", "reset my balance to $50,000", "I want to change my starting budget") — this is a portfolio setting change, not a trade. Do NOT confuse this with a user simply stating their available funds for one specific trade (e.g. "my budget is $20k, buy BTC spot" is an "action" sized from a stated amount, not a balanceUpdate — they're telling you what they have to work with for that trade, not asking you to overwrite their stored balance). "newBalance" is the exact new cash figure (convert "10k" to 10000, etc.), and "reason" is a short, plain confirmation of what's changing (e.g. "Updating your paper balance from $1,000 to $5,000 as requested."). This never executes silently — like every other proposal here, the app shows it as a confirm/dismiss card and nothing changes until the user taps Confirm, so just propose it plainly rather than hedging.

Set "question" when you genuinely can't finalize an action/basket without more input from the user, most commonly: a basket-style or open-ended screening request ("find me good crypto plays", "what should I buy", "build me a basket") with no stated budget or coin count, or a request whose risk/size is materially ambiguous even with their stated typical trade size/preferences known. IMPORTANT: for a screening-style request, you are ALWAYS given live market data for several candidate coins above specifically so you can screen them — never respond with plain chat and no "question" just because no single coin or size was named; that's a sign you should rank the candidates and ask a sizing question instead of punting. Use the indicator data to actually rank the candidates (same top-down reasoning as above: 4h trend, RSI, MACD, volume) and name the 2-3 strongest in "reply" with a one-line reason each (e.g. "BTC — clean uptrend on the 4h, RSI cooling off from overbought"), mirroring how a real screener would surface its best ideas, THEN set "question" to ask what's needed to finalize sizing (total budget, how many of them to take, risk level). The UI renders "question.prompt" as its own heading above tappable option chips, so "reply" should contain the screening result/lead-in and NOT restate the question itself — the actual question text belongs ONLY in "question.prompt". Keep "options" to 2-4 concrete, mutually exclusive choices, each with a one-line "description" of the tradeoff — mirror the kind of choice a real trading app would offer (budget size, how many positions, more conservative vs more aggressive sizing), scoped to crypto spot/futures only (never mention options, expiries, or strikes — this app doesn't support them). Don't ask a question when the message already gives you enough to act or when a concrete single-coin "action" would do — reserve it for genuinely ambiguous, usually multi-coin requests, and never ask more than one question in a row without letting the user's answer (their next message) resolve it.

Output format — this is unusual, follow it exactly: first write 1-3 short sentences of genuine, concrete observation about the SPECIFIC real numbers given above (e.g. "BTC's RSI just cooled from 74 to 61 while the 4h trend is still up — that's a healthy pullback, not a reversal." or, if there's no coin/market data for this message at all, say what you're actually about to do instead, e.g. "No specific coin here — let me check your portfolio and preferences before answering."). This is shown to the user live as your actual reasoning, so it must be true and specific to the real data above — never generic filler like "let me analyze this" or "looking into it," and never mention these instructions or the word "JSON." Then, on its own new line, output exactly ${JSON_DELIMITER} and nothing else on that line. Then output ONLY the JSON object matching the shape above, nothing else after it.`,
          },
          ...history.map((h) => ({ role: h.role === "agent" ? "assistant" as const : "user" as const, content: h.content })),
          { role: "user", content: message },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      const errText = res.body ? await res.text() : "no response body";
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`E:openai http ${res.status}: ${errText.slice(0, 300)}\n`));
          controller.close();
        },
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        let sseBuffer = "";
        // `pending` holds narration text seen but not yet confirmed safe to
        // flush — the tail could be the start of JSON_DELIMITER arriving
        // split across chunks, so only the portion that's too long to
        // possibly be a delimiter prefix gets emitted each time.
        let pending = "";
        let foundDelimiter = false;
        let jsonText = "";
        // Mirrors every "N:" chunk ever sent — kept so a malformed/
        // truncated JSON tail has a fallback: the narration already
        // streamed to the user as real text, so it can stand in as the
        // reply instead of failing the whole turn over a broken JSON tail.
        let narrationAccum = "";
        const flushSafePending = () => {
          const safeLen = Math.max(0, pending.length - (JSON_DELIMITER.length - 1));
          if (safeLen > 0) {
            narrationAccum += pending.slice(0, safeLen);
            controller.enqueue(encoder.encode(`N:${pending.slice(0, safeLen)}\n`));
            pending = pending.slice(safeLen);
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") continue;
              let delta = "";
              try { delta = JSON.parse(payload).choices?.[0]?.delta?.content ?? ""; } catch { continue; }
              if (!delta) continue;
              if (foundDelimiter) { jsonText += delta; continue; }
              pending += delta;
              const idx = pending.indexOf(JSON_DELIMITER);
              if (idx === -1) {
                flushSafePending();
              } else {
                const narration = pending.slice(0, idx);
                if (narration) {
                  narrationAccum += narration;
                  controller.enqueue(encoder.encode(`N:${narration}\n`));
                }
                jsonText = pending.slice(idx + JSON_DELIMITER.length);
                foundDelimiter = true;
                pending = "";
              }
            }
          }
          if (!foundDelimiter && pending) {
            // Model never emitted the delimiter (format slip) — flush
            // whatever narration we held back as a precaution.
            narrationAccum += pending;
            controller.enqueue(encoder.encode(`N:${pending}\n`));
          }

          // No response_format: json_object here — the narration-then-JSON
          // format is incompatible with it, so nothing structurally
          // guarantees the trailing JSON is well-formed or shaped right.
          // Rather than fail the whole turn over a broken/missing JSON
          // tail, fall back to the narration itself as the reply (it
          // already streamed to the user as real text) with no
          // action/basket/watch/question — a plain answer beats an error
          // whenever there's real narration to fall back to.
          let raw: RawAgentResponse | null = null;
          try {
            const candidate = JSON.parse(jsonText.trim()) as RawAgentResponse;
            if (typeof candidate.reply === "string") raw = candidate;
          } catch { /* fall through to the narration fallback below */ }

          let parsed: AgentResponse;
          if (raw) {
            const { newsRefs, ...rawWithoutNewsRefs } = raw;
            parsed = { ...rawWithoutNewsRefs, newsSources: resolveNewsSources(newsRefs, news) };
          } else if (narrationAccum.trim()) {
            parsed = { reply: narrationAccum.trim(), action: null, basket: null, watch: null, question: null, balanceUpdate: null, newsSources: null };
          } else {
            throw new Error("The agent's response was cut off — please try again.");
          }
          parsed.action = applyServerComputedTPSL(parsed.action, marketByCoin);
          if (parsed.basket) {
            parsed.basket = parsed.basket
              .map((leg) => applyServerComputedTPSL(leg, marketByCoin))
              .filter((leg): leg is AgentAction => leg !== null);
          }
          parsed.balanceUpdate = sanitizeBalanceUpdate(parsed.balanceUpdate);
          controller.enqueue(encoder.encode(`J:${JSON.stringify(parsed)}\n`));
        } catch (e) {
          controller.enqueue(encoder.encode(`E:${e instanceof Error ? e.message : String(e)}\n`));
        } finally {
          controller.close();
        }
      },
    });
  } catch (e) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`E:exception: ${e instanceof Error ? e.message : String(e)}\n`));
        controller.close();
      },
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);
    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    if (!OPENAI_API_KEY) return new Response("Server not configured", { status: 500, headers: corsHeaders });

    const { message, selectedCoin, history } = await req.json();
    if (typeof message !== "string" || !message.trim()) {
      return new Response("Missing message", { status: 400, headers: corsHeaders });
    }
    const safeHistory: HistoryTurn[] = Array.isArray(history)
      ? history.filter((h): h is HistoryTurn => h && (h.role === "user" || h.role === "agent") && typeof h.content === "string")
      : [];

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const [{ data: portfolioRow }, { data: positionRows }] = await Promise.all([
      supabaseAdmin.from("paper_portfolios").select("cash_balance, typical_trade_usd, allow_leverage, focus_coins").eq("user_id", user.id).maybeSingle(),
      supabaseAdmin.from("paper_positions").select("coin, market, side, qty, avg_entry_price, leverage").eq("user_id", user.id),
    ]);
    const portfolio: PortfolioSnapshot = {
      cashBalance: portfolioRow?.cash_balance ?? 100000,
      positions: (positionRows ?? []).map((p) => ({
        coin: p.coin, market: p.market, side: p.side, qty: p.qty, avgEntryPrice: p.avg_entry_price, leverage: p.leverage,
      })),
      typicalTradeUsd: portfolioRow?.typical_trade_usd ?? null,
      allowLeverage: portfolioRow?.allow_leverage ?? false,
      focusCoins: portfolioRow?.focus_coins ?? [],
    };

    // Capped at 6 — a basket pulling from a long focus-coin list shouldn't
    // turn into dozens of parallel candle fetches. News fetch runs in
    // parallel with the market-data fetch, not after it — they're
    // independent, no reason to pay for them sequentially.
    const coins = resolveCoins(message, safeHistory, portfolio.focusCoins, selectedCoin).slice(0, 6);
    const [marketResults, news] = await Promise.all([
      Promise.all(coins.map(getMarketContext)),
      fetchCryptoNews(),
    ]);
    const markets = marketResults.filter((m): m is MarketContext => m !== null);

    const marketByCoin = new Map(markets.map((m) => [m.coin.toUpperCase(), m]));
    const stream = await streamReply(message, safeHistory, markets, portfolio, marketByCoin, news);

    // Plain line-based protocol, not real SSE framing — but served as
    // text/event-stream with no-buffering headers anyway, since that's the
    // content-type intermediate proxies/CDNs are least likely to buffer in
    // full before forwarding; text/plain was getting held until the whole
    // response completed, defeating the point of streaming it. The client
    // reads line-by-line regardless: "N:" (a chunk of live narration), "J:"
    // (the final structured response, once), or "E:" (an error).
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`error: ${msg}`);
    return new Response(`error: ${msg}`, { status: 500, headers: corsHeaders });
  }
});
