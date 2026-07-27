/**
 * RUN / DISTANCE CONVERSION — cardio the product could not see.
 *
 * (2026-07-27, founder: "if somebody has run a ten kilometer, five kilometer, or whatever
 * jog — does the bot know what to do with that screenshot? How does it aid their calorie
 * burn for the day?") It did not. The step extractor was explicitly instructed to IGNORE
 * distance, so a Strava/Runkeeper/Adidas screenshot showing a 10 km run logged NOTHING —
 * roughly 800 kcal of real work, invisible to the coach.
 *
 * This converts a distance into the two things the rest of the system already understands:
 * a step-equivalent (so it lands in the same daily movement ledger) and an energy burn.
 *
 * Physiology, kept deliberately conservative:
 *  - RUNNING costs ≈ 1.0 kcal per kg per km. Walking ≈ 0.5 kcal/kg/km. (Net of resting is
 *    lower, which is exactly why we lean low — over-crediting burn is how a client eats
 *    back a deficit that was never really there.)
 *  - Step equivalence: a running stride covers more ground — ~1,050 steps/km running,
 *    ~1,300 walking.
 *
 * Pure — no DB, no clock, no model. Unit-tested.
 */

export interface DistanceActivity {
  km: number;
  mode: "run" | "walk";
  stepEquivalent: number;
  burnKcal: number;
}

/** Pull a distance in km from a screenshot's text or a client's message. Null when absent. */
export function parseDistanceKm(text: string): number | null {
  const t = (text || "").toLowerCase();
  // "10.2 km", "10,2km", "5 k run", "ran 8km"
  const m = t.match(/\b(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:km|kms|kilometer|kilometre|kilometers|kilometres)\b/)
    || t.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\s*k\b(?=\s*(?:run|jog|walk))/);
  if (!m) return null;
  const km = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(km) || km <= 0 || km > 100) return null; // 100km guards OCR garbage
  return km;
}

/** Did they RUN or WALK it? Defaults to walking — the conservative, lower-burn reading. */
export function detectMode(text: string): "run" | "walk" {
  return /\b(ran|run|running|jog|jogged|jogging|sprint|5k|10k|parkrun|treadmill run)\b/i.test(text || "")
    ? "run" : "walk";
}

/**
 * Convert a distance into step-equivalent + burn for a client of this weight.
 * Leans LOW on purpose: an over-credited burn silently cancels a real deficit.
 */
export function convertDistance(km: number, weightKg: number, mode: "run" | "walk"): DistanceActivity {
  const w = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 75;
  const kcalPerKgKm = mode === "run" ? 0.95 : 0.5;
  const stepsPerKm = mode === "run" ? 1050 : 1300;
  return {
    km: Math.round(km * 10) / 10,
    mode,
    stepEquivalent: Math.round(km * stepsPerKm),
    burnKcal: Math.round(km * w * kcalPerKgKm),
  };
}

/**
 * The client-facing line. Short by contract: what it was, what it counts for, one forward
 * note. Never a lecture, never a macro dump.
 */
export function distanceReply(a: DistanceActivity, name?: string): string {
  const hi = name ? `${name}, ` : "";
  const verb = a.mode === "run" ? "run" : "walk";
  return `${hi}logged your *${a.km}km ${verb}* 👟\n\nThat's about *${a.stepEquivalent.toLocaleString()} steps* worth of movement and roughly *${a.burnKcal} kcal* burned — it counts toward today.\n\nEat normally: don't try to "save" the calories you just burned, that's how people undo a good session.`;
}
