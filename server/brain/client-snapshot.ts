/**
 * CLIENT SNAPSHOT — one consistent picture of the client.
 *
 * The screenshots showed the bot saying "gained 0.8kg" and "weight hasn't moved in 3
 * weeks" in two different breaths, throwing around "18 workouts" / "11 of 16" / "Week 1"
 * / "6 weeks" with no coherent frame, because those facts are computed in several
 * different places that disagree. Every brain reply reads from THIS single function, so
 * it literally cannot contradict itself: total change and recent trend are stated
 * together, and the session/week frame is one and the same everywhere.
 *
 * Read-only. Never throws — a partial snapshot beats a failed one.
 */

import { db } from "../db";
import { weightLogs, workoutLogs, mealLogs, stepLogs, chatHistory } from "../../shared/schema";
import { eq, gte, desc, asc, and, sql } from "drizzle-orm";
import { weeklyTrendSlopeKg } from "../handlers/weight";
import { getPhaseNames } from "../programme";
import { energyFrameLine, waterTargetLitres } from "../targets";
import { sastToday, sastDayStart } from "../utils";
// ONE day key (2026-08-13). This file grouped the protein average by UTC and the 7-day story by
// SAST — two day boundaries inside one snapshot, so a meal logged at 00:30 SAST landed on
// yesterday in the numbers and today in the story. The client is then told they ate something
// today while the totals disagree. sast.ts already owned this; the local copy was the second owner.
import { sastDayKey } from "../sast";
import { readHealthState } from "../health-state";
import { liftsForLaggingAreas } from "../physique-analysis";
import { getGoalProfile } from "../goal-profiles";

const DAY = 86_400_000;

type TrustedStepRow = { steps: number; loggedAt: Date | null; provenance: string; resolvedDay: string | null };

export async function buildClientSnapshot(user: any): Promise<string> {
  const now = Date.now();
  const since = (days: number) => new Date(now - days * DAY);
  const lines: string[] = [];

  try {
    const saNow = new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
    lines.push(`Time now: ${saNow} (SA). The day is IN PROGRESS — today's numbers below are a running count so far, not a finished day.`);

    const saDom = parseInt(new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric" }), 10);
    const saWeekday = new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long" });
    const saHour = parseInt(new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", hour12: false }), 10);
    const env: string[] = [];
    const isWeekend = /Saturday|Sunday/.test(saWeekday);
    if (/Friday/.test(saWeekday) && saHour >= 15) env.push("it's Friday evening — the takeaway/braai/drinks pull is real; meet it with a plan, not a lecture");
    else if (isWeekend) env.push("it's the weekend — routine is looser and social eating is likely; keep it realistic, protein-first, no guilt");
    if (saDom >= 25 || saDom <= 2) env.push(saDom >= 25 ? "it's MONTH-END — money is tight for most SA clients; lead with the cheapest real foods (eggs, pilchards, sugar beans, oats, pap), never premium suggestions unless they raise budget" : "it's just after month-end/payday — a common splurge window; steer the payday treat into a smart choice rather than banning it");
    if (env.length) lines.push(`Environment: ${env.join("; ")}. Use this to sound like you live in their world — only when it's relevant, never force it.`);

    const profile = getGoalProfile(user.goalType);
    if (profile.usesMacros) {
      const goal = String(user.goalType || "fat_loss").replace(/_/g, " ");
      lines.push(`Goal: ${goal}. Daily targets: ${user.calorieTarget ?? "?"} kcal, ${user.proteinTarget ?? "?"}g protein.`);
    } else {
      const boundary = profile.scopeBoundary
        ? ` This client told us they have a health condition — you coach the PERSON, never the condition: never prescribe medication, doses, or clinical timing; if it comes up, warmly remind them to follow their doctor for the condition while you handle food, movement and habits.`
        : "";
      lines.push(`Goal: ${profile.label} — this client is NOT chasing calorie/protein numbers or a scale figure. Coach consistency, everyday movement, energy and how they FEEL. Never push a kcal or protein target at them, never talk deficits/surplus, never nag a number.${boundary}`);
    }

    const calTarget = Number(user.calorieTarget) || 0;
    const frame = energyFrameLine(user.goalType, user.calorieTarget);
    if (frame) lines.push(frame);

    // ONE READ of the health hold (2026-08-21). This block and the memory block below used to
    // parse sick_until separately and disagree — this one compared UTC midnights, the other did
    // not check the date at all.
    const health = readHealthState(user);
    if (health.isSick) {
      lines.push(`⚠️ CLIENT IS SICK (resting until ~${health.sickUntil}). No training pushes, no calorie pressure — care first. If they ask about coming back: nothing resets. Session 1 at 60% with one less set, sessions 2-3 at 70-80%, full weight only by week 2-3. NEVER say they go back to full speed on session two.`);
    }

    if (user.dreamGoal) lines.push(`Their 3-month dream, in their words: "${String(user.dreamGoal).slice(0, 160)}". Reference this to motivate — it's their why.`);
    if (user.biggestStruggle) lines.push(`Their biggest struggle: "${String(user.biggestStruggle).slice(0, 140)}". Coach around THIS — it's where they need the most support.`);
    if (user.foodDislikes) lines.push(`Foods they DISLIKE — never suggest these, always offer an alternative: ${String(user.foodDislikes).slice(0, 120)}.`);
    if (user.foodLikes) lines.push(`Foods they LOVE — build meals around these: ${String(user.foodLikes).slice(0, 120)}.`);

    if (user.laggingAreas) {
      const dom = user.dominantAreas ? ` Already strong: ${String(user.dominantAreas).replace(/,/g, ", ")}.` : "";
      const lifts = liftsForLaggingAreas(String(user.laggingAreas));
      const liftLine = lifts ? ` When you tell them how to bring these up, NAME THE EXACT LIFT from their programme — ${lifts} — add a couple of sets there and keep adding weight/reps on the core lifts. NEVER just say "your back lifts" or invent a new exercise.` : "";
      lines.push(`Physique read (from progress photos): LAGGING muscles to prioritise with extra targeted volume — ${String(user.laggingAreas).replace(/,/g, ", ")}.${dom}${liftLine}`);
    }

    const todayStart = sastDayStart();
    const todayMeals = await db.select({ kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt, mealLabel: mealLogs.mealLabel, items: mealLogs.items, rawMessage: mealLogs.rawMessage })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .catch(() => [] as any[]);
    if (todayMeals.length > 0) {
      const kcal = todayMeals.reduce((s, r) => s + (r.kcalInt || 0), 0);
      const prot = todayMeals.reduce((s, r) => s + (r.proteinInt || 0), 0);
      const labels = todayMeals.map((r: any) => r.mealLabel).filter(Boolean).join(", ");
      const eatenNames: string[] = [];
      for (const r of todayMeals as any[]) {
        if (Array.isArray(r.items)) {
          for (const it of r.items) { const n = (it?.name || "").trim(); if (n) eatenNames.push(n); }
        } else if (r.rawMessage && r.rawMessage !== "[Photo]") {
          eatenNames.push(String(r.rawMessage).slice(0, 40));
        }
      }
      const eatenLine = eatenNames.length
        ? `\nALREADY EATEN TODAY: ${[...new Set(eatenNames)].slice(0, 8).join(", ")}. When suggesting a meal, do NOT repeat what they have already eaten today — offer something different unless they ask to repeat it.`
        : "";
      const remaining = (profile.usesMacros && calTarget > 0) ? Math.max(0, calTarget - kcal) : null;
      const foodCore = (profile.usesMacros
        ? `Food TODAY so far: ~${kcal} kcal | ${prot}g protein across ${todayMeals.length} meal${todayMeals.length !== 1 ? "s" : ""}${labels ? ` (${labels})` : ""}.`
        : `Food TODAY so far: ${todayMeals.length} meal${todayMeals.length !== 1 ? "s" : ""} logged${labels ? ` (${labels})` : ""} — coach the QUALITY of the plate (protein first, veg, one carb), never a calorie count.`) + eatenLine;
      const filledSlots = [...new Set(todayMeals.map((r: any) => String(r.mealLabel || "").toLowerCase()).filter(Boolean))];
      const slotLine = filledSlots.length
        ? `\nALREADY LOGGED AND SETTLED: ${filledSlots.join(", ")}. Do NOT ask what they are having for any of these — it is on file. If they mention one again, they are correcting or adding to it, not reporting a new meal.`
        : "";
      lines.push(`${foodCore}${slotLine}${remaining !== null ? ` ~${remaining} kcal still to eat today — that is the space LEFT in the day, NOT a deficit.` : ""}`);
    } else {
      lines.push(`Food TODAY: nothing logged yet — check the time above; early in the day this is normal. Don't scold, don't invent intake.`);
    }

    const phase = getPhaseNames()[user.programmePhase || 1] || "Foundation";
    lines.push(`Programme: ${phase} phase, week ${user.programmeWeek || 1}, day ${user.programmeDayInWeek || 1} (week is phase-relative — it resets each phase; sessions below are the lifetime count).`);

    // ONE SOURCE PER FACT, INSIDE ONE SENTENCE (2026-08-21). This read the lifetime total from
    // users.totalWorkoutsCompleted and the 7- and 28-day counts from workoutLogs — two clocks in
    // the same line, handed to the model as fact. The counter drifts from the log table the moment
    // one write fails, and a model given contradictory facts can manufacture the contradiction
    // back out. Fixing only the deterministic reply left this door open; it is shut now.
    const [totalRow] = await db.select({ n: sql<number>`COUNT(*)::int` })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), eq(workoutLogs.workoutCompleted, true)))
      .catch(() => [{ n: 0 }] as { n: number }[]);
    const total = Number(totalRow?.n || 0);
    const wLogs = await db.select({ loggedAt: workoutLogs.loggedAt })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), eq(workoutLogs.workoutCompleted, true)))
      .orderBy(desc(workoutLogs.loggedAt)).limit(80).catch(() => [] as { loggedAt: Date | null }[]);
    const inLast = (days: number) => wLogs.filter(w => w.loggedAt && new Date(w.loggedAt).getTime() >= now - days * DAY).length;
    lines.push(`Sessions: ${total} total (lifetime), ${inLast(7)} in the last 7 days, ${inLast(28)} in the last 4 weeks. Current streak: ${user.workoutStreak || 0}.`);

    const wl = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
      .from(weightLogs).where(eq(weightLogs.userId, user.id))
      .orderBy(desc(weightLogs.loggedAt)).limit(40).catch(() => [] as { weight: string; loggedAt: Date | null }[]);
    if (wl.length === 0) {
      lines.push(`Weight: none logged yet — do not quote a weight figure.`);
    } else {
      const cur = parseFloat(String(wl[0].weight));
      const oldest = wl[wl.length - 1];
      const start = parseFloat(String(oldest.weight));
      const spanDays = Math.max(1, Math.round((now - new Date(oldest.loggedAt || now).getTime()) / DAY));
      const weeks = Math.max(1, Math.round(spanDays / 7));
      const totalChange = +(cur - start).toFixed(1);
      const recent = wl.filter(r => r.loggedAt && new Date(r.loggedAt).getTime() >= now - 21 * DAY);
      const points = recent.map(r => ({ dayOffset: Math.round(new Date(r.loggedAt!).getTime() / DAY), kg: parseFloat(String(r.weight)) }));
      const slope = weeklyTrendSlopeKg(points, 2, 5);
      const recentTrend = slope === null ? "not enough recent weigh-ins to call a trend yet"
        : Math.abs(slope) < 0.1 ? "flat over the last ~3 weeks (a plateau)"
        : `${slope > 0 ? "rising" : "falling"} about ${Math.abs(slope).toFixed(2)}kg/week recently`;
      const dir = totalChange > 0 ? "+" : "";
      lines.push(`Weight: started ${start}kg, now ${cur}kg — ${dir}${totalChange}kg over ${weeks} week${weeks !== 1 ? "s" : ""} total, and ${recentTrend}. When you talk about weight, state BOTH together (e.g. "up 0.8kg overall but flat the last 3 weeks — that's the plateau"). Quote these figures EXACTLY as written — never restate the rate as a different number.`);
    }

    const meals = await db.select({ proteinInt: mealLogs.proteinInt, kcalInt: mealLogs.kcalInt, loggedAt: mealLogs.loggedAt, mealLabel: mealLogs.mealLabel, items: mealLogs.items, rawMessage: mealLogs.rawMessage })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, since(7))))
      .catch(() => [] as any[]);
    if (meals.length > 0) {
      const byDay = new Map<string, number>();
      for (const row of meals) {
        const k = sastDayKey(row.loggedAt || now);
        byDay.set(k, (byDay.get(k) || 0) + (row.proteinInt || 0));
      }
      const days = [...byDay.values()];
      const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
      lines.push(`Protein: averaging ${avg}g/day across ${days.length} logged day${days.length !== 1 ? "s" : ""} in the last week vs ${user.proteinTarget ?? "?"}g target.`);
    } else {
      lines.push(`Protein: nothing logged in the last 7 days — encourage logging, don't guess numbers.`);
    }

    // P1 provenance gate: legacy/unattributed rows must never become current-day coaching truth.
    const stepRowsResult = await db.execute(sql`
      SELECT steps,
             logged_at AS "loggedAt",
             COALESCE(provenance, 'unverified') AS provenance,
             resolved_day AS "resolvedDay"
      FROM step_logs
      WHERE user_id = ${user.id}
        AND logged_at >= ${since(7)}
    `).catch(() => ({ rows: [] as TrustedStepRow[] }));
    const stepRows = ((stepRowsResult as any).rows as TrustedStepRow[]).filter((r) => r.provenance === "client_report" && !!r.resolvedDay);
    const stepTarget = user.stepsTarget || 8500;
    const todaySastKey = sastToday();
    const todayStepRows = stepRows.filter(r => r.resolvedDay === todaySastKey);
    const todaySteps = todayStepRows.length > 0 ? Math.max(...todayStepRows.map(r => Number(r.steps) || 0)) : null;
    const pastRows = stepRows.filter(r => !!r.resolvedDay && r.resolvedDay < todaySastKey);
    const stepsTodayLine = todaySteps !== null ? `Steps TODAY so far: ${todaySteps.toLocaleString()} (day still in progress).` : `Steps TODAY: none logged yet.`;
    if (pastRows.length > 0) {
      const avg = Math.round(pastRows.reduce((s, r) => s + (Number(r.steps) || 0), 0) / pastRows.length);
      lines.push(`${stepsTodayLine} Before today: averaging ${avg.toLocaleString()}/day across ${pastRows.length} logged day${pastRows.length !== 1 ? "s" : ""} vs ${stepTarget.toLocaleString()} target. Keep TODAY and the average separate — never present the average as today's count or vice versa.`);
    } else {
      lines.push(`${stepsTodayLine} No other verified client-reported step logs in the last 7 days vs ${stepTarget.toLocaleString()} target.`);
    }

    const waterTarget = waterTargetLitres(String(user.currentWeight || "75"));
    const todayWater = user.waterLastResetDate === sastToday() ? (Number(user.todayWater) || 0) : 0;
    lines.push(`Water today: ${todayWater}L of ${waterTarget}L target.`);

    const said = await db.select({ messageIn: chatHistory.messageIn, createdAt: chatHistory.createdAt })
      .from(chatHistory).where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, since(7))))
      .orderBy(asc(chatHistory.createdAt)).limit(200).catch(() => [] as any[]);
    type Day = { ate: string[]; kcal: number; steps: number; kg: number | null; trained: boolean; said: string[] };
    const story = new Map<string, Day>();
    const slot = (k: string): Day => story.get(k) ?? (story.set(k, { ate: [], kcal: 0, steps: 0, kg: null, trained: false, said: [] }), story.get(k)!);
    for (const r of meals as any[]) {
      const e = slot(sastDayKey(r.loggedAt ?? now));
      e.kcal += r.kcalInt || 0;
      const names: string[] = Array.isArray(r.items) ? r.items.map((i: any) => String(i?.name || "").trim()).filter(Boolean) : r.rawMessage && r.rawMessage !== "[Photo]" ? [String(r.rawMessage).slice(0, 30)] : [];
      if (names.length) e.ate.push(`${r.mealLabel ? `${r.mealLabel} — ` : ""}${names.slice(0, 3).join(", ")}`);
    }
    for (const r of stepRows) { const e = slot(r.resolvedDay!); e.steps = Math.max(e.steps, Number(r.steps) || 0); }
    for (const w of wLogs) if (w.loggedAt && new Date(w.loggedAt).getTime() >= now - 7 * DAY) slot(sastDayKey(w.loggedAt ?? now)).trained = true;
    for (const r of wl) if (r.loggedAt && new Date(r.loggedAt).getTime() >= now - 7 * DAY) slot(sastDayKey(r.loggedAt ?? now)).kg = parseFloat(String(r.weight));
    for (const r of said as any[]) {
      const t = String(r.messageIn || "").replace(/\s+/g, " ").trim();
      const e = slot(sastDayKey(r.createdAt ?? now));
      if (t.length > 28 && e.said.length < 2 && !/^\d/.test(t)) e.said.push(t.slice(0, 90));
    }
    const todayKey = sastToday();
    const sentences: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const k = sastDayKey(new Date(now - i * DAY));
      const e = story.get(k);
      const when = k === todayKey ? "TODAY" : new Date(`${k}T12:00:00Z`).toLocaleDateString("en-ZA", { weekday: "long" });
      if (!e) { sentences.push(`${when}: silent — nothing logged, nothing said.`); continue; }
      const bits: string[] = [];
      if (e.ate.length) bits.push(`ate ${e.ate.slice(0, 4).join("; ")}${e.kcal ? ` (~${e.kcal} kcal)` : ""}`); else bits.push("logged no food");
      if (e.trained) bits.push("trained");
      if (e.steps) bits.push(`walked ${e.steps.toLocaleString()} steps`);
      if (e.kg !== null) bits.push(`weighed ${e.kg}kg`);
      if (e.said.length) bits.push(`told you: "${e.said.join(`" and "`)}"`);
      sentences.push(`${when}: ${bits.join(", ")}.`);
    }
    lines.push(`THE LAST 7 DAYS — WHAT YOU REMEMBER (read it as a story, not a table). Reference a SPECIFIC day or something they actually said, the way a coach who was there would. Never recite the whole list back at them, never quote a day they were silent as if they told you something:\n${sentences.join("\n")}`);

    const [lastProactive] = await db.select({ messageOut: chatHistory.messageOut, createdAt: chatHistory.createdAt })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "PROACTIVE"), gte(chatHistory.createdAt, since(2))))
      .orderBy(desc(chatHistory.createdAt)).limit(1)
      .catch(() => [] as { messageOut: string | null; createdAt: Date | null }[]);
    if (lastProactive?.messageOut) {
      const ageH = Math.max(0, Math.round((now - new Date(lastProactive.createdAt || now).getTime()) / 3_600_000));
      const excerpt = lastProactive.messageOut.replace(/\s+/g, " ").trim().slice(0, 260);
      lines.push(`Last automated coach message (sent ~${ageH}h ago — the client may reference it as something "you said"): "${excerpt}". If it quoted numbers, they were true when sent; reconcile with the stats above (e.g. total change vs recent trend are DIFFERENT facts) instead of contradicting or apologising.`);
    }
  } catch (e) {
    console.error("[CLIENT_SNAPSHOT] partial:", (e as any)?.message || e);
  }

  try {
    const notes = user.profileNotes || "";
    const backOn = notes.match(/back_on:(\d{4}-\d{2}-\d{2})/)?.[1];
    if (backOn) lines.push(`The client TOLD you they plan to be back on ${backOn}. Remember it — reference it naturally, don't re-ask, and don't push training before then.`);
    // THE 21 AUGUST BUG. These two lines were `if (sickUntil)` and `if (pausedUntil)` — no date
    // check whatsoever — so an illness from March still told the model "Client is SICK/resting
    // until 2026-03-04" on every single turn, for as long as the token sat on the row. Nothing in
    // the product removed the token, so "as long as" meant forever. The state owner derives expiry
    // on read, which is why a stale hold can no longer speak.
    const mem = readHealthState(user);
    if (mem.isSick) lines.push(`Client is SICK/resting until ${mem.sickUntil} (they told you). Care first; no training pushes before that date.`);
    else if (mem.isRecovering) lines.push(`Client is JUST BACK from being ill (hold ended ${mem.sickUntil}). Ease them in — do not treat this as a normal training week, and do not describe them as still sick.`);
    if (mem.pause === "explicit") lines.push(`Client is on a PAUSE/break until ${mem.pausedUntil}. Respect it — no programme pressure until then.`);
  } catch { /* memory lines are bonus */ }

  try {
    const { getClientNarrative } = await import("../intelligence/profile");
    const narrative = await getClientNarrative(user.id);
    if (narrative && narrative.trim()) {
      lines.push(`WHAT YOU'VE LEARNED ABOUT THIS CLIENT OVER TIME (their durable patterns — use it to sound like you know them, never recite it back): ${narrative.trim()}`);
    }
  } catch { /* the long-term narrative is a bonus — never blocks the snapshot */ }

  return lines.join("\n");
}
