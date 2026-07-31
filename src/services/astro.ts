import * as Astronomy from "astronomy-engine";

// Entertainment/educational feature only — see AstroSuggestions.tsx disclaimer.
// Bitcoin's "birth chart" is cast for the genesis block (block 0), mined
// 2009-01-03 18:15:05 UTC. Real geocentric planetary positions (via
// astronomy-engine, an offline ephemeris library — no external API) at
// that moment form the "natal" chart; today's transiting positions are
// compared against it to derive aspects.
const GENESIS_DATE = new Date("2009-01-03T18:15:05Z");

type PlanetName =
  | "Sun"
  | "Moon"
  | "Mercury"
  | "Venus"
  | "Mars"
  | "Jupiter"
  | "Saturn"
  | "Uranus"
  | "Neptune"
  | "Pluto"
  | "Rahu"
  | "Ketu";

const PLANETS: PlanetName[] = [
  "Sun",
  "Moon",
  "Mercury",
  "Venus",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
  "Pluto",
  "Rahu",
  "Ketu",
];

interface PlanetTrait {
  theme: string;
  // -1 (malefic) .. +1 (benefic), used only to break the tie on conjunctions
  polarity: number;
  // relative importance — slower/heavier bodies carry more weight
  weight: number;
}

const PLANET_TRAITS: Record<PlanetName, PlanetTrait> = {
  Sun: { theme: "confidence", polarity: 0.2, weight: 1.0 },
  Moon: { theme: "sentiment", polarity: 0, weight: 0.7 },
  Mercury: { theme: "volatility", polarity: 0, weight: 0.7 },
  Venus: { theme: "demand", polarity: 0.8, weight: 1.1 },
  Mars: { theme: "aggression", polarity: -0.8, weight: 1.1 },
  Jupiter: { theme: "expansion", polarity: 1, weight: 1.3 },
  Saturn: { theme: "contraction", polarity: -1, weight: 1.3 },
  // Outer "transpersonal" planets — slow-moving, classically read as bigger,
  // longer-lasting structural shifts rather than day-to-day noise.
  Uranus: { theme: "disruption", polarity: 0, weight: 1.4 },
  Neptune: { theme: "speculation", polarity: -0.4, weight: 1.2 },
  Pluto: { theme: "transformation", polarity: -0.2, weight: 1.4 },
  // Lunar nodes — in Vedic astrology these carry the heaviest emphasis of
  // all, often read as the strongest markers of abrupt trend changes.
  Rahu: { theme: "mania/excess", polarity: 0.5, weight: 1.5 },
  Ketu: { theme: "reversal/detachment", polarity: -0.5, weight: 1.5 },
};

interface AspectDef {
  name: string;
  verb: string;
  angle: number;
  orb: number;
  // undefined for conjunction — valence there depends on which planets are involved
  valence?: number;
}

const ASPECTS: AspectDef[] = [
  { name: "Conjunction", verb: "conjunct", angle: 0, orb: 8 },
  { name: "Sextile", verb: "sextile", angle: 60, orb: 4, valence: 0.6 },
  { name: "Square", verb: "square", angle: 90, orb: 6, valence: -1 },
  { name: "Trine", verb: "trine", angle: 120, orb: 6, valence: 1 },
  { name: "Opposition", verb: "opposite", angle: 180, orb: 8, valence: -1 },
];

export type AstroBias = "bullish" | "neutral" | "bearish";

export interface AstroFactor {
  transitingPlanet: PlanetName;
  natalPlanet: PlanetName;
  aspect: string;
  valence: number; // signed contribution, for sorting/display only
  description: string;
}

export interface AstroReading {
  bias: AstroBias;
  score: number;
  factors: AstroFactor[];
  asOf: string; // ISO date this reading covers (UTC)
  generatedAt: number; // ms epoch
}

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// Standard mean lunar ascending-node longitude (a well-known low-precision
// astronomical formula, e.g. the same mean-node term used in IAU nutation
// theory), T = Julian centuries since J2000.0.
function meanLunarNodeLongitude(date: Date): number {
  const t = new Astronomy.AstroTime(date).ut / 36525;
  const omega = 125.04452 - 1934.136261 * t + 0.0020708 * t * t + (t * t * t) / 450000;
  return normalizeDegrees(omega);
}

function eclipticLongitude(planet: PlanetName, date: Date): number {
  if (planet === "Moon") return Astronomy.EclipticGeoMoon(date).lon;
  if (planet === "Sun") return Astronomy.SunPosition(date).elon;
  if (planet === "Rahu") return meanLunarNodeLongitude(date);
  if (planet === "Ketu") return normalizeDegrees(meanLunarNodeLongitude(date) + 180);
  const vec = Astronomy.GeoVector(Astronomy.Body[planet], date, true);
  return Astronomy.Ecliptic(vec).elon;
}

function angleSeparation(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function matchAspect(separation: number): { def: AspectDef; strength: number } | null {
  for (const def of ASPECTS) {
    const deviation = Math.abs(separation - def.angle);
    if (deviation <= def.orb) {
      return { def, strength: 1 - deviation / def.orb };
    }
  }
  return null;
}

function describeFactor(
  transiting: PlanetName,
  natal: PlanetName,
  def: AspectDef,
  valence: number,
): string {
  const t = PLANET_TRAITS[transiting];
  const n = PLANET_TRAITS[natal];
  if (def.name === "Conjunction") {
    const tone = valence > 0.15 ? "supportive" : valence < -0.15 ? "tense" : "mixed";
    return `Transiting ${transiting} conjunct natal ${natal} — a ${tone} blend of ${t.theme} and ${n.theme}.`;
  }
  const tone = (def.valence ?? 0) > 0 ? "supportive, easing" : "tense, adding pressure to";
  return `Transiting ${transiting} ${def.verb} natal ${natal} — ${tone} ${n.theme}/${t.theme}.`;
}

let natalLonCache: Record<PlanetName, number> | null = null;

function getNatalLongitudes(): Record<PlanetName, number> {
  if (natalLonCache) return natalLonCache;
  const out = {} as Record<PlanetName, number>;
  for (const p of PLANETS) out[p] = eclipticLongitude(p, GENESIS_DATE);
  natalLonCache = out;
  return out;
}

function computeReading(date: Date): { score: number; factors: AstroFactor[] } {
  const natalLon = getNatalLongitudes();
  const transitLon: Record<PlanetName, number> = {} as Record<PlanetName, number>;
  for (const p of PLANETS) transitLon[p] = eclipticLongitude(p, date);

  const factors: AstroFactor[] = [];
  let score = 0;

  for (const transiting of PLANETS) {
    for (const natal of PLANETS) {
      const sep = angleSeparation(transitLon[transiting], natalLon[natal]);
      const match = matchAspect(sep);
      if (!match) continue;

      const { def, strength } = match;
      const avgWeight =
        (PLANET_TRAITS[transiting].weight + PLANET_TRAITS[natal].weight) / 2;

      let valence: number;
      if (def.name === "Conjunction") {
        valence =
          ((PLANET_TRAITS[transiting].polarity + PLANET_TRAITS[natal].polarity) / 2) *
          avgWeight *
          strength;
      } else {
        valence = (def.valence ?? 0) * avgWeight * strength;
      }

      score += valence;
      factors.push({
        transitingPlanet: transiting,
        natalPlanet: natal,
        aspect: def.name,
        valence,
        description: describeFactor(transiting, natal, def, valence),
      });
    }
  }

  factors.sort((a, b) => Math.abs(b.valence) - Math.abs(a.valence));
  return { score, factors };
}

let cache: { dayKey: string; reading: AstroReading } | null = null;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getAstroReading(now: Date = new Date()): AstroReading {
  const key = dayKey(now);
  if (cache && cache.dayKey === key) return cache.reading;

  const { score, factors } = computeReading(now);
  const bias: AstroBias = score > 1 ? "bullish" : score < -1 ? "bearish" : "neutral";

  const reading: AstroReading = {
    bias,
    score,
    factors: factors.slice(0, 4),
    asOf: key,
    generatedAt: Date.now(),
  };

  cache = { dayKey: key, reading };
  return reading;
}

export interface AstroCurvePoint {
  time: number; // ms epoch
  score: number;
  price: number;
}

const scoreCurveCache = new Map<string, number[]>();

function getScoreCurve(start: Date, stepsPerDay: number): number[] {
  const key = `${dayKey(start)}:${stepsPerDay}`;
  const cached = scoreCurveCache.get(key);
  if (cached) return cached;
  const scores = Array.from({ length: stepsPerDay + 1 }, (_, i) =>
    computeReading(new Date(start.getTime() + i * (86_400_000 / stepsPerDay))).score,
  );
  scoreCurveCache.set(key, scores);
  return scores;
}

/**
 * A full local-calendar-day "predicted price" curve, in the spirit of the
 * classic astro-forecasting charts (predicted line vs real price). The
 * *shape* comes from real planetary transits; the mapping from score to a
 * dollar figure is our own invented rescaling around `anchorPrice` — there
 * is no real price signal here, see the disclaimer in AstroSuggestions.tsx.
 */
export function getAstroPriceCurve(
  day: Date,
  anchorPrice: number,
  stepsPerDay = 48,
): AstroCurvePoint[] {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const scores = getScoreCurve(start, stepsPerDay);

  const AMPLITUDE_PCT = 0.015; // modest +/-1.5% band, deliberately not overstated
  const maxAbs = Math.max(0.5, ...scores.map(Math.abs));

  return scores.map((score, i) => ({
    time: start.getTime() + i * (86_400_000 / stepsPerDay),
    score,
    price: anchorPrice * (1 + (score / maxAbs) * AMPLITUDE_PCT),
  }));
}

/** Mirrors the curve's price values around the day's mean, within [startMs, endMs]. */
export function invertCurveSegment(
  curve: AstroCurvePoint[],
  startMs: number,
  endMs: number,
): AstroCurvePoint[] {
  if (!curve.length) return curve;
  const mean = curve.reduce((s, p) => s + p.price, 0) / curve.length;
  return curve.map((p) =>
    p.time >= startMs && p.time <= endMs
      ? { ...p, price: 2 * mean - p.price }
      : p,
  );
}
