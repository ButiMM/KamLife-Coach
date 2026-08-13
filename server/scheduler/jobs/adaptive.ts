/**
 * ADAPTIVE TARGETS — the daily job that actually MOVES a client's numbers.
 *
 * (2026-07-27) The adaptive engine was written and tested but not wired, which is the exact
 * failure the founder called out: built, not integrated. This is the wiring. It runs each
 * morning BEFORE the morning check-in so the day's message already reflects today's real
 * targets.
 *
 * It reads the client's actual state (sick marker, 14-day weight trend, 7-day step average,
 * weeks stalled), asks the pure engine what today's targets should be, PERSISTS them, and
 * sends ONE plain line only when something changed. Silence is the default — a target that
 * moves every day is noise.
 */

import { db, users, weightLogs, stepLogs, eq, and, gte, desc, sql, getActiveClients, sendWhatsApp, saveState, todaySAST, hasRunToday } from "../shared";
import { adaptTargets, weightTrendUsable, type AdaptiveInput } from "../../adaptive-targets";
import { gatherReportData } from "../../report-card";

/** Weeks of no meaningful weight movement (<0.3kg swing) from a series, newest first. */
function stalledWeeksFrom(weights: number[]): number {
  if (weights.length < 3) return 0;
  const newest = weights[0];
  let weeks = 0;
  for (const w of weights.slice(1)) {
    if (Math.abs(newest - w) < 0.3) weeks++;
    else break;
  }
  return weeks;
}

export async function runAdaptiveTargets(): Promise<void> {
  const today = todaySAST();
  if (hasRunToday("adaptive_targets", today)) return;

  const clients = await getActiveClients();
  let moved = 0;
  for (const c of clients) {
    try {
      const notes = String(c.profileNotes || "");
      const sickUntil = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/)?.[1];
      const sickSince = notes.match(/sick_since:(\d{4}-\d{2}-\d{2})/)?.[1];
      const sick = !!sickUntil && new Date(sickUntil) >= new Date(today);
      const daysSick = sickSince ? Math.floor((Date.now() - new Date(sickSince).getTime()) / 86_400_000) : 0;
      // Recovering = the sick window closed within the last 3 days.
      const recovering = !sick && !!sickUntil
        && (Date.now() - new Date(sickUntil).getTime()) / 86_400_000 <= 3;

      // 28 days of weigh-ins, newest first — enough for a trend and a stall read.
      const wRows = await db.select({ w: weightLogs.weight, at: weightLogs.loggedAt })
        .from(weightLogs)
        .where(and(eq(weightLogs.userId, c.id), gte(weightLogs.loggedAt, new Date(Date.now() - 28 * 86_400_000))))
        .orderBy(desc(weightLogs.loggedAt)).limit(12);
      const weights = wRows.map(r => parseFloat(String(r.w))).filter(n => Number.isFinite(n));
      let weeklyKgChange: number | undefined;
      if (weights.length >= 2) {
        // A TREND NEEDS A RECENT NUMBER (2026-07-30 live). Two weigh-ins anywhere inside 28 days
        // used to be enough, so a client who last stood on a scale three weeks ago — before and
        // during an illness — was told "you're gaining quicker than muscle can build" and had his
        // food cut 6%. The same morning message asked him to weigh himself because "it's been a
        // while": it knew the data was stale and used it anyway. Illness moves weight through
        // fluid and inactivity, which is exactly the reading this then acts on.
        // AND THE ILLNESS MUST NOT BE INSIDE IT (2026-07-30, founder: "I've been sick for three
        // weeks. It didn't even take that into consideration"). Illness EXPIRES from the state
        // (sick_until, plus 3 days of "recovering") while the weight it produced keeps driving
        // decisions for 28 — so the job read sick-weight as diet-weight and cut a recovering
        // man's calories.
        //
        // The rule now lives in adaptive-targets.ts and is shared with the provenance gate, so a
        // reply can never assert a trend this job has refused to compute. It used to be inline
        // here, reachable by nobody else, which is exactly how the two disagreed.
        const newestAt = new Date(wRows[0].at as Date).getTime();
        const oldestAt = new Date(wRows[wRows.length - 1].at as Date).getTime();
        const spanDays = Math.max(1, (newestAt - oldestAt) / 86_400_000);
        const verdict = weightTrendUsable({
          count: weights.length, newestAt, oldestAt, now: Date.now(),
          sickSince: sickSince ? new Date(sickSince).getTime() : undefined,
          sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,
        });
        if (verdict.usable) {
          weeklyKgChange = ((weights[0] - weights[weights.length - 1]) / spanDays) * 7;
        }
      }

      const [stepAgg] = await db.select({ avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int` })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, c.id), gte(stepLogs.loggedAt, new Date(Date.now() - 7 * 86_400_000))));
      const avgSteps7d = Number(stepAgg?.avg || 0) || undefined;

      // Fail-open: if the aggregate read fails, the engine sees `undefined` and treats intake as
      // UNKNOWN, which holds the target rather than adapting on a number we could not read.
      let intake: { avgKcal: number; distinctDaysLogged: number } | undefined;
      try { intake = await gatherReportData(c, "week"); }
      catch (e) { console.warn(`[ADAPTIVE] intake read failed for ${c.id?.slice(-6)}:`, (e as Error)?.message); }

      const input: AdaptiveInput = {
        baseCalories: Number(c.calorieTarget) || 0,
        baseProtein: Number(c.proteinTarget) || 0,
        baseSteps: Number(c.stepsTarget) || 0,
        goalType: c.goalType || "fat_loss",
        weightKg: parseFloat(String(c.currentWeight || "")) || 75,
        sick, daysSick, recovering, weeklyKgChange,
        stalledWeeks: stalledWeeksFrom(weights),
        avgSteps7d,
        // WHAT THEY ACTUALLY ATE. Reusing the one weekly aggregate rather than adding a second
        // SUM over mealLogs — a divergent divisor here would let the engine adapt on a number
        // that disagrees with the one the report card shows the client.
        avgKcal7d: intake?.avgKcal,
        loggedDays7d: intake?.distinctDaysLogged,
      };
      if (!(input.baseCalories > 0 && input.baseProtein > 0)) continue; // no baseline yet

      const out = adaptTargets(input);
      if (!out.changed) continue;

      // A STALL THE ENGINE DELIBERATELY DID NOT ACT ON. Both new outcomes leave every target
      // exactly where it was and say why — so they fall through the "nothing changed → stay
      // silent" guard below, which is correct for every other reason and wrong for these two.
      // Rate-limited to once a week: this job runs daily and a stalled, under-logging client
      // would otherwise be told the same thing every morning for three weeks, which is nagging,
      // not coaching.
      if (out.reason === "stalled_unlogged" || out.reason === "stalled_over_target") {
        const lastNotice = notes.match(/stall_notice:(\d{4}-\d{2}-\d{2})/)?.[1];
        if (lastNotice && (Date.now() - new Date(lastNotice).getTime()) / 86_400_000 < 7) continue;
        const kept = notes.replace(/\s*\bstall_notice:\d{4}-\d{2}-\d{2}\b/g, "").trim();
        await db.update(users)
          .set({ profileNotes: `${kept} stall_notice:${today}`.trim() })
          .where(eq(users.id, c.id));
        await sendWhatsApp(c.phoneNumber, out.note).catch(() => {});
        console.log(`[ADAPTIVE] ${c.id.slice(-6)} ${out.reason}: targets held at ${input.baseCalories} kcal (logged ${input.loggedDays7d ?? "?"}d, avg ${input.avgKcal7d ?? "?"} kcal)`);
        continue;
      }

      // Nothing actually different from what they already hold → stay silent.
      if (out.calorieTarget === input.baseCalories && out.proteinTarget === input.baseProtein
          && out.stepsTarget === input.baseSteps) continue;

      // MARK IT DELIBERATE, or the morning sanity audit reverts it before lunch (2026-07-30
      // live: this job wrote 2530, morning.ts saw 332 kcal off the profile figure, called it
      // corruption and wrote 2862 back with an announcement). Same durable profileNotes token
      // pattern as sick_until, and the same exemption a diet break already gets.
      const keptNotes = (notes || "").replace(/\s*\badapted_until:\d{4}-\d{2}-\d{2}\b/g, "").trim();
      const adaptedUntil = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
      await db.update(users).set({
        calorieTarget: out.calorieTarget,
        proteinTarget: out.proteinTarget,
        stepsTarget: out.stepsTarget,
        profileNotes: `${keptNotes} adapted_until:${adaptedUntil}`.trim(),
      }).where(eq(users.id, c.id));

      if (out.note) {
        await sendWhatsApp(c.phoneNumber, `🎯 *Targets adjusted for today.*\n\n${out.note}`).catch(() => {});
      }
      moved++;
      console.log(`[ADAPTIVE] ${c.id.slice(-6)} ${out.reason}: ${input.baseCalories}→${out.calorieTarget} kcal, steps ${input.baseSteps}→${out.stepsTarget}`);
    } catch (e) {
      console.warn(`[ADAPTIVE] failed for ${c.id?.slice(-6)}:`, (e as Error)?.message || e);
    }
  }
  saveState("adaptive_targets", today);
  if (moved > 0) console.log(`[ADAPTIVE] adjusted targets for ${moved} client(s)`);
}
