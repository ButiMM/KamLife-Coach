/**
 * HELD CONSTRAINTS — what the client already ruled out today (2026-08-25, P0-4b).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ITS OWN OWNER
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `foodDayIsClosed` and `trainingDayIsDeclined` are the twin readers of an explicit constraint —
 * "I'm not eating anything else today", "I'm not training today". Both existed. Neither was HELD:
 *
 *   • foodDayIsClosed was re-derived inline in the morning job, from its own copy of the query.
 *   • trainingDayIsDeclined was computed at the reactive door into `_isWorkoutRefusal` — an
 *     underscore-prefixed local that nothing read — and DayState had no field to carry it.
 *
 * So the constraint lived for exactly one expression and then evaporated. A client who said at
 * 08:00 "I'm not training today" got told at 19:00 that the session was still not done, and a
 * client who closed food at 19:55 could still be sent a dinner suggestion at 20:00, because every
 * later surface re-decided from the ledger and the ledger does not record what someone SAID.
 *
 * One reader, two consumers: the proactive decision (so the ladder never chooses the ask) and the
 * outbound floor (so no sender can contradict it by hand). Those are deliberately different jobs
 * — the first stops us choosing it, the second stops anyone else saying it anyway.
 *
 * TODAY ONLY. A constraint is a statement about a day, not a standing preference; "I'm not
 * training today" said on Tuesday must not silence Wednesday. That is what `doNotMention` is for.
 */

import { foodDayIsClosed, trainingDayIsDeclined } from "./one-action";
import { recentClientMessagesStamped } from "./memory";
import { readHealthState } from "./health-state";
import { sastDaysBetween } from "./sast";

export interface HeldConstraints {
  /** They said they are done eating for today. */
  foodDayClosed: boolean;
  /** They said they are not training today. */
  trainingDeclined: boolean;
  /** Durable illness state — not a keyword scan. Rest outranks everything but silence. */
  sick: boolean;
}

export const NO_CONSTRAINTS: HeldConstraints = { foodDayClosed: false, trainingDeclined: false, sick: false };

/**
 * Read what today's own words already settled.
 *
 * Fails OPEN — an unreadable chat history must not invent a constraint that silences the coach.
 * The failure mode of a false `true` here is a client who never hears from us again on a day they
 * said nothing about; the failure mode of a false `false` is the message we were already sending.
 */
export async function readHeldConstraints(
  phone: string,
  client?: { profileNotes?: string | null } | null,
): Promise<HeldConstraints> {
  const sick = client ? !!readHealthState(client).isSick : false;
  try {
    const stamped = await recentClientMessagesStamped(phone);
    const todays = stamped.filter(s => sastDaysBetween(s.at) === 0);
    return {
      foodDayClosed: todays.some(s => foodDayIsClosed(s.text)),
      trainingDeclined: todays.some(s => trainingDayIsDeclined(s.text)),
      sick,
    };
  } catch (e: any) {
    console.warn(`[HELD_CONSTRAINTS] unreadable for ${String(phone).slice(-8)}: ${e?.message || e}`);
    return { ...NO_CONSTRAINTS, sick };
  }
}

// ── WHAT AN OUTBOUND MESSAGE IS ASKING FOR ───────────────────────────────────────────────────
//
// Deliberately narrow, and deliberately about the ASK rather than the topic. "You ate well today"
// mentions food and asks for nothing; "get to 120g tonight" asks for a meal. Only the second can
// contradict a closed food day. A topic matcher here would block half the product's recognition.

/**
 * An instruction to eat something MORE, in what is left of today.
 *
 * The scope is the whole point, and the first draft of this got it wrong: it matched any eating
 * verb near any food noun, which would have blocked Sunday's meal plan ("Breakfast: eggs + toast")
 * and the shopping list from a client who happened to close their food day that afternoon — an
 * artefact for the week ahead, suppressed by a constraint about tonight.
 *
 * Two things are deliberately NOT here. A request to LOG is not a request to eat: a closed food
 * day says nothing about telling us what was already eaten, and blocking that would cost the day's
 * record. And a plan for another day is not an ask about this one.
 */
export function asksForFoodToday(text: string): boolean {
  const t = String(text || "");
  return /\b(?:make|have|get|add|grab|cook|order|eat)\b[^.!?\n]{0,40}\b(?:next meal|one more (?:proper )?meal|another meal|something (?:to eat|else))\b/i.test(t)
    || /\b(?:eat|have|get|add|grab)\b[^.!?\n]{0,40}\b(?:tonight|before bed|this evening|right now)\b/i.test(t)
    || /\bprotein\b[^.!?\n]{0,40}\b(?:tonight|before bed|at your next meal)\b/i.test(t)
    || /\bget to \d+\s*g\b/i.test(t);
}

/** An instruction to train today. Not "you trained", not "tomorrow's session". */
export function asksForTrainingToday(text: string): boolean {
  const t = String(text || "");
  if (/\b(?:tomorrow|next week|yesterday)\b/i.test(t) && !/\btoday|tonight\b/i.test(t)) return false;
  return /\b(?:do|get|finish|start|complete|hit)\b[^.!?\n]{0,40}\b(?:today'?s session|the session|your session|your workout|today'?s workout|a session)\b/i.test(t)
    || /\bone session\b[^.!?\n]{0,40}\b(?:today|tonight|before)\b/i.test(t)
    || /\btraining day and the session is still not done\b/i.test(t)
    || /\b(?:train|get to the gym)\b[^.!?\n]{0,30}\b(?:today|tonight)\b/i.test(t);
}
