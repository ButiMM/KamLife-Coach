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

import { foodDayIsClosed, foodDayIsReopened, trainingDayIsDeclined } from "./one-action";
import { recentClientMessagesStamped } from "./memory";
import { readHealthState } from "./health-state";
import { sastDaysBetween, sastDayKey } from "./sast";

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
      foodDayClosed: foodDayClosedNow(todays),
      trainingDeclined: todays.some(s => trainingDayIsDeclined(s.text)),
      sick,
    };
  } catch (e: any) {
    console.warn(`[HELD_CONSTRAINTS] unreadable for ${String(phone).slice(-8)}: ${e?.message || e}`);
    return { ...NO_CONSTRAINTS, sick };
  }
}

/**
 * THE SAME CONSTRAINT, READ OVER A BATCH OF TURNS ALREADY IN MEMORY (#138 recurrence, 2026-09-03).
 *
 * readHeldConstraints above answers "what did THIS client settle today" and reaches the chat log to
 * do it. Coach Health asks the same question about thousands of turns it has already read, so a
 * per-turn reader would be thousands of queries for evidence it is holding. This is the same rule
 * — foodDayIsClosed, today only — folded over rows the caller supplies.
 *
 * BOTH KEY PARTS ARE LOAD-BEARING. Drop the client and one person's "I'm done eating" silences
 * everybody else; drop the day and Tuesday's closure convicts Wednesday, which is the TODAY ONLY
 * rule this file opens with. sastDayKey owns the boundary; a hand-rolled midnight would be a
 * second answer to it.
 *
 * AND A REOPENING ENDS IT (#152, 2026-09-03). readHeldConstraints now lets the client's newest
 * explicit decision stand, so this had to learn the same thing or Coach Health would flag the very
 * replies the reversal makes correct — a meal suggestion after "I'm having dinner" would be filed
 * as a closed-day violation forever. Same two recognisers, same ordering rule: a closure is in
 * force at a moment only when no reopening sits between it and that moment.
 *
 * Returns the closure IN FORCE at the asked-about time, or null.
 */
export function foodCloseLookup(
  turns: Array<{ userId: string | null; at: number; input: string }>,
): (userId: string | null, at: number) => number | null {
  type Decision = { at: number; closed: boolean };
  const byClientDay = new Map<string, Decision[]>();
  for (const t of turns) {
    // A closure inside one utterance outranks a reopening inside it — the same tie-break
    // foodDayClosedNow makes, so the two readers cannot disagree about one message.
    const closed = foodDayIsClosed(t.input);
    if (!closed && !foodDayIsReopened(t.input)) continue;
    const key = `${t.userId}::${sastDayKey(t.at)}`;
    const list = byClientDay.get(key) || [];
    list.push({ at: t.at, closed });
    byClientDay.set(key, list);
  }
  for (const list of byClientDay.values()) list.sort((a, b) => a.at - b.at);
  return (userId, at) => {
    const list = byClientDay.get(`${userId}::${sastDayKey(at)}`);
    if (!list) return null;
    let inForce: number | null = null;
    for (const d of list) {
      if (d.at > at) break;              // said after the turn being judged — not yet true of it
      inForce = d.closed ? d.at : null;  // the latest decision at or before `at` is the one that holds
    }
    return inForce;
  };
}

/**
 * THE NEWEST EXPLICIT DECISION WINS (#152, 2026-09-03).
 *
 * This was `todays.some(foodDayIsClosed)` — once anything today closed the day, nothing could
 * open it, so a client who closed at 19:55 and then said "actually I changed my mind, I'm having
 * dinner" was refused for the rest of the night, every time they asked.
 *
 * `some` also throws away the one thing that settles a contradiction: WHEN each was said. The
 * statements are already newest-first, so the first one that is a decision about eating today is
 * the decision that stands, and everything older is history. Nothing is stored; the effective
 * state is derived from the client's own ordered words, which is what "held" has always meant here.
 *
 * A CLOSURE INSIDE A SINGLE MESSAGE OUTRANKS A REOPENING INSIDE IT. "I'll have dinner, then I'm
 * done eating" is one utterance with both, and one turn cannot be ordered against itself — so the
 * tie goes to the constraint, which is the direction that does not sell food to someone who may
 * have just stopped.
 */
function foodDayClosedNow(todaysNewestFirst: Array<{ text: string }>): boolean {
  for (const s of todaysNewestFirst) {
    if (foodDayIsClosed(s.text)) return true;
    if (foodDayIsReopened(s.text)) return false;
  }
  return false;
}

/**
 * THE TURN'S OWN WORDS COUNT TOO (#152, CTO re-adjudication on #155).
 *
 * readHeldConstraints reads chat HISTORY, and the message being handled is not in it yet. So a
 * client who closed the day earlier and then sent ONE turn carrying both the reversal and the ask
 *
 *     "I'm eating now, what should I eat?"
 *
 * was still refused: the reopening was sitting in the very message the door was answering, and the
 * door was looking everywhere except at it. live.ts already folded the current message in — but for
 * CLOSURE only (`held.foodDayClosed || foodDayIsClosed(message)`), so the fold could tighten the
 * constraint and never release it.
 *
 * SAME TIE-BREAK AS foodDayClosedNow, deliberately: within one utterance a closure outranks a
 * reopening, because a turn cannot be ordered against itself and the conservative direction is the
 * one that does not sell food to someone who may have just stopped. This is that rule applied to a
 * single newest statement, so the two readers cannot disagree about the same sentence — which is
 * the whole reason it is a function here rather than a line spelled out at each door.
 */
export function foodDayClosedWith(heldFromHistory: boolean, currentMessage: string): boolean {
  if (foodDayIsClosed(currentMessage)) return true;
  if (foodDayIsReopened(currentMessage)) return false;
  return heldFromHistory;
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
