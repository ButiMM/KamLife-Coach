/**
 * DATA EXPORT — the client's own record, on request.
 *
 * Two reasons, and the second is the one that matters commercially.
 *
 * POPIA gives a data subject the right of ACCESS, not just erasure. Deletion was built; access
 * was not, so the compliance story had a hole in it while the landing page said "POPIA
 * protected."
 *
 * (2026-07-28, from the distribution review: "your entire relationship with every client is
 * held inside someone else's app. If Meta suspends the number tomorrow, what does a client
 * still have?") Today: nothing. This is the cheapest hedge that exists — a client who can pull
 * their own history is a client who can follow you somewhere else.
 *
 * DELIVERED AS TEXT, IN THE THREAD. Deliberately not a download link. A hosted file of somebody's
 * weight history and health notes is a leak surface with a URL; the WhatsApp thread is a channel
 * they already control and already contains this information. The `---` separators split it into
 * several WhatsApp messages, which is also how a person actually saves things: forward the one
 * they want.
 *
 * Pure — no DB. The caller gathers, this formats. Unit-tested.
 */

export interface ExportProfile {
  name?: string | null;
  goalType?: string | null;
  startedAt?: Date | string | null;
  heightCm?: number | null;
  startWeightKg?: number | null;
  currentWeightKg?: number | null;
  calorieTarget?: number | null;
  proteinTarget?: number | null;
  stepsTarget?: number | null;
}

export interface ExportData {
  profile: ExportProfile;
  /** Newest first. */
  weights: Array<{ at: Date | string; kg: number }>;
  /** Day totals, newest first. */
  foodDays: Array<{ day: string; kcal: number; protein: number; meals: number }>;
  workouts: number;
  /** Total days on which anything at all was logged. */
  activeDays: number;
}

const GOAL_WORDS: Record<string, string> = {
  fat_loss: "Fat loss",
  muscle_gain: "Muscle gain",
  maintenance: "Maintenance",
  wellness: "General health",
};

function dayOnly(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toISOString().slice(0, 10);
}

/** How many rows of each list a WhatsApp message can carry before it stops being readable. */
export const EXPORT_ROW_LIMIT = 30;

export function formatExport(d: ExportData): string {
  const p = d.profile;
  const fn = (p.name || "").split(" ")[0];
  const goal = GOAL_WORDS[String(p.goalType || "")] || "Not set";

  const change = typeof p.startWeightKg === "number" && typeof p.currentWeightKg === "number"
    ? p.currentWeightKg - p.startWeightKg
    : null;
  const changeLine = change === null
    ? ""
    : `\nChange: *${change <= 0 ? "" : "+"}${change.toFixed(1)}kg*`;

  const header = `📄 *Your KamLife record*\n\nEverything I hold on you, ${fn || "as requested"}. Save or forward this — it's yours.`;

  const profile = `*PROFILE*
Name: ${p.name || "—"}
Goal: ${goal}
Started: ${dayOnly(p.startedAt)}
Height: ${p.heightCm ? `${p.heightCm}cm` : "—"}
Starting weight: ${p.startWeightKg ? `${p.startWeightKg}kg` : "—"}
Current weight: ${p.currentWeightKg ? `${p.currentWeightKg}kg` : "—"}${changeLine}

*YOUR TARGETS*
Calories: ${p.calorieTarget || "—"}
Protein: ${p.proteinTarget ? `${p.proteinTarget}g` : "—"}
Steps: ${p.stepsTarget ? p.stepsTarget.toLocaleString() : "—"}`;

  const totals = `*TOTALS*
Days you logged something: *${d.activeDays}*
Training sessions: *${d.workouts}*
Days of food logged: *${d.foodDays.length}*
Weigh-ins: *${d.weights.length}*`;

  const weights = d.weights.length
    ? `*WEIGH-INS* (newest first)\n${d.weights.slice(0, EXPORT_ROW_LIMIT).map(w => `${dayOnly(w.at)} — ${Number(w.kg).toFixed(1)}kg`).join("\n")}${d.weights.length > EXPORT_ROW_LIMIT ? `\n_…and ${d.weights.length - EXPORT_ROW_LIMIT} earlier._` : ""}`
    : `*WEIGH-INS*\nNone recorded.`;

  const food = d.foodDays.length
    ? `*FOOD BY DAY* (newest first)\n${d.foodDays.slice(0, EXPORT_ROW_LIMIT).map(f => `${f.day} — ${Math.round(f.kcal)} kcal, ${Math.round(f.protein)}g protein (${f.meals} meal${f.meals === 1 ? "" : "s"})`).join("\n")}${d.foodDays.length > EXPORT_ROW_LIMIT ? `\n_…and ${d.foodDays.length - EXPORT_ROW_LIMIT} earlier days._` : ""}`
    : `*FOOD BY DAY*\nNone recorded.`;

  const footer = `That's the lot. If you want it gone instead, send *delete my data* — it's permanent and I'll ask you to confirm first.`;

  return [header, profile, totals, weights, food, footer].join("\n\n---\n\n");
}

/** Does this message ask for their data? Kept beside the formatter so both move together. */
export function asksForExport(m: string): boolean {
  const s = (m || "").toLowerCase();
  if (/\bdelete\b|\bforget me\b|\berase\b/.test(s)) return false; // erasure is a different branch
  // A REQUEST, not a mention. "my data shows I'm doing well" is conversation, not a POPIA
  // request — so a bare "my data" only counts when the whole message is the ask.
  if (/^\s*(?:my\s+data|my\s+records?|my\s+history)\s*(?:please)?[.!]?\s*$/.test(s)) return true;
  return /\b(?:export|download|send me|give me|email me|copy of)\b[^.!?]{0,20}\b(?:my\s+)?(?:data|records?|history|information|info)\b|\bpopia\s+(?:export|access|request)\b|\bdata\s+(?:export|request)\b/.test(s);
}
