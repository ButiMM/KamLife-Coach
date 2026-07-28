/**
 * SURFACE — how wide is this product actually, and which parts does anyone use?
 *
 * (2026-07-28, founder: "We're already in the niche, but our surface is so wide. How do we
 * mitigate this but give a product that's world class?")
 *
 * The market is already narrow — South Africa, WhatsApp only, R199, weight loss. What is wide
 * is the PRODUCT: 29 handlers, 24 scheduled jobs, ~27,000 lines. And the evidence from the whole
 * of 2026-07-27 is that the defects came from the periphery, not the core: a swap handler turned
 * "Teach me" into a fruit list, a confusion handler dumped the sitemap, restaurant menus answered
 * a meal log three times. The founder had already noticed — "why do we have eighteen restaurants,
 * when did I confirm that?"
 *
 * Every feature is a surface where a bug can meet a client. So the question "what should we cut?"
 * has to be answered with usage, not taste — the same discipline that killed the "add more foods"
 * plan. This counts what real clients actually reach for.
 *
 * The rule it exists to enforce: KEEP THE CODE, STOP PROMOTING IT. Something reachable on request
 * costs nothing; something pushed at people costs attention and creates failure surface.
 *
 * Pure — no DB, no model. Unit-tested.
 */

/** The handful of things this product is FOR. Everything else is surface. */
export const CORE_INTENTS = [
  "FOOD_LOG", "FOOD_VISION", "MEAL_PHOTO", "FOOD_CORRECTION", "UNDEREATING_TODAY",
  "WORKOUT_VIEW", "WORKOUT_DONE", "WORKOUT_FEEDBACK", "PROGRAMME",
  "PROGRESS", "WEIGHT", "STEP_LOG", "WATER_LOG",
  "SICK", "LIFE_", "CRISIS", "MEDICAL_DISCLAIMER",   // safety is core by definition
];

export type SurfaceClass = "core" | "periphery" | "dead";

export interface IntentUse { intent: string; count: number }

export interface SurfaceRow {
  intent: string;
  count: number;
  share: number;          // % of all traffic
  klass: SurfaceClass;
}

export function classifyIntent(intent: string, count: number, totalDays: number): SurfaceClass {
  const isCore = CORE_INTENTS.some(c => intent.toUpperCase().startsWith(c));
  if (isCore) return "core";
  // Fewer than one use a fortnight is not a feature, it is a liability with a test suite.
  const perFortnight = totalDays > 0 ? (count / totalDays) * 14 : count;
  return perFortnight < 1 ? "dead" : "periphery";
}

export interface SurfaceReport {
  totalReplies: number;
  distinctIntents: number;
  coreShare: number;        // % of all traffic that is core
  peripheryShare: number;
  rows: SurfaceRow[];       // every intent, busiest first
  dead: SurfaceRow[];       // candidates to stop promoting
}

export function analyseSurface(uses: IntentUse[], totalDays: number): SurfaceReport {
  const total = uses.reduce((n, u) => n + u.count, 0) || 1;
  const rows: SurfaceRow[] = uses
    .map(u => ({
      intent: u.intent || "(none)",
      count: u.count,
      share: Math.round((u.count / total) * 100),
      klass: classifyIntent(u.intent || "", u.count, totalDays),
    }))
    .sort((a, b) => b.count - a.count);

  const shareOf = (k: SurfaceClass) =>
    Math.round((rows.filter(r => r.klass === k).reduce((n, r) => n + r.count, 0) / total) * 100);

  return {
    totalReplies: total,
    distinctIntents: rows.length,
    coreShare: shareOf("core"),
    peripheryShare: shareOf("periphery"),
    rows,
    dead: rows.filter(r => r.klass === "dead"),
  };
}
