import axios from 'axios';
import { BTCData } from './coinglass';
import { FearGreedData } from './feargreed';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const API_KEY = import.meta.env.VITE_OPENAI_API_KEY;

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface TimeframeRange { low: number; high: number }

export interface PredictionResponse extends ChatResponse {
  confidence?: "high" | "medium" | "low";
  sentiment?: "bullish" | "bearish" | "neutral";
  priceDrivers?: string;
  whoIsBuying?: string;
  whoIsSelling?: string;
  marketContext?: string;
  keyRisks?: string;
  ourTake?: string;
  ourTakeAction?: "buy" | "sell" | "hold" | "watch";
  timeframes?: {
    "8h":  TimeframeRange;
    "12h": TimeframeRange;
    "16h": TimeframeRange;
    "24h": TimeframeRange;
  };
  supportLevels?: number[];
  resistanceLevels?: number[];
  scenarios?: ScenarioItem[];
}

export interface ScenarioItem {
  label: string;
  direction: "up" | "down" | "sideways";
  target: number;
  probability: string;
  trigger: string;
}

const axiosInstance = axios.create({
  baseURL: OPENAI_BASE_URL,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
});

export const openai = {
  // Send message to ChatGPT with context about BTC data (supports vision)
  chat: async (
    userMessage: string,
    btcData?: Partial<BTCData> | null,
    previousMessages: ChatMessage[] = [],
    images?: string[]   // base64 data URLs
  ): Promise<ChatResponse> => {
    try {
      if (!API_KEY) {
        return {
          success: false,
          message: '',
          error: 'OpenAI API key not configured. Please add VITE_OPENAI_API_KEY to .env',
        };
      }

      // Build system message with BTC context
      let systemMessage = 'You are a helpful AI assistant analyzing cryptocurrency market data and charts. When images are provided, perform detailed technical analysis on them. ';
      if (btcData) {
        systemMessage += `Current BTC Data: Price: $${btcData.price?.toFixed(2)}, `;
        systemMessage += `Liquidation Above: $${btcData.liquidationAbove?.toFixed(2)}, `;
        systemMessage += `Liquidation Below: $${btcData.liquidationBelow?.toFixed(2)}, `;
        systemMessage += `Open Interest: ${btcData.openInterest?.toFixed(2)}, `;
        systemMessage += `Funding Rate: ${btcData.fundingRate?.toFixed(4)}, `;
        systemMessage += `Long/Short Ratio: ${btcData.longShortRatio?.toFixed(2)}, `;
        systemMessage += `RSI: ${btcData.rsi?.toFixed(1)}, `;
        systemMessage += `MACD: ${btcData.macd?.toFixed(2)}`;
      }
      systemMessage += ' Provide analysis and predictions based on this data.';

      // Build user content — plain string or vision array when images are attached
      const userContent = images?.length
        ? [
            { type: 'text', text: userMessage || 'Please analyse this image.' },
            ...images.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } })),
          ]
        : userMessage;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [
        { role: 'system', content: systemMessage },
        ...previousMessages,
        { role: 'user', content: userContent },
      ];

      const response = await axiosInstance.post('/chat/completions', {
        model: 'gpt-4o',
        messages,
        temperature: 0.7,
        max_tokens: 1500,
      });

      const assistantMessage = response.data?.choices?.[0]?.message?.content || '';

      return {
        success: true,
        message: assistantMessage,
      };
    } catch (error: any) {
      console.error('Error calling OpenAI API:', error);
      const errorMessage =
        error.response?.data?.error?.message ||
        error.message ||
        'Failed to get response from ChatGPT';
      return {
        success: false,
        message: '',
        error: errorMessage,
      };
    }
  },

  // Get price prediction based on market data
  getPricePrediction: async (btcData: Partial<BTCData>, fearGreed?: FearGreedData): Promise<PredictionResponse> => {
    try {
      if (!API_KEY) {
        return { success: false, message: "", error: "OpenAI API key not configured. Please add VITE_OPENAI_API_KEY to .env" };
      }

      const liqMid = btcData.liquidationAbove != null && btcData.liquidationBelow != null
        ? ((btcData.liquidationAbove + btcData.liquidationBelow) / 2).toFixed(2)
        : null;

      const prompt = `You are a senior crypto market analyst with deep knowledge of on-chain data, derivatives, macro markets, and crypto news. Analyze the live market data below and provide a comprehensive market intelligence report.

Live market data:
- Current Price: $${btcData.price?.toFixed(2)}
- Liquidation Above: $${btcData.liquidationAbove?.toFixed(2)}
- Liquidation Below: $${btcData.liquidationBelow?.toFixed(2)}${liqMid ? `\n- Liquidation Midpoint: $${liqMid} (price is ${Number(btcData.price) >= Number(liqMid) ? "ABOVE — bullish lean" : "BELOW — bearish lean"})` : ""}
- Open Interest: $${btcData.openInterest ? (btcData.openInterest / 1e9).toFixed(2) + "B" : "N/A"}
- Funding Rate: ${btcData.fundingRate?.toFixed(4)} (${(btcData.fundingRate ?? 0) > 0 ? "positive — longs paying" : "negative — shorts paying"})
- Long/Short Ratio: ${btcData.longShortRatio?.toFixed(2)} (${(btcData.longShortRatio ?? 1) > 1 ? "more longs" : "more shorts"})
- RSI: ${btcData.rsi?.toFixed(1)} (${(btcData.rsi ?? 50) >= 70 ? "overbought" : (btcData.rsi ?? 50) <= 30 ? "oversold" : "neutral"})
- MACD: ${btcData.macd?.toFixed(4)} (${(btcData.macd ?? 0) > 0 ? "bullish" : "bearish"})
- MACD Signal: ${btcData.macdSignal?.toFixed(4) ?? "N/A"}${fearGreed ? `
- Fear & Greed Index (now): ${fearGreed.current.value} — ${fearGreed.current.classification}
- Fear & Greed (yesterday): ${fearGreed.yesterday.value} — ${fearGreed.yesterday.classification}
- Fear & Greed (last week): ${fearGreed.lastWeek.value} — ${fearGreed.lastWeek.classification}` : ""}

Use your knowledge of current crypto market conditions (as of your training cutoff) to enrich the analysis with likely macro context, news events, and participant behavior patterns consistent with these signals.

Respond ONLY with valid JSON (no markdown):
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "confidence": "high" | "medium" | "low",
  "analysis": "<2-3 sentence overall market thesis>",
  "priceDrivers": "<1-2 sentences on the primary forces pushing price up or down right now — e.g. ETF flows, macro data, whale accumulation, protocol news>",
  "whoIsBuying": "<1-2 sentences identifying likely buyers — e.g. institutional accumulators, retail FOMO, spot ETF inflows, DCA bots>",
  "whoIsSelling": "<1-2 sentences identifying likely sellers — e.g. miners, early holders taking profit, leveraged longs being liquidated, bearish institutions>",
  "marketContext": "<1-2 sentences on macro & cross-market correlations — e.g. DXY strength, S&P500 risk-on/off, gold, Fed policy, relevant crypto-specific news>",
  "keyRisks": "<1-2 sentences on the biggest risks that could invalidate this thesis>",
  "ourTake": "<2-3 sentences of direct, opinionated editorial — speak in first person plural ('We think...', 'In our view...'), be specific about price levels, what to watch, and what action makes sense right now>",
  "ourTakeAction": "buy" | "sell" | "hold" | "watch",
  "8h":  { "low": <number>, "high": <number> },
  "12h": { "low": <number>, "high": <number> },
  "16h": { "low": <number>, "high": <number> },
  "24h": { "low": <number>, "high": <number> },
  "supportLevels": [<number>, <number>],
  "resistanceLevels": [<number>, <number>],
  "scenarios": [
    { "label": "Bull Case",  "direction": "up",       "target": <number>, "probability": "<N>%", "trigger": "<brief trigger>" },
    { "label": "Base Case",  "direction": "sideways",  "target": <number>, "probability": "<N>%", "trigger": "<brief trigger>" },
    { "label": "Bear Case",  "direction": "down",      "target": <number>, "probability": "<N>%", "trigger": "<brief trigger>" }
  ]
}`;

      const response = await axiosInstance.post('/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.5,
        max_tokens: 900,
      });

      const raw = response.data?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);

      const isRange = (v: unknown): v is TimeframeRange =>
        typeof (v as TimeframeRange)?.low === "number" && typeof (v as TimeframeRange)?.high === "number";

      return {
        success: true,
        message: parsed.analysis || "",
        confidence: parsed.confidence,
        sentiment: parsed.sentiment,
        priceDrivers: parsed.priceDrivers,
        whoIsBuying: parsed.whoIsBuying,
        whoIsSelling: parsed.whoIsSelling,
        marketContext: parsed.marketContext,
        keyRisks: parsed.keyRisks,
        ourTake: parsed.ourTake,
        ourTakeAction: parsed.ourTakeAction,
        timeframes: (isRange(parsed["8h"]) && isRange(parsed["12h"]) && isRange(parsed["16h"]) && isRange(parsed["24h"]))
          ? { "8h": parsed["8h"], "12h": parsed["12h"], "16h": parsed["16h"], "24h": parsed["24h"] }
          : undefined,
        supportLevels: Array.isArray(parsed.supportLevels) ? parsed.supportLevels.filter((n: unknown) => typeof n === "number") : undefined,
        resistanceLevels: Array.isArray(parsed.resistanceLevels) ? parsed.resistanceLevels.filter((n: unknown) => typeof n === "number") : undefined,
        scenarios: Array.isArray(parsed.scenarios)
          ? parsed.scenarios.filter((s: any) => s?.label && s?.direction && typeof s?.target === "number")
          : undefined,
      };
    } catch (error: any) {
      console.error('Error calling OpenAI API:', error);
      return {
        success: false,
        message: "",
        error: error.response?.data?.error?.message || error.message || "Failed to get prediction",
      };
    }
  },
};

export interface OnChainSignal {
  metric: string;
  value: string;
  interpretation: string;
  bullish: boolean;
}

export interface OnChainAIResult {
  networkHealth: "strong" | "moderate" | "weak";
  summary: string;
  signals: OnChainSignal[];
  outlook: string;
  action: "accumulate" | "hold" | "caution";
}

export async function getOnChainAIAnalysis(data: {
  hashrateGHs: number;
  transactions: number;
  minerRevenueUSD: number;
  difficulty: number;
  btcMinedToday: number;
  transferVolumeUSD: number;
  marketCapUSD: number;
}): Promise<OnChainAIResult | null> {
  try {
    const API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
    if (!API_KEY) return null;

    const ehs = (data.hashrateGHs / 1e9).toFixed(1);
    const prompt = `You are a Bitcoin on-chain analyst. Analyze these live Bitcoin network metrics and provide a structured assessment.

Live Bitcoin On-Chain Data:
- Hash Rate: ${ehs} EH/s
- Daily Transactions: ${data.transactions.toLocaleString()}
- Miner Revenue (USD): $${(data.minerRevenueUSD / 1e6).toFixed(2)}M
- Mining Difficulty: ${(data.difficulty / 1e12).toFixed(2)}T
- BTC Mined Today: ${data.btcMinedToday.toFixed(2)} BTC
- Transfer Volume (USD): $${(data.transferVolumeUSD / 1e9).toFixed(2)}B
- Market Cap: $${(data.marketCapUSD / 1e9).toFixed(1)}B

Respond ONLY with valid JSON (no markdown):
{
  "networkHealth": "strong" | "moderate" | "weak",
  "summary": "<2-3 sentences interpreting what these metrics collectively tell us about Bitcoin's network health and price implications>",
  "signals": [
    { "metric": "Hash Rate", "value": "${ehs} EH/s", "interpretation": "<1 sentence: what this level signals>", "bullish": true|false },
    { "metric": "Daily Transactions", "value": "${data.transactions.toLocaleString()}", "interpretation": "<1 sentence>", "bullish": true|false },
    { "metric": "Miner Revenue", "value": "$${(data.minerRevenueUSD / 1e6).toFixed(1)}M", "interpretation": "<1 sentence>", "bullish": true|false },
    { "metric": "Transfer Volume", "value": "$${(data.transferVolumeUSD / 1e9).toFixed(2)}B", "interpretation": "<1 sentence>", "bullish": true|false }
  ],
  "outlook": "<2 sentences: forward-looking view — what these metrics imply for price over the next 1-4 weeks>",
  "action": "accumulate" | "hold" | "caution"
}`;

    const res = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 600,
    });

    const parsed = JSON.parse(res.data?.choices?.[0]?.message?.content || "{}");
    if (!parsed.summary) return null;
    return parsed as OnChainAIResult;
  } catch {
    return null;
  }
}

// ── Coinbase Premium AI ───────────────────────────────────────────────────────

export interface PremiumAIResult {
  sentiment: "bullish" | "neutral" | "bearish";
  summary: string;
  signals: Array<{ label: string; value: string; interpretation: string; bullish: boolean }>;
  outlook: string;
}

export async function getPremiumAIAnalysis(data: {
  current: number;
  avg7d: number;
  high7d: number;
  low7d: number;
  trend: "rising" | "falling" | "flat";
  refSource: string;
  btcPrice: number;
}): Promise<PremiumAIResult | null> {
  try {
    const API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
    if (!API_KEY) return null;

    const prompt = `You are a crypto market analyst specialising in exchange premium indicators. Analyse the Coinbase Premium Index data below and provide a structured interpretation.

Coinbase Premium Index (BTC/USD Coinbase vs BTC/USDT ${data.refSource}):
- Current Premium: ${data.current >= 0 ? "+" : ""}${data.current.toFixed(4)}%
- 7-Day Average: ${data.avg7d >= 0 ? "+" : ""}${data.avg7d.toFixed(4)}%
- 7-Day High: +${data.high7d.toFixed(4)}%
- 7-Day Low: ${data.low7d.toFixed(4)}%
- Recent Trend: ${data.trend}
- BTC Price: $${data.btcPrice.toLocaleString()}

Respond ONLY with valid JSON (no markdown):
{
  "sentiment": "bullish" | "neutral" | "bearish",
  "summary": "<2-3 sentences: what this premium level and trend means for US market sentiment and near-term BTC price pressure>",
  "signals": [
    { "label": "Current Premium", "value": "${data.current >= 0 ? "+" : ""}${data.current.toFixed(4)}%", "interpretation": "<1 sentence: what this specific value signals>", "bullish": true|false },
    { "label": "7-Day Average", "value": "${data.avg7d >= 0 ? "+" : ""}${data.avg7d.toFixed(4)}%", "interpretation": "<1 sentence: trend context vs current>", "bullish": true|false },
    { "label": "Premium Range", "value": "${data.low7d.toFixed(3)}% to +${data.high7d.toFixed(3)}%", "interpretation": "<1 sentence: what the range volatility implies>", "bullish": true|false },
    { "label": "Trend Direction", "value": "${data.trend}", "interpretation": "<1 sentence: significance of this trend direction>", "bullish": ${data.trend === "rising"} }
  ],
  "outlook": "<2 sentences: what traders should watch for given this premium reading — potential price implications if premium expands or contracts>"
}`;

    const res = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 550,
    });

    const parsed = JSON.parse(res.data?.choices?.[0]?.message?.content || "{}");
    if (!parsed.summary) return null;
    return parsed as PremiumAIResult;
  } catch { return null; }
}

export interface GannAnalysisInput {
  coin: string;
  currentPrice: number;
  swingHigh: { price: number; date: string; daysAgo: number; unit: number };
  swingLow:  { price: number; date: string; daysAgo: number; unit: number };
  sq9Above: { deg: number; price: number }[];
  sq9Below: { deg: number; price: number }[];
  anglesFromHigh: { label: string; deg: string; priceLevel: number }[];
  anglesFromLow:  { label: string; deg: string; priceLevel: number }[];
  upcomingCycles: { date: string; cycle: string; tag: string; from: string; daysAway: number }[];
}

export interface GannAIResult {
  sentiment: "bullish" | "bearish" | "neutral";
  confidence: "high" | "medium" | "low";
  analysis: string;
  keyLevels: { price: number; label: string; type: "support" | "resistance" }[];
  priceTarget: { low: number; high: number; timeframe: string };
  nextCycleAlert: string;
  actionableInsight: string;
}

export const getGannAnalysis = async (data: GannAnalysisInput): Promise<{ success: boolean; result?: GannAIResult; error?: string }> => {
  if (!API_KEY) return { success: false, error: "OpenAI API key not configured." };

  const prompt = `You are an expert W.D. Gann analyst with deep knowledge of Gann Square of 9, Gann angles, and time cycles. Analyze the following Gann data for ${data.coin} and provide a structured prediction.

CURRENT PRICE: $${data.currentPrice.toLocaleString()}

SWING HIGH: $${data.swingHigh.price.toLocaleString()} on ${data.swingHigh.date} (${data.swingHigh.daysAgo} days ago, natural unit: ${data.swingHigh.unit})
SWING LOW:  $${data.swingLow.price.toLocaleString()} on ${data.swingLow.date} (${data.swingLow.daysAgo} days ago, natural unit: ${data.swingLow.unit})

SQUARE OF 9 — RESISTANCE LEVELS ABOVE:
${data.sq9Above.map(l => `  ${l.deg}°: $${l.price.toLocaleString()}`).join("\n")}

SQUARE OF 9 — SUPPORT LEVELS BELOW:
${data.sq9Below.map(l => `  ${l.deg}°: $${l.price.toLocaleString()}`).join("\n")}

GANN ANGLES FROM HIGH (bearish fan):
${data.anglesFromHigh.map(a => `  ${a.label} (${a.deg}): $${Math.round(a.priceLevel).toLocaleString()}`).join("\n")}

GANN ANGLES FROM LOW (bullish fan):
${data.anglesFromLow.map(a => `  ${a.label} (${a.deg}): $${Math.round(a.priceLevel).toLocaleString()}`).join("\n")}

UPCOMING TIME CYCLES (next 90 days):
${data.upcomingCycles.slice(0, 8).map(c => `  ${c.date}: ${c.cycle} ${c.tag} from ${c.from} (in ${c.daysAway}d)`).join("\n")}

Based strictly on Gann methodology, respond ONLY with valid JSON — no markdown, no code fences. All numeric values must be plain integers or decimals with NO comma separators (e.g. 80000, not 80,000). Use exactly this shape:
{
  "sentiment": "bullish",
  "confidence": "high",
  "analysis": "3 sentences here.",
  "keyLevels": [
    { "price": 81000, "label": "1x1 from Low", "type": "support" },
    { "price": 85500, "label": "Sq9 360deg", "type": "resistance" }
  ],
  "priceTarget": { "low": 78000, "high": 88000, "timeframe": "next 30 days" },
  "nextCycleAlert": "One sentence here.",
  "actionableInsight": "One sentence here."
}`;

  try {
    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 600,
    });
    const raw = response.data?.choices?.[0]?.message?.content || "{}";
    // Strip markdown fences and sanitize comma-formatted numbers inside JSON
    const cleaned = raw
      .replace(/```json\s*/gi, "").replace(/```\s*/g, "")
      .replace(/:\s*(\d{1,3})(,\d{3})+(?=[,\}\]\s])/g, (_: string, first: string, rest: string) =>
        ": " + (first + rest).replace(/,/g, ""));
    const parsed = JSON.parse(cleaned) as GannAIResult;
    return { success: true, result: parsed };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.error?.message || err.message || "Failed to get Gann AI analysis" };
  }
};

// ── Candle Pattern AI Analysis ─────────────────────────────────────────────

export interface CandlePatternResult {
  name: string;
  type: "bullish" | "bearish" | "neutral";
  summary: string;
  narrative: string;
  nextMove: string;
}

export async function getCandlePatternAnalysis(
  coin: string,
  interval: string,
  candles: { open: number; high: number; low: number; close: number; time: number }[]
): Promise<{ success: boolean; result?: CandlePatternResult; error?: string }> {
  try {
    if (!API_KEY) return { success: false, error: "No API key" };

    const recent = candles.slice(-10).map(c => ({
      o: c.open.toFixed(2), h: c.high.toFixed(2),
      l: c.low.toFixed(2),  cl: c.close.toFixed(2),
    }));

    const prompt = `You are an expert crypto technical analyst. Analyze the last ${recent.length} ${interval} candles for ${coin} and identify the most significant candlestick pattern or price structure.

Candles (oldest→newest): ${JSON.stringify(recent)}

Focus on the most recent 1-3 candles. Respond ONLY with valid JSON:
{
  "name": "pattern name (e.g. Bullish Engulfing, Doji, Inside Bar, etc.)",
  "type": "bullish" | "bearish" | "neutral",
  "summary": "one sentence: what the pattern shows (max 120 chars)",
  "narrative": "2-3 sentences: market maker / institutional interpretation of what happened and why",
  "nextMove": "2-3 sentences: what price is likely to do next and key levels to watch"
}`;

    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: "json_object" },
    });

    const raw = response.data?.choices?.[0]?.message?.content ?? "";
    const result = JSON.parse(raw) as CandlePatternResult;
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to get pattern analysis" };
  }
}

export interface LiqAnalysisInput {
  coin: string;
  range: string;
  currentPrice: number;
  dominantSide: "long" | "short" | "balanced";
  longClusters: { priceCenter: number; strength: number; label: string; distancePct: number }[];
  shortClusters: { priceCenter: number; strength: number; label: string; distancePct: number }[];
}

export interface LiqAIResponse {
  success: boolean;
  sentiment?: "bullish" | "bearish" | "neutral";
  analysis?: string;
  ourTake?: string;
  ourTakeAction?: "buy" | "sell" | "hold" | "watch";
  error?: string;
}

async function getLiquidationAnalysis(input: LiqAnalysisInput): Promise<LiqAIResponse> {
  try {
    const fmtPrice = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const fmtClusters = (clusters: LiqAnalysisInput["longClusters"], side: string) =>
      clusters.length === 0
        ? `  No significant ${side} clusters`
        : clusters.map((c, i) =>
            `  ${i + 1}. $${fmtPrice(c.priceCenter)} (${c.label}, strength ${Math.round(c.strength * 100)}%, ${c.distancePct > 0 ? "+" : ""}${c.distancePct.toFixed(1)}% from price)`
          ).join("\n");

    const prompt = `You are a professional crypto derivatives analyst. Analyze the following liquidation heatmap data for ${input.coin} and provide a concise market insight.

Current Price: $${fmtPrice(input.currentPrice)}
Time Range: ${input.range}
Dominant Liquidation Side: ${input.dominantSide}

Long Liquidation Clusters (below price — longs get liquidated here):
${fmtClusters(input.longClusters, "long")}

Short Liquidation Clusters (above price — shorts get liquidated here):
${fmtClusters(input.shortClusters, "short")}

Based on this data, respond ONLY with valid JSON:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "analysis": "2-3 sentence explanation of what the liquidation map tells us about current market dynamics and where price may be drawn",
  "ourTake": "1-2 sentences: actionable insight — what a trader should watch for given these liquidation levels",
  "ourTakeAction": "buy" | "sell" | "hold" | "watch"
}`;

    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 350,
      response_format: { type: "json_object" },
    });

    const raw = response.data?.choices?.[0]?.message?.content ?? "";
    const result = JSON.parse(raw);
    return { success: true, ...result };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to get liquidation analysis" };
  }
}

export const openaiLiq = { getLiquidationAnalysis };

// ── HTF Long-Term Analysis ────────────────────────────────────────────────────

export interface HTFAnalysisInput {
  coin: string;
  currentPrice: number;
  weeksSinceHalving: number;
  ma200w: number | null;
  priceToMA200wRatio: number | null;
  allTimeHigh: number;
  cycleLow: number;
  drawdownFromATH: number;
  recentWeeklyTrend: "bullish" | "bearish" | "neutral";
}

export interface HTFAIResponse {
  success: boolean;
  cyclePhase?: string;
  trend?: "bullish" | "bearish" | "neutral";
  outlook6m?: string;
  outlook12m?: string;
  keyLevels?: string;
  ourTake?: string;
  ourTakeAction?: "buy" | "accumulate" | "hold" | "sell" | "watch";
  error?: string;
}

async function getHTFAnalysis(input: HTFAnalysisInput): Promise<HTFAIResponse> {
  try {
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const prompt = `You are a veteran macro crypto analyst specialising in Bitcoin cycle analysis and higher time-frame (HTF) price action. Analyse the following on-chain and price data and give a long-term outlook.

Asset: ${input.coin}
Current Price: $${fmt(input.currentPrice)}
All-Time High: $${fmt(input.allTimeHigh)}
Drawdown from ATH: ${input.drawdownFromATH.toFixed(1)}%
Cycle Low (this cycle): $${fmt(input.cycleLow)}
Weeks Since Last Halving: ${input.weeksSinceHalving}
200-Week MA: ${input.ma200w ? "$" + fmt(input.ma200w) : "unavailable"}
Price / 200W MA Ratio: ${input.priceToMA200wRatio ? input.priceToMA200wRatio.toFixed(2) + "x" : "unavailable"}
Recent Weekly Trend: ${input.recentWeeklyTrend}

Historically, Bitcoin cycles run ~4 years from halving to halving. Week 0–52 is typically early accumulation/recovery, 52–104 is expansion, 104–156 is peak/euphoria, 156+ is bear/distribution.

Respond ONLY with valid JSON:
{
  "cyclePhase": "one of: Early Accumulation | Mid Expansion | Late Expansion | Distribution | Bear Market | Recovery",
  "trend": "bullish" | "bearish" | "neutral",
  "outlook6m": "2-3 sentences on 6-month price outlook based on cycle position and technicals",
  "outlook12m": "2-3 sentences on 12-month price outlook",
  "keyLevels": "1-2 sentences on the most important support/resistance levels to watch long-term",
  "ourTake": "1-2 sentence actionable insight for a long-term investor",
  "ourTakeAction": "buy" | "accumulate" | "hold" | "sell" | "watch"
}`;

    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    const raw = response.data?.choices?.[0]?.message?.content ?? "";
    const result = JSON.parse(raw);
    return { success: true, ...result };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to get HTF analysis" };
  }
}

export const openaiHTF = { getHTFAnalysis };

// ── Per-tab HTF AI insight ────────────────────────────────────────────────────

export interface TabInsightInput {
  tab: string;
  coin: string;
  currentPrice: number;
  weeksSinceHalving: number;
  ma200w: number | null;
  priceToMA200wRatio: number | null;
  allTimeHigh: number;
  cycleLow: number;
  drawdownFromATH: number;
  recentWeeklyTrend: string;
  piGap: number;
}

const TAB_PROMPTS: Record<string, (d: TabInsightInput) => string> = {
  monthly: (d) => `You are a crypto cycle analyst. ${d.coin} is currently at $${d.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}, ${d.drawdownFromATH.toFixed(1)}% below ATH, ${d.weeksSinceHalving} weeks post-halving. Based on historical monthly return patterns for ${d.coin}, briefly describe (2 sentences max) the key seasonal tendencies and which months have historically been strongest or weakest.`,

  ma200: (d) => `You are a crypto analyst. ${d.coin} is at $${d.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })} with a 200-week MA of ${d.ma200w ? "$" + d.ma200w.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "unknown"} (ratio: ${d.priceToMA200wRatio ? d.priceToMA200wRatio.toFixed(2) + "x" : "unknown"}). Historically, price at or below the 200W MA is a generational buy zone, and above 3x signals a top. Give a 2-sentence insight on what the current ratio implies for long-term holders.`,

  cycle: (d) => `You are a Bitcoin cycle analyst. We are ${d.weeksSinceHalving} weeks into the current post-halving cycle. The 2020 cycle peaked around week 78 (Nov 2021). Give a 2-sentence comparison of where we are in this cycle versus the 2020 cycle and what that implies for timing.`,

  pi: (d) => `You are a Bitcoin analyst. The Pi Cycle Top indicator shows the 16-week SMA is ${d.piGap > 0 ? "above" : "below"} the 2×50-week SMA by ${Math.abs(d.piGap).toFixed(1)}%. This indicator has historically crossed at cycle tops within days. Give a 2-sentence read on what this gap tells us about cycle top proximity.`,

  fib: (d) => `You are a crypto technical analyst. ${d.coin} is at $${d.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}, with cycle low $${d.cycleLow.toLocaleString("en-US", { maximumFractionDigits: 0 })} and ATH $${d.allTimeHigh.toLocaleString("en-US", { maximumFractionDigits: 0 })}. Give a 2-sentence insight on which Fibonacci level is most significant right now and why.`,

  scenario: (d) => `You are a crypto analyst. ${d.coin} is ${d.weeksSinceHalving} weeks post-halving at $${d.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}, trend is ${d.recentWeeklyTrend}. Give a 2-sentence probability-weighted view on whether the bull, base, or bear scenario looks most likely right now and why.`,

  ai: () => "",
};

export async function getTabInsight(input: TabInsightInput): Promise<{ success: boolean; text?: string; error?: string }> {
  const buildPrompt = TAB_PROMPTS[input.tab];
  if (!buildPrompt) return { success: false, error: "No prompt for tab" };
  const prompt = buildPrompt(input);
  if (!prompt) return { success: false, error: "No prompt" };
  try {
    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.45,
      max_tokens: 120,
    });
    const text = response.data?.choices?.[0]?.message?.content?.trim() ?? "";
    return { success: true, text };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed" };
  }
}

export type { ChatMessage, ChatResponse };

// ── Chart Prediction (for PriceChart overlay) ─────────────────────────────

export interface ChartPredictionWaypoint {
  offsetSeconds: number;
  price: number;
}

export interface ChartKeyLevel {
  price: number;
  label: string;
  style: "solid" | "dashed";
}

export interface TechnicalContext {
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbPosition: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  trend: "uptrend" | "downtrend" | "sideways" | "unknown";
  pattern: { name: string; type: string } | null;
  support: number[];
  resistance: number[];
}

export interface ChartPrediction {
  direction: "bullish" | "bearish" | "neutral";
  waypoints: ChartPredictionWaypoint[];
  targetPrice: number;
  stopLoss: number;
  scenario: string;
  analysis: string;
  keyFactors: string[];
  annotation: string;
  confidence: "high" | "medium" | "low";
  keyLevels: ChartKeyLevel[];
  fibZone?: { high: number; low: number; label: string };
  suggestedLeverage?: number;
}

export async function getChartPrediction(
  coin: string,
  interval: string,
  candles: { open: number; high: number; low: number; close: number; time: number }[],
  tech?: TechnicalContext,
): Promise<{ success: boolean; result?: ChartPrediction; error?: string }> {
  try {
    if (!API_KEY) return { success: false, error: "No API key" };

    const recent = candles.slice(-50);
    const last = recent[recent.length - 1];
    const currentPrice = last.close;
    const intervalSeconds: Record<string, number> = {
      "1sec": 1, "1min": 60, "5min": 300, "15min": 900,
      "1h": 3600, "4h": 14400, "6h": 21600, "1day": 86400, "1week": 604800,
    };
    const candleSeconds = intervalSeconds[interval] ?? 3600;
    const futureHorizonSeconds = candleSeconds * 20;
    const h25 = Math.round(futureHorizonSeconds * 0.25);
    const h50 = Math.round(futureHorizonSeconds * 0.5);
    const h75 = Math.round(futureHorizonSeconds * 0.75);

    const summary = recent.slice(-30).map(c => ({
      o: c.open.toFixed(2), h: c.high.toFixed(2),
      l: c.low.toFixed(2), cl: c.close.toFixed(2),
    }));

    const swingLow = Math.min(...recent.map(c => c.low));
    const swingHigh = Math.max(...recent.map(c => c.high));

    const fmtN = (n: number | null) => n != null ? n.toFixed(2) : "n/a";

    const rsiInterp = tech?.rsi != null
      ? tech.rsi >= 70 ? "overbought — selling pressure likely"
      : tech.rsi <= 30 ? "oversold — bounce potential"
      : tech.rsi >= 55 ? "mildly bullish"
      : tech.rsi <= 45 ? "mildly bearish"
      : "neutral zone" : "n/a";

    const bbInterp = tech?.bbPosition != null
      ? tech.bbPosition >= 0.85 ? "price at upper band — potential reversal or continuation"
      : tech.bbPosition <= 0.15 ? "price at lower band — potential bounce"
      : tech.bbPosition >= 0.6 ? "above midband — bullish bias"
      : tech.bbPosition <= 0.4 ? "below midband — bearish bias"
      : "midband — indecision" : "n/a";

    const macdInterp = tech?.macdHist != null && tech?.macdLine != null
      ? tech.macdHist > 0 && tech.macdLine > 0 ? "bullish — above zero, expanding"
      : tech.macdHist > 0 && tech.macdLine < 0 ? "recovering — negative zone but histogram positive (early bullish cross)"
      : tech.macdHist < 0 && tech.macdLine < 0 ? "bearish — below zero, contracting"
      : "diverging — watch for cross" : "n/a";

    const trendLines = tech ? `
▸ TREND & EMA STRUCTURE
  Trend: ${tech.trend.toUpperCase()}
  EMA20: $${fmtN(tech.ema20)} → price is ${tech.ema20 != null ? currentPrice > tech.ema20 ? "ABOVE (bullish)" : "BELOW (bearish)" : "n/a"}
  EMA50: $${fmtN(tech.ema50)} → price is ${tech.ema50 != null ? currentPrice > tech.ema50 ? "ABOVE (bullish)" : "BELOW (bearish)" : "n/a"}
  EMA200: $${fmtN(tech.ema200)} → price is ${tech.ema200 != null ? currentPrice > tech.ema200 ? "ABOVE (bullish)" : "BELOW (bearish)" : "n/a"}

▸ MOMENTUM INDICATORS
  RSI(14): ${fmtN(tech.rsi)} → ${rsiInterp}
  MACD Line: ${fmtN(tech.macdLine)} | Signal: ${fmtN(tech.macdSignal)} | Histogram: ${fmtN(tech.macdHist)} → ${macdInterp}

▸ VOLATILITY
  Bollinger Band Position: ${tech.bbPosition != null ? (tech.bbPosition * 100).toFixed(0) + "%" : "n/a"} → ${bbInterp}

▸ CANDLE PATTERN
  ${tech.pattern ? `${tech.pattern.name} (${tech.pattern.type}) — pattern detected on recent candles` : "No dominant pattern detected"}

▸ KEY STRUCTURE LEVELS
  Resistance zones: ${tech.resistance.length ? tech.resistance.map(r => `$${r.toFixed(0)}`).join(", ") : "n/a"}
  Support zones: ${tech.support.length ? tech.support.map(s => `$${s.toFixed(0)}`).join(", ") : "n/a"}` : "";

    const prompt = `You are a senior crypto technical analyst with deep expertise in price action, derivatives, and market microstructure. Perform a comprehensive multi-factor analysis of ${coin} on the ${interval} chart and generate a precise, realistic price path prediction.

══════════════════════════════════════════════════
MARKET CONTEXT
══════════════════════════════════════════════════
Asset: ${coin} | Timeframe: ${interval}
Current Price: $${currentPrice.toFixed(2)}
Swing High: $${swingHigh.toFixed(2)} | Swing Low: $${swingLow.toFixed(2)}
Range: $${(swingHigh - swingLow).toFixed(2)} (${((swingHigh - swingLow) / currentPrice * 100).toFixed(1)}% of price)
${trendLines}

▸ RECENT PRICE DATA (last 30 candles, oldest→newest)
  ${JSON.stringify(summary)}

══════════════════════════════════════════════════
ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════
1. Read ALL indicators for confluence — do RSI, MACD, and BB align? Any divergences?
2. Assess EMA alignment — are they stacked bullish/bearish or mixed?
3. Identify liquidity pools: where are stop-losses likely clustered? Price is often drawn toward these.
4. Consider the swing high/low range and Fibonacci levels within it
5. Choose the HIGHEST PROBABILITY scenario based on the full picture
6. The predicted path should be realistic and non-linear — can include a sweep, fakeout, retest, etc.
7. keyFactors: 3-4 specific bullet points referencing ACTUAL numbers from the indicators above
8. Be brutally honest in confidence level — "high" only if 3+ indicators align

══════════════════════════════════════════════════
OUTPUT FORMAT (valid JSON only, no markdown)
══════════════════════════════════════════════════
{
  "direction": "bullish" | "bearish" | "neutral",
  "confidence": "high" | "medium" | "low",
  "scenario": "<1 sharp sentence — primary thesis with specific price levels>",
  "analysis": "<2-3 sentences — what the indicators collectively suggest, cite specific values>",
  "keyFactors": [
    "<factor 1: specific indicator reading and what it implies>",
    "<factor 2>",
    "<factor 3>"
  ],
  "annotation": "<1-2 sentences of honest analyst commentary — acknowledge what could go wrong>",
  "stopLoss": <number>,
  "targetPrice": <number>,
  "waypoints": [
    { "offsetSeconds": 0, "price": ${currentPrice.toFixed(2)} },
    { "offsetSeconds": ${h25}, "price": <number> },
    { "offsetSeconds": ${h50}, "price": <number> },
    { "offsetSeconds": ${h75}, "price": <number> },
    { "offsetSeconds": ${futureHorizonSeconds}, "price": <number> }
  ],
  "keyLevels": [
    { "price": <number>, "label": "<short name>", "style": "solid" | "dashed" }
  ],
  "fibZone": { "high": <number>, "low": <number>, "label": "<e.g. '0.5–0.618 Fib'>" },
  "suggestedLeverage": <integer 2-20, conservative safe leverage based on stop distance and volatility>
}`;

    const response = await axiosInstance.post('/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 800,
      response_format: { type: "json_object" },
    });

    const raw = response.data?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as ChartPrediction;
    if (!parsed.waypoints?.length || !parsed.direction) {
      return { success: false, error: "Invalid prediction format" };
    }
    parsed.keyLevels  = Array.isArray(parsed.keyLevels) ? parsed.keyLevels : [];
    parsed.keyFactors = Array.isArray(parsed.keyFactors) ? parsed.keyFactors : [];
    parsed.analysis   = parsed.analysis   || parsed.scenario || "";
    parsed.annotation = parsed.annotation || "";
    return { success: true, result: parsed };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to get chart prediction" };
  }
}
