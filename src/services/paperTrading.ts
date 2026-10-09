import { supabase } from "./supabase";
import { fetchLivePrice } from "./coinglass";

// supabase-js's functions.invoke() buffers the whole response before
// resolving — no good for streaming the agent's live reasoning text, so
// sendAgentMessage talks to the function directly over fetch instead.
const AGENT_REPLY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-agent-reply`;
const AGENT_SPEECH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-speech`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface PaperPosition {
  coin: string;
  market: "spot" | "futures";
  side: "long" | "short";
  qty: number;
  avgEntryPrice: number;
  leverage: number;
  marginUsd: number;
  liquidationPrice: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
}

export interface PaperPortfolio {
  cashBalance: number;
  positions: PaperPosition[];
  consentAcceptedAt: string | null;
  typicalTradeUsd: number | null;
  allowLeverage: boolean;
  focusCoins: string[];
}

export interface PreferencesUpdate {
  startingBalance?: number;
  typicalTradeUsd?: number;
  allowLeverage?: boolean;
  focusCoins?: string[];
}

export interface AgentAction {
  side: "buy" | "sell";
  coin: string;
  market: "spot" | "futures";
  amountUsd: number;
  leverage: number;
  takeProfit: number | null;
  stopLoss: number | null;
  reason: string;
  // The live price the agent proposed this at — used only to estimate net
  // profit/loss for display; execution always refetches a fresh price.
  price: number | null;
}

export type MarketInterval = "1h" | "4h" | "1d";

export interface AgentWatch {
  id: string;
  coin: string;
  conditionText: string;
  interval: MarketInterval;
  active: boolean;
  triggeredAt: string | null;
  createdAt: string;
}

export interface AgentQuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestion {
  prompt: string;
  options: AgentQuestionOption[];
}

export interface BalanceUpdate {
  newBalance: number;
  reason: string;
}

export interface NewsSource {
  title: string;
  url: string;
  source: string;
  pubDate: number;
}

// Transient, this-turn-only — never persisted to agent_messages (see
// insertMessage below, which has no parameter for it). Live numbers tied
// to the moment of the reply, same reasoning as the edge function's own
// CoinSnapshot comment.
export interface CoinSnapshot {
  coin: string;
  price: number;
  rsi: number | null;
  macdHist: number | null;
  trend: "up" | "down" | "range" | null;
  fundingRatePct: number | null;
  openInterestUsd: number | null;
  recentCloses: number[];
}

// Matches AgentChartModal.tsx's own ChartInterval set.
export type ShowChartInterval = "1min" | "5min" | "15min" | "1h" | "4h" | "6h" | "1day" | "1week" | "1month";
export interface ShowChartRequest {
  coin: string;
  interval: ShowChartInterval;
}
export interface ShowOrderBookRequest {
  coin: string;
}
// A direct "take me there" button to a relevant in-app page/section (see
// NAV_SECTIONS in the edge function) — set instead of recommending an
// external platform for something this app already covers. Persisted
// (not transient like marketSnapshot) since the button needs to stay
// tappable after a reload, same as action/watch/question.
export interface NavigateToRequest {
  section: string;
  label: string;
}

export interface AgentMessage {
  id: number;
  conversationId: string;
  role: "user" | "agent";
  content: string;
  action: AgentAction | null;
  basket: AgentAction[] | null;
  question: AgentQuestion | null;
  balanceUpdate: BalanceUpdate | null;
  newsSources: NewsSource[] | null;
  actionStatus: "pending" | "confirmed" | "dismissed" | null;
  // The proposed watch (coin + condition) the agent wants to set up —
  // mirrors action/basket/balanceUpdate's pending/confirmed/dismissed
  // pattern (via actionStatus) rather than auto-creating the real
  // agent_watches row on arrival, so the user explicitly confirms the
  // condition (and its timeframe) before anything actually gets watched.
  watch: { coin: string; condition: string; interval: MarketInterval } | null;
  watchId: string | null;
  // The agent's full reasoning walkthrough (trend/RSI/MACD/volume/news) —
  // persisted so it's still there on reload, not just shown transiently
  // while streaming.
  thoughtProcess: string | null;
  navigateTo: NavigateToRequest | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  preview: string;
  messageCount: number;
  updatedAt: string;
}

const STARTING_CASH = 100000;

// Lazily creates the portfolio row on first use — same "bootstrap on
// first read" shape as fetchProfile in supabase.ts, just without the
// username-collision complexity (no unique constraint here besides the
// primary key, so a races-to-insert loser can simply re-select).
const PORTFOLIO_COLUMNS = "cash_balance, consent_accepted_at, typical_trade_usd, allow_leverage, focus_coins";
const POSITION_COLUMNS = "coin, market, side, qty, avg_entry_price, leverage, margin_usd, liquidation_price, take_profit_price, stop_loss_price";

function rowToPosition(p: {
  coin: string; market: "spot" | "futures"; side: "long" | "short"; qty: number; avg_entry_price: number;
  leverage: number; margin_usd: number; liquidation_price: number | null;
  take_profit_price: number | null; stop_loss_price: number | null;
}): PaperPosition {
  return {
    coin: p.coin, market: p.market, side: p.side, qty: p.qty, avgEntryPrice: p.avg_entry_price,
    leverage: p.leverage, marginUsd: p.margin_usd, liquidationPrice: p.liquidation_price,
    takeProfitPrice: p.take_profit_price, stopLossPrice: p.stop_loss_price,
  };
}

export async function fetchPortfolio(userId: string): Promise<PaperPortfolio> {
  let { data: portfolioRow } = await supabase
    .from("paper_portfolios")
    .select(PORTFOLIO_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (!portfolioRow) {
    const { data: created, error } = await supabase
      .from("paper_portfolios")
      .insert({ user_id: userId, cash_balance: STARTING_CASH })
      .select(PORTFOLIO_COLUMNS)
      .single();
    if (error) {
      // Lost a race with another concurrent bootstrap — re-select instead
      // of treating this as a real failure.
      const { data: existing } = await supabase
        .from("paper_portfolios")
        .select(PORTFOLIO_COLUMNS)
        .eq("user_id", userId)
        .single();
      portfolioRow = existing;
    } else {
      portfolioRow = created;
    }
  }

  const { data: positionRows } = await supabase
    .from("paper_positions")
    .select(POSITION_COLUMNS)
    .eq("user_id", userId);

  return {
    cashBalance: portfolioRow?.cash_balance ?? STARTING_CASH,
    positions: (positionRows ?? []).map(rowToPosition),
    consentAcceptedAt: portfolioRow?.consent_accepted_at ?? null,
    typicalTradeUsd: portfolioRow?.typical_trade_usd ?? null,
    allowLeverage: portfolioRow?.allow_leverage ?? false,
    focusCoins: portfolioRow?.focus_coins ?? [],
  };
}

// Records the one-time-per-account risk disclaimer acceptance only — the
// starting balance/trade size/leverage/focus-coin preferences used to be
// bundled into this same write (a required form step), but are now captured
// conversationally over time via updatePreferences below instead.
export async function acceptConsent(userId: string): Promise<void> {
  const { error } = await supabase
    .from("paper_portfolios")
    .update({ consent_accepted_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Partial update for whatever preference the agent extracted from a user's
// own words mid-conversation (e.g. "I've got about $500 to play with") —
// only the fields actually present are written, and consent_accepted_at is
// deliberately never touched here since stating a budget isn't the same as
// accepting the risk disclaimer.
export async function updatePreferences(userId: string, partial: PreferencesUpdate): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (partial.startingBalance !== undefined) patch.cash_balance = partial.startingBalance;
  if (partial.typicalTradeUsd !== undefined) patch.typical_trade_usd = partial.typicalTradeUsd;
  if (partial.allowLeverage !== undefined) patch.allow_leverage = partial.allowLeverage;
  if (partial.focusCoins !== undefined) patch.focus_coins = partial.focusCoins;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("paper_portfolios").update(patch).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

const MESSAGE_COLUMNS = "id, conversation_id, role, content, action, basket, question, balance_update, news_sources, action_status, watch, watch_id, thought_process, navigate_to, created_at";

function rowToMessage(m: {
  id: number; conversation_id: string; role: "user" | "agent"; content: string;
  action: AgentAction | null; basket: AgentAction[] | null; question: AgentQuestion | null;
  balance_update: BalanceUpdate | null;
  news_sources: NewsSource[] | null; action_status: AgentMessage["actionStatus"];
  watch: { coin: string; condition: string; interval: MarketInterval } | null; watch_id: string | null;
  thought_process: string | null; navigate_to: NavigateToRequest | null; created_at: string;
}): AgentMessage {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role,
    content: m.content,
    watch: m.watch,
    watchId: m.watch_id,
    action: m.action,
    basket: m.basket,
    question: m.question,
    balanceUpdate: m.balance_update,
    newsSources: m.news_sources,
    thoughtProcess: m.thought_process,
    navigateTo: m.navigate_to,
    actionStatus: m.action_status,
    createdAt: m.created_at,
  };
}

export async function fetchAgentMessages(userId: string, conversationId: string): Promise<AgentMessage[]> {
  const { data, error } = await supabase
    .from("agent_messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToMessage);
}

// Groups the user's full message history into conversations, newest first
// — client-side grouping (not a SQL GROUP BY) since this is a small side
// feature, not worth an RPC function for. Fine at the message volumes a
// single user's paper-trading chat actually reaches.
export async function fetchConversations(userId: string): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from("agent_messages")
    .select("conversation_id, role, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const byId = new Map<string, { preview: string; messageCount: number; updatedAt: string }>();
  for (const row of data ?? []) {
    const existing = byId.get(row.conversation_id);
    if (existing) {
      existing.messageCount++;
      existing.updatedAt = row.created_at;
    } else {
      byId.set(row.conversation_id, {
        preview: row.role === "user" ? row.content : row.content.slice(0, 80),
        messageCount: 1,
        updatedAt: row.created_at,
      });
    }
  }
  return Array.from(byId.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const { error } = await supabase
    .from("agent_messages")
    .delete()
    .eq("user_id", userId)
    .eq("conversation_id", conversationId);
  if (error) throw new Error(error.message);
}

async function insertMessage(
  userId: string, conversationId: string, role: "user" | "agent", content: string,
  action: AgentAction | null, watchId: string | null = null,
  basket: AgentAction[] | null = null, question: AgentQuestion | null = null,
  newsSources: NewsSource[] | null = null, balanceUpdate: BalanceUpdate | null = null,
  thoughtProcess: string | null = null, watch: { coin: string; condition: string; interval: MarketInterval } | null = null,
  navigateTo: NavigateToRequest | null = null
): Promise<AgentMessage> {
  const { data, error } = await supabase
    .from("agent_messages")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      role,
      content,
      action,
      basket,
      question,
      balance_update: balanceUpdate,
      news_sources: newsSources,
      action_status: action || basket || balanceUpdate || watch ? "pending" : null,
      watch,
      watch_id: watchId,
      thought_process: thoughtProcess,
      navigate_to: navigateTo,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return rowToMessage(data);
}

/** Called when the user taps Confirm on a proposed watch — this is the
 *  moment the real agent_watches row (and its re-checking by
 *  agent-watch-scan) actually begins; before this, the condition is just
 *  text sitting in the message, never evaluated. */
export async function confirmWatch(
  messageId: number, userId: string, conversationId: string, watch: { coin: string; condition: string; interval: MarketInterval }
): Promise<void> {
  const { data: watchRow, error: watchErr } = await supabase
    .from("agent_watches")
    .insert({ user_id: userId, conversation_id: conversationId, coin: watch.coin, condition_text: watch.condition, interval: watch.interval })
    .select("id")
    .single();
  if (watchErr) throw new Error(watchErr.message);
  const { error } = await supabase
    .from("agent_messages")
    .update({ action_status: "confirmed", watch_id: watchRow.id })
    .eq("id", messageId);
  if (error) throw new Error(error.message);
}

export interface HistoryTurn {
  role: "user" | "agent";
  content: string;
}

// A plain note from the agent with no action/watch attached — used right
// after onboarding to confirm what was agreed/answered, which also means
// the conversation is no longer empty (the gate's own "show for a brand
// new, zero-message conversation" check clears itself as a side effect).
export async function addAgentNote(userId: string, conversationId: string, content: string): Promise<AgentMessage> {
  return insertMessage(userId, conversationId, "agent", content, null);
}

// Calls the edge function, persists BOTH the user's message and the
// agent's reply (so the thread reads coherently on reload — the edge
// function itself only computes the reply, it doesn't touch
// agent_messages), and returns the agent's message row (the one the UI
// needs to render a proposal card for, if any). `history` is the current
// conversation's prior turns — without it the edge function only ever
// sees one message in isolation, so a follow-up like "notify me when
// ready" has no idea what coin the previous turn was even about.
// The edge function streams plain lines, each prefixed "N:" (a chunk of
// the agent's actual live reasoning — real text generated from the real
// market data it fetched, not canned copy), "J:" (the final structured
// response, exactly once), or "E:" (an error in place of "J:"). `onThinking`
// is called with the accumulated narration text as it arrives, so the UI
// can show genuine in-progress reasoning instead of a simulated indicator.
export async function sendAgentMessage(
  userId: string, conversationId: string, content: string, history: HistoryTurn[], selectedCoin?: string | null,
  onThinking?: (text: string) => void, viaVoice?: boolean, onMarketSnapshot?: (snapshot: CoinSnapshot[] | null) => void,
  onShowChart?: (req: ShowChartRequest) => void, onShowOrderBook?: (req: ShowOrderBookRequest) => void,
  signal?: AbortSignal, onPreferencesUpdate?: (update: PreferencesUpdate) => void
): Promise<AgentMessage> {
  await insertMessage(userId, conversationId, "user", content, null);

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(AGENT_REPLY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ message: content, history, selectedCoin, viaVoice }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Agent didn't respond (${res.status}) — please try again`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let narration = "";
  const allLines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("N:")) {
        narration += line.slice(2);
        onThinking?.(narration);
      } else {
        allLines.push(line);
      }
    }
  }
  if (buffer) allLines.push(buffer);

  const errorLine = allLines.find((l) => l.startsWith("E:"));
  if (errorLine) throw new Error(errorLine.slice(2));
  const jsonLine = allLines.find((l) => l.startsWith("J:"));
  if (!jsonLine) throw new Error("Agent didn't respond — please try again");

  let parsedResult: {
    reply: string; action: AgentAction | null; basket: AgentAction[] | null;
    watch: { coin: string; condition: string; interval: MarketInterval } | null; question: AgentQuestion | null;
    balanceUpdate: BalanceUpdate | null; newsSources: NewsSource[] | null;
    marketSnapshot: CoinSnapshot[] | null;
    showChart: ShowChartRequest | null; showOrderBook: ShowOrderBookRequest | null;
    thoughtProcess: string | null;
    preferencesUpdate: PreferencesUpdate | null;
    navigateTo: NavigateToRequest | null;
  };
  try {
    parsedResult = JSON.parse(jsonLine.slice(2));
  } catch {
    throw new Error("The agent's response was cut off — please try again.");
  }
  const { reply, action, basket, watch, question, balanceUpdate, newsSources, marketSnapshot, showChart, showOrderBook, thoughtProcess, preferencesUpdate, navigateTo } = parsedResult;
  onMarketSnapshot?.(marketSnapshot ?? null);
  if (showChart) onShowChart?.(showChart);
  if (showOrderBook) onShowOrderBook?.(showOrderBook);
  if (preferencesUpdate) onPreferencesUpdate?.(preferencesUpdate);

  // Proposed, not created yet — same pending/confirmed/dismissed gate as
  // action/basket/balanceUpdate (see confirmWatch above). The user confirms
  // the exact condition (and its timeframe) before anything real starts
  // being watched, instead of this silently happening the moment a reply
  // streams in.
  return insertMessage(userId, conversationId, "agent", reply, action, null, basket, question, newsSources, balanceUpdate, thoughtProcess, watch, navigateTo ?? null);
}

// Synthesizes `text` via OpenAI's neural TTS (agent-speech edge function)
// and returns a playable object URL — genuinely natural-sounding, unlike
// the device's own on-device synthesizer (see TradingAgent.tsx's voice
// mode). Caller is responsible for revoking the URL (URL.revokeObjectURL)
// once playback finishes, same as any other object URL.
export async function synthesizeAgentSpeech(text: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(AGENT_SPEECH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Speech synthesis failed (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function cancelWatch(watchId: string): Promise<void> {
  const { error } = await supabase.from("agent_watches").update({ active: false }).eq("id", watchId);
  if (error) throw new Error(error.message);
}

// Bulk fetch for rendering watch chips inline in the message feed — one
// query per conversation load rather than one per chip.
export async function fetchWatchesForConversation(userId: string, conversationId: string): Promise<AgentWatch[]> {
  const { data, error } = await supabase
    .from("agent_watches")
    .select("id, coin, condition_text, interval, active, triggered_at, created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((w) => ({
    id: w.id, coin: w.coin, conditionText: w.condition_text, interval: w.interval,
    active: w.active, triggeredAt: w.triggered_at, createdAt: w.created_at,
  }));
}

// Every watch the user has across every conversation, not scoped to one —
// backs the dedicated watchlist view, since a watch set up in an older
// chat is just as real/active as one from the current conversation and
// shouldn't require digging back through chat history to find or cancel.
// Active ones first (most actionable), then most-recently-triggered.
export async function fetchAllWatches(userId: string): Promise<AgentWatch[]> {
  const { data, error } = await supabase
    .from("agent_watches")
    .select("id, coin, condition_text, interval, active, triggered_at, created_at")
    .eq("user_id", userId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map((w) => ({
    id: w.id, coin: w.coin, conditionText: w.condition_text, interval: w.interval,
    active: w.active, triggeredAt: w.triggered_at, createdAt: w.created_at,
  }));
}

export async function fetchWatch(watchId: string): Promise<AgentWatch | null> {
  const { data, error } = await supabase
    .from("agent_watches")
    .select("id, coin, condition_text, interval, active, triggered_at, created_at")
    .eq("id", watchId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id, coin: data.coin, conditionText: data.condition_text, interval: data.interval,
    active: data.active, triggeredAt: data.triggered_at, createdAt: data.created_at,
  };
}

export async function setActionStatus(
  messageId: number, status: "confirmed" | "dismissed"
): Promise<void> {
  const { error } = await supabase
    .from("agent_messages")
    .update({ action_status: status })
    .eq("id", messageId);
  if (error) throw new Error(error.message);
}

export class InsufficientFundsError extends Error {}
export class InsufficientPositionError extends Error {}

async function upsertPosition(
  userId: string, coin: string, market: "spot" | "futures", side: "long" | "short",
  qty: number, avgEntryPrice: number, leverage: number, marginUsd: number,
  liquidationPrice: number | null, takeProfitPrice: number | null, stopLossPrice: number | null
): Promise<void> {
  const { error } = await supabase.from("paper_positions").upsert(
    {
      user_id: userId, coin, market, side, qty, avg_entry_price: avgEntryPrice, leverage,
      margin_usd: marginUsd, liquidation_price: liquidationPrice,
      take_profit_price: takeProfitPrice, stop_loss_price: stopLossPrice,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,coin,market" }
  );
  if (error) throw new Error(error.message);
}

async function deletePosition(userId: string, coin: string, market: "spot" | "futures"): Promise<void> {
  const { error } = await supabase.from("paper_positions").delete()
    .eq("user_id", userId).eq("coin", coin).eq("market", market);
  if (error) throw new Error(error.message);
}

async function setCashBalance(userId: string, newBalance: number): Promise<void> {
  const { error } = await supabase.from("paper_portfolios")
    .update({ cash_balance: newBalance, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// User-initiated manual override — e.g. editing the cash figure directly in
// the portfolio header, not something a trade computed. Same underlying
// write as a trade settling, just exposed directly.
export async function updateCashBalance(userId: string, newBalance: number): Promise<void> {
  if (!Number.isFinite(newBalance) || newBalance < 0) {
    throw new Error("Cash balance must be a non-negative number.");
  }
  await setCashBalance(userId, newBalance);
}

async function logTrade(
  userId: string, action: AgentAction, qty: number, price: number, positionSide: "long" | "short",
  leverage: number | null, marginUsd: number | null, liquidationPrice: number | null,
  realizedPnl: number | null = null
): Promise<void> {
  const { error } = await supabase.from("paper_trades").insert({
    user_id: userId, coin: action.coin, side: action.side, qty, price, reason: action.reason,
    market: action.market, position_side: positionSide, leverage, margin_usd: marginUsd,
    liquidation_price: liquidationPrice, take_profit_price: action.takeProfit, stop_loss_price: action.stopLoss,
    close_reason: "manual", realized_pnl: realizedPnl,
  });
  if (error) throw new Error(error.message);
}

// Simplified isolated-margin liquidation price — ignores fees/funding/the
// maintenance-margin buffer a real exchange reserves, so it's directionally
// correct (closer to entry at higher leverage) rather than exchange-exact.
// Fine for a paper simulation; not fine to present as precise.
function computeLiquidationPrice(entryPrice: number, leverage: number, side: "long" | "short"): number {
  return side === "long" ? entryPrice * (1 - 1 / leverage) : entryPrice * (1 + 1 / leverage);
}

// Executes a simulated trade — either a plain spot buy/sell (own the
// asset, no leverage) or a leveraged futures long/short (margin posted,
// blended leverage, a computed liquidation price). Spot and futures
// positions in the same coin are independent rows (different `market`),
// so holding both at once is normal. Read-modify-write in one client call,
// same shape as toggleMutedSignalCoin/toggleWatchlistSignalCoin in
// supabase.ts, just against richer position state than a toggled array.
export async function executeTrade(userId: string, action: AgentAction): Promise<void> {
  const price = await fetchLivePrice(action.coin);
  if (!price) throw new Error(`No live price available for ${action.coin}`);

  const portfolio = await fetchPortfolio(userId);
  const existing = portfolio.positions.find((p) => p.coin === action.coin && p.market === action.market) ?? null;

  if (action.market === "spot") {
    const qty = action.amountUsd / price;
    let spotRealizedPnl: number | null = null;
    if (action.side === "buy") {
      if (action.amountUsd > portfolio.cashBalance) {
        throw new InsufficientFundsError(
          `Not enough paper cash — $${action.amountUsd.toLocaleString()} requested, $${portfolio.cashBalance.toLocaleString()} available.`
        );
      }
      const newQty = (existing?.qty ?? 0) + qty;
      const newAvgEntry = existing ? (existing.qty * existing.avgEntryPrice + qty * price) / newQty : price;
      await upsertPosition(userId, action.coin, "spot", "long", newQty, newAvgEntry, 1, newQty * newAvgEntry, null, action.takeProfit, action.stopLoss);
      await setCashBalance(userId, portfolio.cashBalance - action.amountUsd);
    } else {
      if (!existing || qty > existing.qty + 1e-9) {
        throw new InsufficientPositionError(
          `You don't hold enough ${action.coin} to sell that much (holding ${existing?.qty ?? 0}).`
        );
      }
      const remainingQty = existing.qty - qty;
      if (remainingQty <= 1e-9) {
        await deletePosition(userId, action.coin, "spot");
      } else {
        await upsertPosition(userId, action.coin, "spot", "long", remainingQty, existing.avgEntryPrice, 1, remainingQty * existing.avgEntryPrice, null, existing.takeProfitPrice, existing.stopLossPrice);
      }
      await setCashBalance(userId, portfolio.cashBalance + action.amountUsd);
      spotRealizedPnl = (price - existing.avgEntryPrice) * qty;
    }
    await logTrade(userId, action, qty, price, "long", 1, null, null, spotRealizedPnl);
    return;
  }

  // Futures, one-way mode: "buy" wants long exposure, "sell" wants short.
  // Opening/adding applies when there's no position or it already matches
  // that direction; otherwise this reduces, closes, or closes-and-flips an
  // opposite-side position — same behavior a real exchange's one-way mode
  // gives you for a market order against an open position.
  const leverage = Math.min(20, Math.max(1, action.leverage || 1));
  const wantSide: "long" | "short" = action.side === "buy" ? "long" : "short";
  const requestedQty = (action.amountUsd * leverage) / price;

  if (!existing || existing.side === wantSide) {
    if (action.amountUsd > portfolio.cashBalance) {
      throw new InsufficientFundsError(
        `Not enough paper cash for that margin — $${action.amountUsd.toLocaleString()} requested, $${portfolio.cashBalance.toLocaleString()} available.`
      );
    }
    const newQty = (existing?.qty ?? 0) + requestedQty;
    const newMargin = (existing?.marginUsd ?? 0) + action.amountUsd;
    const newAvgEntry = existing ? (existing.qty * existing.avgEntryPrice + requestedQty * price) / newQty : price;
    const blendedLeverage = newMargin > 0 ? (newQty * newAvgEntry) / newMargin : leverage;
    const liq = computeLiquidationPrice(newAvgEntry, blendedLeverage, wantSide);
    await upsertPosition(userId, action.coin, "futures", wantSide, newQty, newAvgEntry, blendedLeverage, newMargin, liq, action.takeProfit, action.stopLoss);
    await setCashBalance(userId, portfolio.cashBalance - action.amountUsd);
    await logTrade(userId, action, requestedQty, price, wantSide, blendedLeverage, newMargin, liq);
    return;
  }

  // Opposite side held — reduce, fully close, or close-and-flip.
  const closedQty = Math.min(requestedQty, existing.qty);
  const pnl = existing.side === "long"
    ? (price - existing.avgEntryPrice) * closedQty
    : (existing.avgEntryPrice - price) * closedQty;
  const remainderQty = requestedQty - existing.qty;

  let remainderMargin = 0;
  if (remainderQty > 1e-9) {
    remainderMargin = (remainderQty * price) / leverage;
    const cashAfterClose = portfolio.cashBalance + existing.marginUsd + pnl;
    if (remainderMargin > cashAfterClose) {
      throw new InsufficientFundsError(
        `Not enough paper cash to flip into a ${wantSide} after closing — $${remainderMargin.toLocaleString()} margin needed, $${cashAfterClose.toLocaleString()} available.`
      );
    }
  }

  if (remainderQty > 1e-9) {
    const liq = computeLiquidationPrice(price, leverage, wantSide);
    await upsertPosition(userId, action.coin, "futures", wantSide, remainderQty, price, leverage, remainderMargin, liq, action.takeProfit, action.stopLoss);
    await setCashBalance(userId, portfolio.cashBalance + existing.marginUsd + pnl - remainderMargin);
  } else if (closedQty < existing.qty - 1e-9) {
    const closedFraction = closedQty / existing.qty;
    const releasedMargin = existing.marginUsd * closedFraction;
    await upsertPosition(
      userId, action.coin, "futures", existing.side, existing.qty - closedQty, existing.avgEntryPrice,
      existing.leverage, existing.marginUsd - releasedMargin, existing.liquidationPrice,
      action.takeProfit ?? existing.takeProfitPrice, action.stopLoss ?? existing.stopLossPrice
    );
    await setCashBalance(userId, portfolio.cashBalance + releasedMargin + pnl);
  } else {
    await deletePosition(userId, action.coin, "futures");
    await setCashBalance(userId, portfolio.cashBalance + existing.marginUsd + pnl);
  }
  await logTrade(userId, action, closedQty, price, existing.side, existing.leverage, existing.marginUsd, existing.liquidationPrice, pnl);
}

// Executes each leg of a basket proposal sequentially (not in parallel) —
// every leg reads-modifies-writes the same cash_balance row, so running
// them concurrently would race and lose updates. If one leg fails (e.g.
// insufficient funds partway through), the legs before it have already
// executed; the caller surfaces the error and a reload shows exactly which
// positions actually opened.
export async function executeBasket(userId: string, basket: AgentAction[]): Promise<void> {
  for (const leg of basket) {
    await executeTrade(userId, leg);
  }
}

export interface AgentPerformance {
  wins: number;
  losses: number;
  totalClosed: number;
  winRate: number | null;
  totalPnl: number;
}

// Real win/loss record from actual closed trades (realized_pnl is only ever
// set on a close — see logTrade/agent-watch-scan), not a vanity number —
// this is what backs the win-rate readout in the portfolio header.
export async function fetchAgentPerformance(userId: string): Promise<AgentPerformance> {
  const { data, error } = await supabase
    .from("paper_trades")
    .select("realized_pnl")
    .eq("user_id", userId)
    .not("realized_pnl", "is", null);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { realized_pnl: number }[];
  const wins = rows.filter((r) => r.realized_pnl > 0).length;
  const totalClosed = rows.length;
  return {
    wins,
    losses: totalClosed - wins,
    totalClosed,
    winRate: totalClosed > 0 ? wins / totalClosed : null,
    totalPnl: rows.reduce((sum, r) => sum + r.realized_pnl, 0),
  };
}

// Closes a position outright at the current live price, bypassing the
// agent-proposal schema entirely — this is the portfolio header's "Close"
// button, a direct user action rather than something the agent suggested.
// Unwinds the full qty in one shot: spot sells everything held, futures
// closes the whole position and realizes its P&L into cash.
export async function closePosition(userId: string, position: PaperPosition): Promise<void> {
  const price = await fetchLivePrice(position.coin);
  if (!price) throw new Error(`No live price available for ${position.coin}`);

  const portfolio = await fetchPortfolio(userId);
  const closeAction: AgentAction = {
    side: position.side === "long" ? "sell" : "buy",
    coin: position.coin, market: position.market, amountUsd: position.qty * price,
    leverage: position.leverage, takeProfit: null, stopLoss: null,
    reason: "Manually closed by user", price,
  };

  if (position.market === "spot") {
    const spotPnl = (price - position.avgEntryPrice) * position.qty;
    await deletePosition(userId, position.coin, "spot");
    await setCashBalance(userId, portfolio.cashBalance + position.qty * price);
    await logTrade(userId, closeAction, position.qty, price, "long", 1, null, null, spotPnl);
    return;
  }

  const pnl = position.side === "long"
    ? (price - position.avgEntryPrice) * position.qty
    : (position.avgEntryPrice - price) * position.qty;
  await deletePosition(userId, position.coin, "futures");
  await setCashBalance(userId, portfolio.cashBalance + position.marginUsd + pnl);
  await logTrade(userId, closeAction, position.qty, price, position.side, position.leverage, position.marginUsd, position.liquidationPrice, pnl);
}
