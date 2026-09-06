import { db } from "../db";
import { turnMutation, turnEvidence } from "./chat-log";
import { users, stepLogs } from "../../shared/schema";
import { eq, desc, and, gte, lt } from "drizzle-orm";
import { neverSilentLine } from "../reply-hygiene";
import { educationNote } from "../education";
import { stepBurnKcal } from "../targets";
import { isFutureIntent, isRetroactiveMeal, mealDateLabel, mentionsNotDone, parseMealDate, reportedInSomeClause, sastDayStart } from "../utils";
import { checkPerfectDay } from "./checks";
import { detectStepLog, getStepReportModifiers, mentionedWalkWithoutCount } from "../understanding/messy-intake";
import { getDailyStepContext } from "../targets";
import { getTodayWorkoutState } from "../workout-state";
import { invalidatePatternCache } from "../cache";
import { logChat, turnAlreadyWrote } from "./chat-log";

/**
 * THE STEP WRITE — all of it, for every door (2026-07-19; bypass removed 2026-08-26, issue #63).
 *
 * One row per SAST day, keep the HIGHER count (clients re-log a growing daily total) unless it is
 * an explicit correction. Returns the count the day now HOLDS, which is not always the count that
 * was passed in — that return value is the point, and it is what a caller must put in front of the
 * client.
 *
 * This shipped as "the executor's reuse point, mirroring the routes.ts inline upsert exactly.
 * Additive — routes keeps its own path." Both halves of that sentence were the defect. A mirror is
 * a copy, and the copy drifted where it mattered most: routes carried the count from the MESSAGE
 * into its reply instead of the count from the LEDGER, so a client with 9 000 already logged who
 * sent "walked 3000 steps today" kept their 9 000 (right) and was congratulated on 3 000 (wrong).
 * Two write paths for one fact, disagreeing about what the client is told.
 *
 * Every conversational door now comes through here. If you are about to add another upsert for
 * this fact, that is the bug — call this instead, and answer the client with what it returns.
 */
export async function logStepsForUser(userId: string, steps: number, opts?: { correction?: boolean; at?: Date }): Promise<number> {
  const at = opts?.at || new Date();
  const dayStart = sastDayStart(at);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const existing = await db.select({ id: stepLogs.id, steps: stepLogs.steps })
    .from(stepLogs)
    .where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, dayStart), lt(stepLogs.loggedAt, dayEnd)))
    .limit(1);
  if (existing.length > 0) {
    if (steps > (existing[0].steps ?? 0) || opts?.correction) {
      const was = existing[0].steps ?? 0;
      await db.update(stepLogs).set({ steps }).where(eq(stepLogs.id, existing[0].id));
      // THE RAISE IS A DURABLE WRITE TOO (2026-08-27, traced through handleMessage).
      //
      // Only the INSERT below recorded a mutation, so the same client sending the same message
      // on the same day got a coach or a receipt depending on whether they had logged earlier:
      //
      //     no row yet   -> "8 500 steps — nice one. Stand on a scale this morning, before you eat."
      //     3 000 stored -> "8 500 steps — nice one."
      //
      // The day moved from 3 000 to 8 500 either way. closeCoachingTurn asks durableDomains what
      // this turn changed, got nothing, and stood down — the coaching contract's "durable write ->
      // one next move" silently exempting the commonest shape of step report, the client topping
      // up a total they already sent. Water is the precedent: its durable write is an UPDATE too.
      turnMutation(`UPDATE steps=${steps} (was ${was})`, "[STEP_LOG]");
      return steps;
    }
    // NOT a durable write: the day already holds a higher count and nothing changed. Recording a
    // mutation here would manufacture a next move out of a read, which is the opposite defect.
    return existing[0].steps ?? steps;
  }
  await db.insert(stepLogs).values({ userId, steps, loggedAt: at });
  turnMutation(`INSERT steps=${steps} at=${String(at).slice(0, 10)}`, "[STEP_LOG]");
  return steps;
}

export async function getStepStreak(userId: string): Promise<number> {
  try {
    const logs = await db.select({ loggedAt: stepLogs.loggedAt })
      .from(stepLogs).where(eq(stepLogs.userId, userId))
      .orderBy(desc(stepLogs.loggedAt)).limit(90);
    if (logs.length === 0) return 0;
    const days = new Set<string>();
    for (const log of logs) {
      const d = new Date(new Date(log.loggedAt!).getTime() + 2 * 3_600_000);
      days.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    let streak = 0;
    const checkDate = new Date(Date.now() + 2 * 3_600_000);
    const todayKey = `${checkDate.getUTCFullYear()}-${String(checkDate.getUTCMonth() + 1).padStart(2, "0")}-${String(checkDate.getUTCDate()).padStart(2, "0")}`;
    if (!days.has(todayKey)) checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    while (true) {
      const key = `${checkDate.getUTCFullYear()}-${String(checkDate.getUTCMonth() + 1).padStart(2, "0")}-${String(checkDate.getUTCDate()).padStart(2, "0")}`;
      if (!days.has(key)) break;
      streak++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    }
    return streak;
  } catch { return 0; }
}

const STEP_RESPONSES_LOW = [
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged — you are ${remaining.toLocaleString()} short of your ${target.toLocaleString()} target. A 15-minute walk before bed, or taking the stairs, closes most of that gap.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps today. ${remaining.toLocaleString()} more will hit your target. A 15-minute walk is about 1,500 steps — go.`,
  (steps: number, remaining: number, target: number) =>
    `Short day — ${steps.toLocaleString()} steps. Your target is ${target.toLocaleString()}. Set a reminder for an evening walk and hit it before you sleep.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps is a start, not a finish. ${remaining.toLocaleString()} to go. Walk while you talk on the phone. Use every gap.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged. Target: ${target.toLocaleString()}. You are ${Math.round((steps / target) * 100)}% there — finish the job tonight.`,
];

const STEP_RESPONSES_GOOD = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — almost there. ${(target - steps).toLocaleString()} more to hit target. You are close, do not let it go.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps is solid progress. ${(target - steps).toLocaleString()} away from your ${target.toLocaleString()} target — one more walk and you have it.`,
  (steps: number, target: number) =>
    `Nearly at target — ${steps.toLocaleString()} steps done. Finish line is ${(target - steps).toLocaleString()} steps away. You have come too far not to finish.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — ${Math.round((steps / target) * 100)}% of your target. ${(target - steps).toLocaleString()} steps left. A 10-minute walk finishes this off.`,
  (steps: number, target: number) =>
    `Good movement today — ${steps.toLocaleString()} steps. ${(target - steps).toLocaleString()} more to reach ${target.toLocaleString()}. Walk around the block before bed and it is yours.`,
];

const STEP_RESPONSES_TARGET = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — target hit. ✅ That daily consistency is exactly what drives results. Same again tomorrow.`,
  (steps: number, target: number) =>
    `Target crushed — ${steps.toLocaleString()} steps. ✅ Every step counts toward your goal. Keep the rhythm going tomorrow.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps done. ✅ Above target and earning it. Your body is changing because you are consistent — keep it up.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — you smashed the ${target.toLocaleString()} target. ✅ Lekker. Same energy tomorrow.`,
  (steps: number, target: number) =>
    `Target done — ${steps.toLocaleString()} steps. ✅ This is what consistency looks like. Log tomorrow and keep the streak going.`,
];

// Real-world equivalents to make calories concrete
function _stepEquivalent(burnKcal: number): string {
  if (burnKcal >= 300) return `That's a slice of pizza burned off.`;
  if (burnKcal >= 200) return `That's a Coke and a half burned off.`;
  if (burnKcal >= 120) return `That's a bag of chips burned off.`;
  if (burnKcal >= 60)  return `That's a Bar One burned off.`;
  return "";
}

export function getStepResponse(steps: number, target: number, weightKg = 75, streak = 0, weeklyAvg?: number, user?: any, isWorkoutDay = false): string {
  // DELETED 2026-08-04 (Slice 4). What stood here built, for every step log, forever: a random
  // pick from three response banks, an invented "~237 kcal burned", a "that's a Coke and a half"
  // equivalence, a goal note, a 7-day average, a streak note and an education note. Six sentences
  // and four numbers the client never said, written by a handler wearing the coach's voice.
  //
  // The coach writes the sentence now. This is the never-silent net for the turn the engine did
  // not answer — one line, their number, nothing else. The parameters stay because callers pass
  // them and the signature is not the point; the VOICE was the point, and it has one owner.
  void target; void weightKg; void streak; void weeklyAvg; void user; void isWorkoutDay;
  // THE RECEIPT, RECORDED SO THE TURN CAN CLOSE AS ONE COACH (#207). closeCoachingTurn compares
  // the reply it holds against this exact string: if nothing richer was written, the same author
  // is asked again with the canonical decision in hand and composes one line instead of two.
  const amount = steps.toLocaleString("en-ZA");
  const line = neverSilentLine("steps", { amount });
  turnEvidence({ receipt: { line, kind: "steps", amount } });
  return line;
}


export type StepReportResult =
  | { kind: "reply"; reply: string }
  | { kind: "committed"; reply: string }
  | { kind: "none" };

/**
 * The step write owner returns what it did; the router alone decides whether the turn may end.
 * That keeps the step fact composable with every other fact in the client's message.
 */
export async function handleStepReport(ctx: {
  phone: string; message: string; m: string; user: any; normalizedQuestion: boolean;
  commitStep: (reply: string) => void; hasStepPart: () => boolean;
}): Promise<StepReportResult> {
  const { phone, message, m, user, normalizedQuestion } = ctx;  // ---- STEP LOG DETECTION (direct — no GPT cost) ----
  // NOTE: If message also contains food (e.g. voice note: "I had eggs for breakfast and walked 3000 steps"),
  // we log steps but do NOT return early — let it fall through to food scanning
  // "12k steps", "8.5k steps", "12,000 steps", "12000 steps" — all valid
  // Also: "Fitbit says 8500", "health app: 9000", "steps today: 7500"
  // ALL STEP PARSING HAS ONE OWNER (Cut 5b). ~50 lines of regexes and the number arithmetic
  // lived here, beside messy-intake's own extractStepCount — two step parsers for one fact, in
  // two files. Moved whole; the guards that need this function's context stay here.
  let sd = detectStepLog(m);
  const stepModifiers = getStepReportModifiers(m);
  // A QUESTION IN ONE CLAUSE DOES NOT ERASE A REPORT IN ANOTHER (2026-08-26, issue #63). On
  // "walked 8000 steps. what should I eat?" the extractor found 8 000 and threw it away, because
  // isQuestionForm matches "should i" ANYWHERE in the bubble. Re-read per clause, only when the
  // whole-message read already said no, and the clause's own parse becomes the parse — so the
  // number stays tied to the sentence that reported it. See tracking-contract-tests, LAW 5.
  if (!sd.loggableByForm) {
    const stepClause = reportedInSomeClause(m, c => {
      const d = detectStepLog(c);
      return d.matched && d.loggableByForm && d.isExplicitLog;
    });
    if (stepClause) sd = detectStepLog(stepClause);
  }
  // Future-intent guard: "I'll walk 10k tomorrow" slips past the question check — must not log
  // today. Explicit "walked 8,000 steps" is a log even if the classifier tagged the note a
  // QUESTION because they also said "I'm exhausted" (live 2026-08-19 mixed note — steps dropped).
  if (sd.loggableByForm && !turnAlreadyWrote("steps") && !isFutureIntent(m) && !mentionsNotDone(m) && (sd.isExplicitLog || !normalizedQuestion) && sd.matched) {
    let steps = sd.steps;                       // a "8000 not 5000" correction rewrites it below
    const stepHasMovementSignal = sd.hasMovementSignal;
    if (!isNaN(steps) && steps > 0 && steps <= 100 && stepHasMovementSignal) {
      return { kind: "reply", reply: `That step count looks low — did the message cut off? Send your actual count, e.g. "8500 steps" or "walked 5km".` };
    }
    if (!isNaN(steps) && steps > 100 && steps < 100000) {
      // Weekly AVERAGE reports ("my average this week is 6,400") are a summary, not
      // today's count — logging them as today corrupts the day AND the 7-day trend.
      // Coach on the week instead; clients may opt to report a weekly average only.
      if (stepModifiers.isWeeklyAverage) {
        const wkTarget = user.stepsTarget || 8500;
        const wkDiff = steps - wkTarget;
        const wkReply = `Weekly average noted: *${steps.toLocaleString()} steps/day* vs your ${wkTarget.toLocaleString()} target — ${wkDiff >= 0 ? "on target. Strong week 🔥" : `${Math.abs(wkDiff).toLocaleString()} short. One 15-minute walk a day closes that.`}\n\n_Daily counts or a weekly-average screenshot both work — whichever is easier for you._`;
        await logChat(user.id, message, wkReply, "STEP_WEEKLY_REPORT");
        return { kind: "reply", reply: wkReply };
      }
      const baseStepsTarget = user.stepsTarget || 8500;
      // Detect whether client already worked out today so we can ease step demand.
      let workedOutToday = false;
      try { workedOutToday = (await getTodayWorkoutState(user)).alreadyDoneToday; } catch { /* non-critical */ }
      const { target, goalContext: stepGoalCtx } = getDailyStepContext(
        baseStepsTarget, user.goalType || "fat_loss", workedOutToday
      );
      const stepIsRetro = isRetroactiveMeal(message);
      const stepLoggedAt = stepIsRetro ? parseMealDate(message) : new Date();
      // Allow a downward CORRECTION ("8000 steps not 50000", "wrong, 6k steps") to overwrite the
      // day's count. Normally we keep only the HIGHER number (clients re-log a growing daily
      // total), but an explicit correction must win in either direction. For "X not Y", X is the
      // affirmed value — pull it out so the position of "steps" in the sentence doesn't matter.
      if (stepModifiers.correctedSteps !== null) {
        if (stepModifiers.correctedSteps > 100 && stepModifiers.correctedSteps < 100000) {
          steps = stepModifiers.correctedSteps;
        }
      }
      const isStepCorrection = stepModifiers.isCorrection;
      // ONE WRITE OWNER FOR THE STEP FACT (2026-08-26, issue #63). This built its own day-window
      // query and upsert — twenty lines that logStepsForUser already was, and steps.ts said so at
      // the top of itself: "mirroring the routes.ts inline upsert exactly ... Additive, routes
      // keeps its own path." A mirror is a copy, and this one had already drifted on the half that
      // reaches the client: the owner returns the count now STORED, while this path carried the
      // count from the MESSAGE into the reply. With 9 000 already logged, "walked 3000 steps
      // today" correctly left the row at 9 000 and answered "3 000 steps — nice one", quoting a
      // number the ledger does not hold. So the write moves to the owner AND the answer is built
      // from what the owner returns — that second half is the only reason the bypass mattered.
      const storedSteps = await logStepsForUser(user.id, steps, { correction: isStepCorrection, at: stepLoggedAt });
      await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
      invalidatePatternCache(user.id);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const [perfectDay, streak, recentStepLogs] = await Promise.all([
        checkPerfectDay(user.id, user.proteinTarget || 120, target),
        getStepStreak(user.id),
        db.select({ steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)))
          .orderBy(desc(stepLogs.loggedAt))
          .limit(7),
      ]);
      // Divide by days actually logged, not a flat 7 — a new client who logged 9k steps
      // on each of their first 3 days was told "7-day average: 3,857, below target".
      const weeklyAvg = recentStepLogs.length >= 3
        ? Math.round(recentStepLogs.reduce((s, r) => s + r.steps, 0) / recentStepLogs.length)
        : undefined;
      void stepGoalCtx; // used by getStepResponse via user.goalType
      const stepReply = getStepResponse(storedSteps, target, parseFloat(user.currentWeight as string || "75") || 75, streak, weeklyAvg, user, workedOutToday);
      const stepRetroNote = stepIsRetro ? `\n_Logged to ${mealDateLabel(stepLoggedAt)}._` : "";
      const stepPart = (isStepCorrection ? `Fixed ✅ — step count updated to *${storedSteps.toLocaleString()}*.\n\n` : "") + stepReply + stepRetroNote + (perfectDay || "");
      ctx.commitStep(stepPart);
      await logChat(user.id, message, stepPart, "STEP_LOG");

      // The route applies mayEndTurn after this commit. This owner never claims a mixed turn.
      return { kind: "committed", reply: stepPart };
    }
  }

  // Voice cut off: "I've walked..." with no number. Do not drop the walk.
  if (!ctx.hasStepPart() && mentionedWalkWithoutCount(message) && !(m.includes("?") || sd.isQuestionForm) && !isFutureIntent(m)) {
    ctx.commitStep(`Heard you walked — send the step count (e.g. "3000 steps") and I'll log it.`);
  }

  return { kind: "none" };
}
