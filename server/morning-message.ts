/**
 * THE MORNING MESSAGE — one composer, pure, dependency-free.
 *
 * Morning is recognition + current-day context + one canonical next move.
 * It must not create a second progress clock or a second behavioural authority.
 */

import { carriesDirective } from "./brain/reply-verifier";

export type MorningTrajectory = "ON_A_RUN" | "ON_TRACK" | "RECOVERING" | "STRUGGLING" | "DISENGAGED";

/**
 * Recognition only. The old implementation exposed a 28-day trajectory as client-facing
 * coaching ("4 sessions in 4 weeks", "fresh page"). That was a second clock beside the
 * calendar-week decision and could frame a completed week as failure.
 *
 * The trajectory may still be computed for internal recognition, but it no longer gets to
 * score the client in the morning. Re-entry recognition is the only closing that survives.
 */
export function morningClosingLine(
  trajectory: MorningTrajectory,
  ctx: { activelyEngaged: boolean; completedSessions28: number },
): string {
  void ctx.completedSessions28;
  if (ctx.activelyEngaged) return "";
  switch (trajectory) {
    case "RECOVERING":
      return `\n\n_Good to have you back. This week counts._`;
    case "DISENGAGED":
      return `\n\n_Today starts from where you are. Nothing is reset._`;
    default:
      return "";
  }
}

export interface MorningInputs {
  firstName: string;
  targetFixLine: string;
  identityLine: string;
  streakLine: string;
  workoutLine: string;
  yesterdayLine: string;
  /** Status/recognition for today; it may not become a second behavioural instruction. */
  todayLines: string[];
  closingLine: string;
  /** The only behavioural instruction from the canonical decision. */
  decisionLine: string;
  /** Used only when the canonical decision is CONTINUE/hold. */
  breakfastAsk: string;
  situationLine?: string;
  adaptLine: string;
  sickYesterday: boolean;
}

/**
 * One morning composer. Recognition and status may inform the client; `decisionLine` (or the
 * existing hold ask) is the only behavioural instruction supplied by this function.
 */
export function composeMorning(i: MorningInputs): string {
  const greeting = `Morning ${i.firstName}.`;

  if (i.sickYesterday) {
    return join([
      `${greeting} Hope you're feeling better. When you're ready, just say Hi and we pick up from where you left off.`,
      i.adaptLine,
    ]);
  }

  const opening = [greeting, i.identityLine, i.streakLine, i.workoutLine, i.yesterdayLine]
    .map(recognitionOnly)
    .filter(Boolean)
    .join(" ");

  // TODAY IS STATUS, NOT A SECOND DECISION. A line such as "Reply 1 for your workout" or
  // "stay on food and steps" belongs to the canonical decision path instead.
  const today = i.todayLines.map(recognitionOnly).filter(Boolean).join("\n");
  const todayBlock = today ? (i.adaptLine ? `${today}\n\n${i.adaptLine}` : today) : i.adaptLine;

  return join([
    i.targetFixLine ? i.targetFixLine.trim() + " " + opening : opening,
    recognitionOnly(i.situationLine || ""),
    todayBlock,
    recognitionOnly(i.closingLine),
    i.decisionLine || i.breakfastAsk,
  ]);
}

/** Recognition filter reused for all non-decision prose. */
function recognitionOnly(part: string): string {
  const text = (part || "").trim();
  if (!text) return "";
  const italic = text.length > 2 && text.startsWith("_") && text.endsWith("_");
  const body = italic ? text.slice(1, -1) : text;
  const kept = body.split(/(?<=[.!?])\s+/).filter((sentence) => {
    if (!carriesDirective(sentence)) return true;
    console.log(`[MORNING_AUTHORITY] dropped an instruction from recognition/status prose: ${sentence.trim().slice(0, 70)}`);
    return false;
  }).join(" ").trim();
  if (!kept) return "";
  return italic ? `_${kept}_` : kept;
}

const join = (parts: string[]) => parts.map(p => (p || "").trim()).filter(Boolean).join("\n\n");

export function yesterdayObservation(
  o: { foodLogged: boolean; proteinLogged: number; proteinTarget: number; numbersLow: boolean },
): string {
  if (!o.foodLogged) return `No food logged yesterday — today starts now.`;
  if (o.proteinLogged <= 0) return `Food was logged yesterday but protein wasn't tracked.`;
  const hit = o.proteinTarget > 0 && o.proteinLogged >= o.proteinTarget * 0.9;
  if (o.numbersLow) {
    return hit
      ? `Great protein yesterday — that's the muscle looked after. 💪`
      : `A little short on protein yesterday.`;
  }
  return hit
    ? `${o.proteinLogged}g protein logged yesterday — target hit.`
    : `${o.proteinLogged}g protein logged yesterday, against a ${o.proteinTarget}g target.`;
}

/** One-tap breakfast replay — source is the meal row, never a conversational bubble. */
export function breakfastReplayLine(row: {
  items?: unknown;
  rawMessage?: string | null;
  mealLabel?: string | null;
}): string {
  const names = mealItemNames(row.items);
  if (names.length > 0) return names.join(", ");
  const raw = String(row.rawMessage || "").trim();
  if (!isStandaloneMealText(raw)) return "";
  return raw
    .replace(/\b(for breakfast|breakfast was|this morning|i had|i ate|had|ate|eating|having|i |my )\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mealItemNames(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const names: string[] = [];
  for (const it of items) {
    if (typeof it === "string" && it.trim()) names.push(it.trim());
    else if (it && typeof it === "object" && "name" in it) {
      const n = String((it as { name?: unknown }).name || "").trim();
      if (n) names.push(n);
    }
  }
  return names;
}

function isStandaloneMealText(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[?\n]/.test(t)) return false;
  if (/\b(what'?s the plan|guide (for )?the rest|that day is today|for me)\b/i.test(t)) return false;
  return true;
}
