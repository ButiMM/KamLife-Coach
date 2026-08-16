import { } from "";
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
 * Storage is deliberately abstract: this module only defines the shape, safe defaults, and (de)serialization.
 */

export type Mood = "frustrated" | "anxious" | "motivated" | "neutral" | "hopeful";
export type HealthStatus = "sick" | "recovering" | "healthy";
export type Topic = "recovery" | "nutrition" | "workout" | "life" | "gratitude" | "progress";
export type Trend = "rising" | "stable" | "falling";
export type Readiness = "low" | "medium" | "high";
export type WeightDirection = "up" | "down" | "stable";

export interface UnderstandingState {
  profile: { name: string; lifeStory: string; keyFacts: string[]; preferences: { numberFree: boolean } };
  current: { mood: Mood; healthStatus: HealthStatus; topic: Topic };
  observations: { confidenceTrend: Trend; frustrationLevel: number; readinessToPush: Readiness; trustLevel: number };
  stats: { streak: number; weightDirection: WeightDirection; recentProteinAvg: number; recentStepAvg: number };
  updatedAt: string;
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

export function decayObservations(o: UnderstandingState["observations"], ageHours: number): UnderstandingState["observations"] {
  if (!(ageHours >= 48)) return o;
  const d = defaultUnderstanding().observations;
  return {
    confidenceTrend: "stable",
    readinessToPush: "medium",
    frustrationLevel: Math.round(o.frustrationLevel * 0.5 + d.frustrationLevel * 0.5),
    trustLevel: ageHours >= 24 * 30 ? Math.round(o.trustLevel * 0.7 + d.trustLevel * 0.3) : o.trustLevel,
  };
}

const MOODS = new Set<Mood>(["frustrated", "anxious", "motivated", "neutral", "hopeful"]);
const HEALTH = new Set<HealthStatus>(["sick", "recovering", "healthy"]);
const TOPICS = new Set<Topic>(["recovery", "nutrition", "workout", "life", "gratitude", "progress"]);
const TRENDS = new Set<Trend>(["rising", "stable", "falling"]);
const READY = new Set<Readiness>(["low", "medium", "high"]);
const WDIR = new Set<WeightDirection>(["up", "down", "stable"]);
const clampInt = (n: unknown, lo: number, hi: number, dflt: number): number => { const v = typeof n === "number" ? n : Number(n); if (!isFinite(v)) return dflt; return Math.max(lo, Math.min(hi, Math.round(v))); };
const oneOf = <T,>(set: Set<T>, v: unknown, dflt: T): T => (set.has(v as T) ? (v as T) : dflt);

export function coerceUnderstanding(raw: any, fallbackName = "there"): UnderstandingState {
  const d = defaultUnderstanding(fallbackName); if (!raw || typeof raw !== "object") return d;
  const p = raw.profile ?? {}, c = raw.current ?? {}, o = raw.observations ?? {}, s = raw.stats ?? {};
  return {
    profile: { name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : d.profile.name, lifeStory: typeof p.lifeStory === "string" ? p.lifeStory.trim().slice(0, 400) : d.profile.lifeStory, keyFacts: Array.isArray(p.keyFacts) ? p.keyFacts.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 120)).slice(0, 12) : d.profile.keyFacts, preferences: { numberFree: typeof p.preferences?.numberFree === "boolean" ? p.preferences.numberFree : d.profile.preferences.numberFree } },
    current: { mood: oneOf(MOODS, c.mood, d.current.mood), healthStatus: oneOf(HEALTH, c.healthStatus, d.current.healthStatus), topic: oneOf(TOPICS, c.topic, d.current.topic) },
    observations: { confidenceTrend: oneOf(TRENDS, o.confidenceTrend, d.observations.confidenceTrend), frustrationLevel: clampInt(o.frustrationLevel, 1, 10, d.observations.frustrationLevel), readinessToPush: oneOf(READY, o.readinessToPush, d.observations.readinessToPush), trustLevel: clampInt(o.trustLevel, 1, 10, d.observations.trustLevel) },
    stats: { streak: clampInt(s.streak, 0, 100000, d.stats.streak), weightDirection: oneOf(WDIR, s.weightDirection, d.stats.weightDirection), recentProteinAvg: clampInt(s.recentProteinAvg, 0, 100000, d.stats.recentProteinAvg), recentStepAvg: clampInt(s.recentStepAvg, 0, 10000000, d.stats.recentStepAvg) },
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : d.updatedAt,
  };
}

export function persistableUnderstanding(s: UnderstandingState): Pick<UnderstandingState, "profile" | "observations"> { return { profile: s.profile, observations: s.observations }; }
export function serializeUnderstanding(s: UnderstandingState): string { return JSON.stringify(s); }
export function parseUnderstanding(json: string | null | undefined, fallbackName = "there"): UnderstandingState { if (!json) return defaultUnderstanding(fallbackName); try { return coerceUnderstanding(JSON.parse(json), fallbackName); } catch { return defaultUnderstanding(fallbackName); } }

// ---- Canonical coaching decision contract (P0) ----
export type DecisionState = "CONTINUE" | "CHANGE" | "INVESTIGATE" | "REFER";
export type DecisionEvidence = "sufficient" | "insufficient";
export interface DecisionInputs { requiresReferral?: boolean; meaningfulProblem: boolean; evidence: DecisionEvidence; hasMinimumUsefulQuestion?: boolean; }
export function selectDecisionState(input: DecisionInputs): DecisionState {
  if (input.requiresReferral) return "REFER";
  if (input.meaningfulProblem && input.evidence === "insufficient") return input.hasMinimumUsefulQuestion ? "INVESTIGATE" : "CONTINUE";
  if (input.meaningfulProblem && input.evidence === "sufficient") return "CHANGE";
  return "CONTINUE";
}
export function isCoachingDecisionState(value: unknown): value is DecisionState { return value === "CONTINUE" || value === "CHANGE" || value === "INVESTIGATE" || value === "REFER"; }

export interface RuntimeDecisionInputs { hungerEvidence?: any; deficitEvidence?: any; requiresReferral?: boolean; }
export interface RuntimeDecisionResult { state: DecisionState; evidence: DecisionEvidence; meaningfulProblem: boolean; hasMinimumUsefulQuestion: boolean; }
export function deriveRuntimeDecision(input: RuntimeDecisionInputs): RuntimeDecisionResult {
  if (input.requiresReferral) return { state: "REFER", evidence: "sufficient", meaningfulProblem: true, hasMinimumUsefulQuestion: false };
  const hunger = input.hungerEvidence;
  const persistentHunger = hunger?.hunger?.persistent === true;
  const hungerProblem = persistentHunger || hunger?.evidenceState === "persistent_hunger" || hunger?.evidenceState === "adequate_protein_persistent_hunger";
  const hungerNeedsInvestigation = hunger?.evidenceState === "insufficient_data" || hunger?.evidenceState === "adequate_protein_persistent_hunger" || (persistentHunger && hunger?.confidence !== "usable");
  const deficit = input.deficitEvidence;
  const deficitProblem = deficit?.gapIsMaterial === true;
  const deficitEvidence: DecisionEvidence = deficit?.confidence === "usable" ? "sufficient" : "insufficient";
  const meaningfulProblem = hungerProblem || deficitProblem;
  const evidence: DecisionEvidence = hungerNeedsInvestigation ? "insufficient" : deficitProblem ? deficitEvidence : hungerProblem ? "sufficient" : "insufficient";
  const hasMinimumUsefulQuestion = hungerNeedsInvestigation || (deficitProblem && deficitEvidence === "insufficient");
  return { state: selectDecisionState({ meaningfulProblem, evidence, hasMinimumUsefulQuestion }), evidence, meaningfulProblem, hasMinimumUsefulQuestion };
}
