import {
  db, users, stepLogs, workoutLogs, mealLogs,
  eq, gte, and, desc, sql,
  sendWhatsApp, canSendProactive, canSendRoutineNudge, recordProactiveSend, claimDailySlot,
  getActiveClients, isPaused, dayStart, getTodayLogs,
  TRAINING_SCHEDULES, todaySAST,
} from "../shared";
import { readHealthState } from "../../health-state";
import { sendWhatsAppButtons } from "../../twilio-interactive";
import { canonicalNextMove } from "../proactive-decision";
import { sastHour } from "../../sast";

/**
 * WHAT HAPPENED TODAY, WITH NOTHING ASKED FOR (2026-08-25, P0-4b).
 *
 * Pure and instruction-free on purpose. Everything this used to say AFTER the facts — "get to
 * 120g tonight", "push to 8,500 tomorrow", "log tonight's food", "one more thing before bed" —
 * was a second action ladder deciding from the ledger, which cannot know what the client SAID.
 * It is why a client who closed food at 19:55 got a protein target at 20:00.
 *
 * The facts still belong here. The instruction comes from canonicalNextMove.
 */
export function eveningRecognition(f: {
  name: string;
  workedOut: boolean;
  proteinLogged: number;
  proteinTarget: number;
  foodLogged: boolean;
  steps: number;
  stepsTarget: number;
  sick: boolean;
}): string {
  if (f.sick) return `Rest up, ${f.name}. No targets today. Your data is saved — we pick up when you're better.`;

  const done: string[] = [];
  if (f.workedOut) done.push("session done");
  if (f.proteinLogged > 0) done.push(`${f.proteinLogged}g protein`);
  else if (f.foodLogged) done.push("food logged");
  if (f.steps > 0) done.push(`${f.steps.toLocaleString()} steps`);

  if (done.length === 0) return `${f.name}, nothing logged yet today.`;

  const clean = f.workedOut
    && f.steps >= f.stepsTarget
    && f.proteinTarget > 0 && f.proteinLogged >= Math.round(f.proteinTarget * 0.9);
  return clean
    ? `${f.name}, clean day — ${done.join(", ")}.`
    : `${f.name}, today: ${done.join(", ")}.`;
}

export async function runEveningAccountability(): Promise<void> {
  console.log("[SCHEDULER] JOB: Evening accountability");
  const clients = await getActiveClients();
  const todayStart = dayStart(0);

  for (const client of clients) {
    if (isPaused(client)) continue;
    // Routine evening accountability — eases off as a client goes quiet so we don't
    // stack onto the morning comeback flow (which owns 3+ day silent users) and so we
    // stop paying to message people who have checked out. Engaged users (daysSilent ≤ 1)
    // are unaffected. Also enforces the 1/day cap and the global pause.
    if (!canSendRoutineNudge(client)) continue;
    try {
      const name = (client.name || "there").split(" ")[0];
      const phone = client.phoneNumber;
      const todayLogs = await getTodayLogs(client.id);

      // THE EMPTY DAY IS A DECISION LIKE ANY OTHER (2026-08-25, P0-4b). These two branches were a
      // ladder of their own: a day-one client got "Reply *1* … get it done tonight" — a training
      // instruction chosen from account age — and everyone else got "tell me what you ate". The
      // first duplicated the onboarding sequence's Day 1 message, which is that job's to own; the
      // second is `log`, which chooseAction has ranked since Cut 6. Both now come from there, so
      // a client who told us at 08:00 that they are not training tonight is not told to train.
      if (todayLogs.length === 0) {
        const empty = await canonicalNextMove(client, { hour: sastHour() });
        if (empty.line && await claimDailySlot(client.id, "evening")) {
          await sendWhatsApp(phone, `${name}, haven't heard from you today — no stress.\n\n${empty.line}`);
        }
        continue;
      }

      if (!canSendProactive(client.id)) continue;

      // DURABLE, NOT A KEYWORD SCAN (2026-08-18, Issue #49 sweep — same demotion morning got).
      // This asked isSickOrInjuredToday(), a regex over today's inbound messages, and like
      // morning's copy it could only ever be wrong here: sick-flow.ts writes paused_until beside
      // sick_until and this job returns on isPaused() at line 18, so a genuinely ill client never
      // reaches it. SICK_PATTERNS also fires on "rest day", "skip gym" and someone else being ill.
      const sick = readHealthState(client).isSick;
      const protTarget = client.proteinTarget || 120;
      const stepsTarget = client.stepsTarget || 8500;
      const trainingDays = client.trainingDaysPerWeek || 3;
      const dow = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
      const isTrainingDay = (TRAINING_SCHEDULES[trainingDays] || TRAINING_SCHEDULES[3]).includes(dow);

      const [mealSum] = await db.select({
        todayCal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
        todayProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, todayStart)));
      const todayCal = mealSum?.todayCal || 0;
      const todayProt = mealSum?.todayProt || 0;

      const [todayWorkout] = await db.select({ id: workoutLogs.id })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart), eq(workoutLogs.workoutCompleted, true)))
        .limit(1);

      const [todayStep] = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart)))
        .orderBy(desc(stepLogs.loggedAt)).limit(1);

      const workedOut = !!todayWorkout;
      const stepCount = todayStep?.steps ?? 0;

      // ── ONE COACH AT 20:00 (2026-08-25, P0-4b) ──────────────────────────────────────────────
      //
      // What was here: a seven-branch cascade over a score of (food + workout + steps), plus a
      // separate dinner-suggestion ladder above it with its own goal switch and protein-gap
      // arithmetic. Between them they could say "get to 120g tonight", "push to 8,500 tomorrow",
      // "training day and the session is still not done", "carry protein into tomorrow's first
      // meal" and "one more thing before bed" — five different next moves, none of which had ever
      // heard of chooseAction, all decided from the ledger alone.
      //
      // The ledger records what a client DID. It cannot record what they SAID. That is the whole
      // defect: "I'm not training today" at 08:00 and "the session is still not done" at 19:00
      // were each correct by their own inputs, and the client heard a coach who was not listening.
      //
      // Now: the facts are recognition, and the single instruction is the canonical one — which
      // reads the same held constraints the morning brief reads.
      const move = await canonicalNextMove(client, { hour: sastHour() });
      const recap = eveningRecognition({
        name,
        workedOut,
        proteinLogged: todayProt,
        proteinTarget: protTarget,
        foodLogged: todayCal > 0,
        steps: stepCount,
        stepsTarget,
        sick,
      });

      // THE BUTTONS SURVIVE; THE DECISION TO PRESS DOES NOT. A one-tap "Doing it tonight / Swap to
      // tomorrow / Rest day today" is a real capability and the only place the client can hand us
      // a schedule decision. It used to fire on `isTrainingDay` — the fixed weekday schedule —
      // which is a calendar, not a coach. It now fires when, and only when, the decision owner has
      // actually chosen `train`, so a declined or sick day never renders it.
      if (move.action.kind === "train" && isTrainingDay) {
        if (await claimDailySlot(client.id, "evening")) {
          await sendWhatsAppButtons(phone, `${recap}\n\n${move.line}`, [
            "Doing it tonight",
            "Swap to tomorrow",
            "Rest day today",
          ]);
        }
        continue;
      }

      const msg = [recap, move.line].filter(Boolean).join("\n\n");
      if (msg && await claimDailySlot(client.id, "evening")) { await sendWhatsApp(phone, msg); }
    } catch (err) {
      console.error(`[SCHEDULER] Evening accountability error — ${client.phoneNumber}:`, err);
    }
  }
}
