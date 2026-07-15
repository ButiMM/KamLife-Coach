/**
 * UnderstandingState — the "cortex" the whole coach reads from and writes to.
 *
 * This is the single object that answers "what do we understand about this person
 * right now?" Every component consumes it; nothing keeps a competing copy. It is the
 * nervous system the reviews said was missing.
 *
 * TRUST DISCIPLINE (blueprint safeguard): only persist fields we can trust.
 *  - profile / observations  → durable, slow-moving; PERSIST (the Perception pass writes them).
 *  - current                 → volatile (mood flips by the message); the latest inference is
 *                              kept for continuity but treated as soft, never as ground truth.
 *  - stats                   → DERIVED from the real DB snapshot each turn; NEVER persisted here
 *                              (persisting a stale streak/weight would lie).
 *
 * Storage is deliberately abstract: this module only defines the shape, safe defaults,
 * and (de)serialization. Where it lives (a table, a jsonb column, a cache) is the wiring
 * step's decision, not the schema's.
 */

export type Mood = "frustrated" | "anxious" | "motivated" | "neutral" | "hopeful";
export type HealthStatus = "sick" | "recovering" | "healthy";
export type Topic = "recovery" | "nutrition" | "workout" | "life" | "gratitude" | "progress";
export type Trend = "rising" | "stable" | "falling";
export type Readiness = "low" | "medium" | "high";
export type WeightDirection = "up" | "down" | "stable";

export interface UnderstandingState {
  /** persistent, slow-moving — who this person is */
  profile: {
    name: string;
    lifeStory: string;      // short evolving narrative (~50 words), updated over days
    keyFacts: string[];     // injuries, job, family, goals — durable truths they told us
    preferences: { numberFree: boolean };
  };
  /** per-message context — what is going on right now (volatile, inferred each turn) */
  current: {
    mood: Mood;
    healthStatus: HealthStatus;
    topic: Topic;
  };
  /** the coach's accumulated read on the person — the thing that makes it a coach, not a chatbot */
  observations: {
    confidenceTrend: Trend;
    frustrationLevel: number; // 1-10
    readinessToPush: Readiness;
    trustLevel: number;       // 1-10
  };
  /** objective baseline — DERIVED from the DB snapshot each turn, never persisted here */
  stats: {
    streak: number;
    weightDirection: WeightDirection;
    recentProteinAvg: number;
    recentStepAvg: number;
  };
  /** bookkeeping */
  updatedAt: string; // ISO
}

export function defaultUnderstanding(name = "there"): UnderstandingState {
  return {
    profile: { name, lifeStory: "", keyFacts: [], preferences: { numberFree: true } },
    current: { mood: "neutral", healthStatus: "healthy", topic: "life" },
    observations: { confidenceTrend: "stable", frustrationLevel: 3, readinessToPush: "medium", trustLevel: 5 },
    stats: { streak: 0, weightDirection: "stable", recentProteinAvg: 0, recentStepAvg: 0 },
    updatedAt: new Date().toISOString(),
  };
}

const MOODS = new Set<Mood>(["frustrated", "anxious", "motivated", "neutral", "hopeful"]);
const HEALTH = new Set<HealthStatus>(["sick", "recovering", "healthy"]);
const TOPICS = new Set<Topic>(["recovery", "nutrition", "workout", "life", "gratitude", "progress"]);
const TRENDS = new Set<Trend>(["rising", "stable", "falling"]);
const READY = new Set<Readiness>(["low", "medium", "high"]);
const WDIR = new Set<WeightDirection>(["up", "down", "stable"]);

const clampInt = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = typeof n === "number" ? n : Number(n);
  if (!isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(v)));
};
const oneOf = <T,>(set: Set<T>, v: unknown, dflt: T): T => (set.has(v as T) ? (v as T) : dflt);

/**
 * Coerce arbitrary parsed JSON (from storage OR from a model) into a valid, safe
 * UnderstandingState. This is the trust gate: a model can never write an out-of-range
 * frustration level or an invented mood into the system — it is clamped/whitelisted here.
 */
export function coerceUnderstanding(raw: any, fallbackName = "there"): UnderstandingState {
  const d = defaultUnderstanding(fallbackName);
  if (!raw || typeof raw !== "object") return d;
  const p = raw.profile ?? {};
  const c = raw.current ?? {};
  const o = raw.observations ?? {};
  const s = raw.stats ?? {};
  return {
    profile: {
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : d.profile.name,
      lifeStory: typeof p.lifeStory === "string" ? p.lifeStory.trim().slice(0, 400) : d.profile.lifeStory,
      keyFacts: Array.isArray(p.keyFacts) ? p.keyFacts.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 120)).slice(0, 12) : d.profile.keyFacts,
      preferences: { numberFree: typeof p.preferences?.numberFree === "boolean" ? p.preferences.numberFree : d.profile.preferences.numberFree },
    },
    current: {
      mood: oneOf(MOODS, c.mood, d.current.mood),
      healthStatus: oneOf(HEALTH, c.healthStatus, d.current.healthStatus),
      topic: oneOf(TOPICS, c.topic, d.current.topic),
    },
    observations: {
      confidenceTrend: oneOf(TRENDS, o.confidenceTrend, d.observations.confidenceTrend),
      frustrationLevel: clampInt(o.frustrationLevel, 1, 10, d.observations.frustrationLevel),
      readinessToPush: oneOf(READY, o.readinessToPush, d.observations.readinessToPush),
      trustLevel: clampInt(o.trustLevel, 1, 10, d.observations.trustLevel),
    },
    stats: {
      streak: clampInt(s.streak, 0, 100000, d.stats.streak),
      weightDirection: oneOf(WDIR, s.weightDirection, d.stats.weightDirection),
      recentProteinAvg: clampInt(s.recentProteinAvg, 0, 100000, d.stats.recentProteinAvg),
      recentStepAvg: clampInt(s.recentStepAvg, 0, 10000000, d.stats.recentStepAvg),
    },
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : d.updatedAt,
  };
}

/** The durable subset — what is safe to PERSIST (profile + observations only). */
export function persistableUnderstanding(s: UnderstandingState): Pick<UnderstandingState, "profile" | "observations"> {
  return { profile: s.profile, observations: s.observations };
}

export function serializeUnderstanding(s: UnderstandingState): string {
  return JSON.stringify(s);
}

export function parseUnderstanding(json: string | null | undefined, fallbackName = "there"): UnderstandingState {
  if (!json) return defaultUnderstanding(fallbackName);
  try { return coerceUnderstanding(JSON.parse(json), fallbackName); }
  catch { return defaultUnderstanding(fallbackName); }
}
