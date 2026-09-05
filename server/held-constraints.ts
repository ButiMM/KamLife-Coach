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
import { db } from "./db";
import { dailyConstraints, workoutLogs, users } from "../shared/schema";
import { and, eq, desc, gte } from "drizzle-orm";
import { readHealthState } from "./health-state";
import { parseMealDate, isFutureIntent, isAskingNotReporting } from "./utils";
import { sastDayKey, sastDayStart } from "./sast";

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
    const day = sastDayKey(new Date());
    // NEWEST DECISION PER KIND, FOR TODAY ONLY. The rows are append-only, so "is the day closed"
    // is the state of the latest row rather than the existence of any row — a reopening does not
    // delete the closure, it outranks it.
    // THE PHONE IS STILL A VALID KEY, and that is not a convenience. The outbound floor calls this
    // with `recipientUser ?? null` — it has a phone and often no row — so a reader that needed a
    // client object would have returned "no constraints" there and silently switched off the one
    // gate standing between an unmigrated sender and a client who said they were done for the day.
    // The id is used when the caller has one; otherwise the user is resolved by phone, exactly as
    // this function did before it read a table.
    const uid = (client as any)?.id
      ?? (await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1))[0]?.id;
    if (!uid) return { ...NO_CONSTRAINTS, sick };
    const rows = await db.select().from(dailyConstraints)
      .where(and(eq(dailyConstraints.userId, uid), eq(dailyConstraints.day, day)))
      .orderBy(desc(dailyConstraints.saidAt), desc(dailyConstraints.id));
    const newest = (kind: string) => rows.find(r => r.kind === kind);

    // A SESSION LOGGED TODAY RESOLVES A DECLINE, and the workout ledger IS that evidence —
    // append-only, durable, and already the thing every other surface trusts about training.
    // Recording a second row to say what the first row already says would be a second answer.
    let trainingDeclined = newest("training")?.state === "asserted";
    if (trainingDeclined) {
      const done = await db.select({ id: workoutLogs.id }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, uid), gte(workoutLogs.loggedAt, sastDayStart())))
        .limit(1);
      if (done.length > 0) trainingDeclined = false;
    }
    return { foodDayClosed: newest("food")?.state === "asserted", trainingDeclined, sick };
  } catch (e: any) {
    console.warn(`[HELD_CONSTRAINTS] unreadable for ${String(phone).slice(-8)}: ${e?.message || e}`);
    return { ...NO_CONSTRAINTS, sick };
  }
}

/**
 * RECORD WHAT THEY JUST RULED OUT, WHEN THEY SAY IT (#194).
 *
 * The reader above used to rebuild today's constraints by replaying chat history, and that replay
 * is `ORDER BY created_at DESC LIMIT 24`. Reproduced on real PostgreSQL: a client closed their
 * food day and declined training, had twenty-six ordinary messages, and both constraints were
 * gone — with the client having changed nothing. The engaged client is the one it failed for.
 *
 * NO SECOND PARSER. foodDayIsClosed, foodDayIsReopened and trainingDayIsDeclined are still the
 * only things that read a message; this only decides where the answer is kept. The tie-break
 * inside one utterance is foodDayClosedNow's, unchanged and shared, so the two cannot disagree
 * about the same sentence.
 *
 * Fails soft. A constraint we could not record is the behaviour we had yesterday, and the turn
 * itself must not die because bookkeeping did.
 */
/**
 * WHAT THIS SENTENCE ASSERTS ABOUT TODAY — the whole rule, in one pure place.
 *
 * Exported so the writer below and the contract suite share ONE definition. A test that folds its
 * own copy of this over a history grades a mirror, and a mirror is free to drift from the thing it
 * claims to be about — which is precisely how a constraint suite could stay green while the
 * product forgot the constraint.
 *
 * Returns [] for anything that is not a decision about TODAY. A closure inside one utterance still
 * outranks a reopening inside it: a turn cannot be ordered against itself, and the conservative
 * direction is the one that does not sell food to someone who may have just stopped.
 */
export function constraintsAssertedBy(message: string): Array<{ kind: string; state: string }> {
  // A CONSTRAINT IS ABOUT TODAY, SO A SENTENCE ABOUT ANOTHER DAY ASSERTS NOTHING (#194).
  //
  // "yesterday I was not eating anything else" and "I was done eating last night" both satisfy
  // foodDayIsClosed — the same words in the past tense. While the state was re-derived from a
  // 24-message window that was survivable noise; recorded, it would close TODAY on the strength
  // of a story about last night, permanently. parseMealDate is the temporal owner every food path
  // already asks which day a sentence is about, and isFutureIntent is the shared floor for a plan.
  //
  // AND ASKING IS NOT DECIDING. "should I stop eating for today?" satisfies foodDayIsClosed — a
  // real over-fire, and one that predates this change: the old reader would have closed the day on
  // that question too, for as long as the window held it. isAskingNotReporting is the floor this
  // codebase already shares for exactly that distinction, and its documented bias is the right one
  // here — answering a report as a question is recoverable; silently closing someone's food day
  // because they asked about it is not.
  if (isAskingNotReporting(message)) return [];
  // THE DAY AND FUTURE GUARDS APPLY TO THE ASSERTIONS, NOT THE RELEASE — and the asymmetry is the
  // point, twice over.
  //
  // First, the safe directions differ: wrongly asserting a constraint SILENCES the coach for the
  // rest of someone's day, while wrongly releasing one only lets it speak. Second, the release
  // recogniser already owns these guards. foodDayIsReopened was built with its own future-day and
  // zero-food tests (#155); parseMealDate is a MEAL-date resolver, not a general "which day is
  // this sentence about" oracle, and it has heuristics of its own — asked before dawn it reads
  // "I'm having dinner tonight after all" as YESTERDAY's dinner. Gating the release on it took the
  // reversal away, which is the whole feature #152 exists to give back, and locked a client who
  // changed their mind out until midnight again.
  const asserts = (m: string) => {
    const named = parseMealDate(m);
    if (named && sastDayKey(named) !== sastDayKey(new Date())) return false;
    return !isFutureIntent(m);
  };
  const rows: Array<{ kind: string; state: string }> = [];
  if (asserts(message) && foodDayIsClosed(message)) rows.push({ kind: "food", state: "asserted" });
  else if (foodDayIsReopened(message)) rows.push({ kind: "food", state: "released" });
  if (asserts(message) && trainingDayIsDeclined(message)) rows.push({ kind: "training", state: "asserted" });
  return rows;
}

export async function recordDailyConstraint(
  client: { id: string } | null | undefined,
  message: string,
  sourceMessageId?: string,
): Promise<void> {
  if (!client?.id) return;
  // A CONSTRAINT IS ABOUT TODAY, SO A SENTENCE ABOUT ANOTHER DAY ASSERTS NOTHING (#194).
  //
  // "yesterday I was not eating anything else" and "I was done eating last night" both satisfy
  // foodDayIsClosed — they are the same words in the past tense. While the state was re-derived
  // from a 24-message window that was survivable noise; recorded, it would close TODAY on the
  // strength of a story about last night, permanently. parseMealDate is the temporal owner every
  // food path already asks which day a sentence is about, and isFutureIntent is the shared floor
  // for a plan. Neither is new, and neither reads the constraint — they only say whether this
  // sentence is about today at all.
  //
  // AND ASKING IS NOT DECIDING. "should I stop eating for today?" satisfies foodDayIsClosed — a
  // real over-fire, and one that predates this change: the old reader would have closed the day on
  // that question too, for however long the window held it. isAskingNotReporting is the floor this
  // codebase already shares for exactly this distinction, and its documented bias is the right one
  // here — answering a report as a question is recoverable, silently closing someone's food day
  // because they asked about it is not.
  const rows = constraintsAssertedBy(message);
  if (rows.length === 0) return;
  const day = sastDayKey(new Date());
  for (const r of rows) {
    await db.insert(dailyConstraints)
      .values({ userId: client.id, day, kind: r.kind, state: r.state, via: "said",
        sourceMessageId: sourceMessageId || null })
      .onConflictDoNothing()
      .catch((e: any) => console.warn("[HELD_CONSTRAINTS] not recorded:", e?.message || e));
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
 * foodDayClosedNow IS GONE (#194). It folded the newest explicit decision out of today's chat
 * history, and it was the last thing reading that window for this purpose: the decision is now
 * recorded when it is made, so there is nothing left to re-derive. Its rule survives unchanged in
 * recordDailyConstraint above — a closure inside one utterance still outranks a reopening inside
 * it, because a turn cannot be ordered against itself and the conservative direction is the one
 * that does not sell food to someone who may have just stopped. Same rule, one place, written
 * down once rather than replayed.
 */

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
