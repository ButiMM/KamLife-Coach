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
import { eq, gte, desc, asc, and } from "drizzle-orm";
import { weeklyTrendSlopeKg } from "../handlers/weight";
import { getPhaseNames } from "../programme";
import { energyFrameLine, waterTargetLitres } from "../targets";
import { sastToday, sastDayStart } from "../utils";
// ONE day key (2026-08-13). This file grouped the protein average by UTC and the 7-day story by
// SAST — two day boundaries inside one snapshot, so a meal logged at 00:30 SAST landed on
// yesterday in the numbers and today in the story. The client is then told they ate something
// today while the totals disagree. sast.ts already owned this; the local copy was the second owner.
import { sastDayKey } from "../sast";
import { liftsForLaggingAreas } from "../physique-analysis";
import { getGoalProfile } from "../goal-profiles";

const DAY = 86_400_000;

export async function buildClientSnapshot(user: any): Promise<string> {
  const now = Date.now();
  const since = (days: number) => new Date(now - days * DAY);
  const lines: string[] = [];

  try {
    // ── The clock — without it the model treats a 600-kcal breakfast as the whole
    // day and declares a "2396 kcal deficit" at 08:37 (2026-07-06 audit).
    const saNow = new Date(now).toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    lines.push(`Time now: ${saNow} (SA). The day is IN PROGRESS — today's numbers below are a running count so far, not a finished day.`);

    // ── ENVIRONMENT: the client's real week, so the brain coaches their LIFE, not a spreadsheet.
    // SA-specific rhythms — weekend takeaway pull, month-end tight budget then payday temptation.
    const saDom = parseInt(new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric" }), 10);
    const saWeekday = new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long" });
    const saHour = parseInt(new Date(now).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", hour12: false }), 10);
    const env: string[] = [];
    const isWeekend = /Saturday|Sunday/.test(saWeekday);
    if (/Friday/.test(saWeekday) && saHour >= 15) env.push("it's Friday evening — the takeaway/braai/drinks pull is real; meet it with a plan, not a lecture");
    else if (isWeekend) env.push("it's the weekend — routine is looser and social eating is likely; keep it realistic, protein-first, no guilt");
    if (saDom >= 25 || saDom <= 2) env.push(saDom >= 25 ? "it's MONTH-END — money is tight for most SA clients; lead with the cheapest real foods (eggs, pilchards, sugar beans, oats, pap), never premium suggestions unless they raise budget" : "it's just after month-end/payday — a common splurge window; steer the payday treat into a smart choice rather than banning it");
    if (env.length) lines.push(`Environment: ${env.join("; ")}. Use this to sound like you live in their world — only when it's relevant, never force it.`);

    // GOAL FRAMING via the semantic profile (2026-07-21 spine surgery). Body-comp goals get
    // their kcal/protein targets exactly as before; health-led goals (wellness / a condition)
    // get NO quota — the coach works habits, movement and how they feel, never numbers, so a
    // gogo is never handed a 185g protein target. "A condition" adds the doctor scope boundary.
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

    // ── Energy frame — shared with the GPT fallback (targets.ts) so both mouths
    // state the same maintenance/surplus truth (2026-07-06 audit).
    const calTarget = Number(user.calorieTarget) || 0;
    const frame = energyFrameLine(user.goalType, user.calorieTarget);
    if (frame) lines.push(frame);

    // SICK STATE (2026-07-13): while sick_until is active, every reply must be
    // sick-aware — no training pushes, no target pressure, comeback questions get the
    // return plan. The proactive machine is already on hold via paused_until.
    const sickMatch = String(user.profileNotes || "").match(/sick_until:(\d{4}-\d{2}-\d{2})/);
    if (sickMatch && new Date(sickMatch[1]) >= new Date(sastToday())) {
      lines.push(`⚠️ CLIENT IS SICK (resting until ~${sickMatch[1]}). No training pushes, no calorie pressure — care first. If they ask about coming back: nothing resets. Session 1 at 60% with one less set, sessions 2-3 at 70-80%, full weight only by week 2-3. NEVER say they go back to full speed on session two.`);
    }

    // Who this client is, in their own words (captured at onboarding) — reference their
    // DREAM to motivate, their STRUGGLE to coach, and NEVER suggest a food they hate.
    if (user.dreamGoal) lines.push(`Their 3-month dream, in their words: "${String(user.dreamGoal).slice(0, 160)}". Reference this to motivate — it's their why.`);
    if (user.biggestStruggle) lines.push(`Their biggest struggle: "${String(user.biggestStruggle).slice(0, 140)}". Coach around THIS — it's where they need the most support.`);
    if (user.foodDislikes) lines.push(`Foods they DISLIKE — never suggest these, always offer an alternative: ${String(user.foodDislikes).slice(0, 120)}.`);
    if (user.foodLikes) lines.push(`Foods they LOVE — build meals around these: ${String(user.foodLikes).slice(0, 120)}.`);

    // ── Physique read from the baseline progress photos (physique-analysis.ts) — so
    // the coach can prioritise the muscles a client is behind on, which they often
    // can't judge on themselves. Drives targeted volume, never "variety".
    if (user.laggingAreas) {
      const dom = user.dominantAreas ? ` Already strong: ${String(user.dominantAreas).replace(/,/g, ", ")}.` : "";
      // The SPECIFIC lifts, not just the muscle names (2026-07-21, Kam: "'your back lifts'
      // means nothing — name the machine she already does"). So "where can I improve?" gets
      // "add a set to your Lat Pulldown", not "your back lifts".
      const lifts = liftsForLaggingAreas(String(user.laggingAreas));
      const liftLine = lifts ? ` When you tell them how to bring these up, NAME THE EXACT LIFT from their programme — ${lifts} — add a couple of sets there and keep adding weight/reps on the core lifts. NEVER just say "your back lifts" or invent a new exercise.` : "";
      lines.push(`Physique read (from progress photos): LAGGING muscles to prioritise with extra targeted volume — ${String(user.laggingAreas).replace(/,/g, ", ")}.${dom}${liftLine}`);
    }

    // ── Food TODAY so far — running count, labelled meals, space left. "Remaining"
    // is food still to eat, never a "deficit".
    const todayStart = sastDayStart();
    // WHAT they ate, not just how much (2026-07-27 live: client logged chicken+rice+lentils
    // for lunch, asked "any suggestions for dinner?" 90 min later, and the coach suggested
    // grilled chicken + lentils — the exact same meal. The snapshot carried kcal and the slot
    // label but never the FOODS, so the engine could not know.)
    const todayMeals = await db.select({ kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt, mealLabel: mealLogs.mealLabel, items: mealLogs.items, rawMessage: mealLogs.rawMessage })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .catch(() => [] as any[]);
    if (todayMeals.length > 0) {
      const kcal = todayMeals.reduce((s, r) => s + (r.kcalInt || 0), 0);
      const prot = todayMeals.reduce((s, r) => s + (r.proteinInt || 0), 0);
      const labels = todayMeals.map((r: any) => r.mealLabel).filter(Boolean).join(", ");
      // The actual foods — so the coach never suggests what they just ate.
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
      // Health-led goals never get the "kcal still to eat / space left" budget framing —
      // for them, count meals, not calories (goal-profiles: usesMacros=false).
      const remaining = (profile.usesMacros && calTarget > 0) ? Math.max(0, calTarget - kcal) : null;
      const foodCore = (profile.usesMacros
        ? `Food TODAY so far: ~${kcal} kcal | ${prot}g protein across ${todayMeals.length} meal${todayMeals.length !== 1 ? "s" : ""}${labels ? ` (${labels})` : ""}.`
        : `Food TODAY so far: ${todayMeals.length} meal${todayMeals.length !== 1 ? "s" : ""} logged${labels ? ` (${labels})` : ""} — coach the QUALITY of the plate (protein first, veg, one carb), never a calorie count.`) + eatenLine;
      // WHICH SLOTS ARE ALREADY FILLED (2026-08-06, live: rice and minced beef were logged for
      // dinner at 19:02 and two minutes later the coach asked "What's on the menu for dinner?").
      // The snapshot carried the foods and the slot labels, but nothing SAID that asking about a
      // filled slot is wrong — so the model treated a logged dinner as an open question and the
      // client, who had just told it twice, read it as not listening. Stated as a prohibition,
      // from the rows, because a fact the model has to infer is a fact it can miss.
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

    // ── Sessions — ONE frame: lifetime total + last 7 days + last 4 weeks ──
    const total = user.totalWorkoutsCompleted || 0;
    const wLogs = await db.select({ loggedAt: workoutLogs.loggedAt })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), eq(workoutLogs.workoutCompleted, true)))
      .orderBy(desc(workoutLogs.loggedAt)).limit(80).catch(() => [] as { loggedAt: Date | null }[]);
    const inLast = (days: number) => wLogs.filter(w => w.loggedAt && new Date(w.loggedAt).getTime() >= now - days * DAY).length;
    lines.push(`Sessions: ${total} total (lifetime), ${inLast(7)} in the last 7 days, ${inLast(28)} in the last 4 weeks. Current streak: ${user.workoutStreak || 0}.`);

    // ── Weight — ONE computation: start, now, total change AND recent trend together ──
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
      const slope = weeklyTrendSlopeKg(points, 2, 5); // kg/week over the recent ~3-week window
      const recentTrend = slope === null ? "not enough recent weigh-ins to call a trend yet"
        : Math.abs(slope) < 0.1 ? "flat over the last ~3 weeks (a plateau)"
        : `${slope > 0 ? "rising" : "falling"} about ${Math.abs(slope).toFixed(2)}kg/week recently`;
      const dir = totalChange > 0 ? "+" : "";
      // Both facts in ONE line so a reply can never split them into a contradiction.
      lines.push(`Weight: started ${start}kg, now ${cur}kg — ${dir}${totalChange}kg over ${weeks} week${weeks !== 1 ? "s" : ""} total, and ${recentTrend}. When you talk about weight, state BOTH together (e.g. "up 0.8kg overall but flat the last 3 weeks — that's the plateau"). Quote these figures EXACTLY as written — never restate the rate as a different number (a client was told 0.21kg/week and 0.57kg/week within minutes; that destroys trust).`);
    }

    // ── Protein adherence, last 7 days (per-day average) ──
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

    // ── Steps, last 7 days ──
    const stepRows = await db.select({ steps: stepLogs.steps, loggedAt: stepLogs.loggedAt })
      .from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, since(7))))
      .catch(() => [] as { steps: number; loggedAt: Date | null }[]);
    const stepTarget = user.stepsTarget || 8500;
    // Today vs history stated separately — the model kept attributing a "walked 3000
    // steps" report to YESTERDAY and quoting only the average (2026-07-05 audit).
    const todayStepRows = stepRows.filter(r => r.loggedAt && new Date(r.loggedAt) >= todayStart);
    const todaySteps = todayStepRows.length > 0 ? Math.max(...todayStepRows.map(r => r.steps || 0)) : null;
    const pastRows = stepRows.filter(r => r.loggedAt && new Date(r.loggedAt) < todayStart);
    const stepsTodayLine = todaySteps !== null
      ? `Steps TODAY so far: ${todaySteps.toLocaleString()} (day still in progress).`
      : `Steps TODAY: none logged yet.`;
    if (pastRows.length > 0) {
      const avg = Math.round(pastRows.reduce((s, r) => s + (r.steps || 0), 0) / pastRows.length);
      lines.push(`${stepsTodayLine} Before today: averaging ${avg.toLocaleString()}/day across ${pastRows.length} logged day${pastRows.length !== 1 ? "s" : ""} vs ${stepTarget.toLocaleString()} target. Keep TODAY and the average separate — never present the average as today's count or vice versa.`);
    } else {
      lines.push(`${stepsTodayLine} No other step logs in the last 7 days vs ${stepTarget.toLocaleString()} target.`);
    }

    // ── Water today ──
    const waterTarget = waterTargetLitres(String(user.currentWeight || "75"));
    const todayWater = user.waterLastResetDate === sastToday() ? (Number(user.todayWater) || 0) : 0;
    lines.push(`Water today: ${todayWater}L of ${waterTarget}L target.`);

    // ── THE STORY — the last 7 days as prose, not rows. Everything above is a column: a
    // coach who has been there remembers WHAT HAPPENED and WHAT THEY SAID. "last_weight:
    // 82.4" is data; "she weighed 82.4kg Thursday and said her knee hurt in squats" is
    // memory. Built from rows already fetched — one extra query for their own words.
    const said = await db.select({ messageIn: chatHistory.messageIn, createdAt: chatHistory.createdAt })
      .from(chatHistory).where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, since(7))))
      .orderBy(asc(chatHistory.createdAt)).limit(200).catch(() => [] as any[]);
    type Day = { ate: string[]; kcal: number; steps: number; kg: number | null; trained: boolean; said: string[] };
    const story = new Map<string, Day>();
    const slot = (k: string): Day => story.get(k) ?? (story.set(k, { ate: [], kcal: 0, steps: 0, kg: null, trained: false, said: [] }), story.get(k)!);
    for (const r of meals as any[]) {
      const e = slot(sastDayKey(r.loggedAt ?? now));
      e.kcal += r.kcalInt || 0;
      const names: string[] = Array.isArray(r.items) ? r.items.map((i: any) => String(i?.name || "").trim()).filter(Boolean)
        : r.rawMessage && r.rawMessage !== "[Photo]" ? [String(r.rawMessage).slice(0, 30)] : [];
      if (names.length) e.ate.push(`${r.mealLabel ? `${r.mealLabel} — ` : ""}${names.slice(0, 3).join(", ")}`);
    }
    for (const r of stepRows) { const e = slot(sastDayKey(r.loggedAt ?? now)); e.steps = Math.max(e.steps, r.steps || 0); }
    for (const w of wLogs) if (w.loggedAt && new Date(w.loggedAt).getTime() >= now - 7 * DAY) slot(sastDayKey(w.loggedAt ?? now)).trained = true;
    for (const r of wl) if (r.loggedAt && new Date(r.loggedAt).getTime() >= now - 7 * DAY) slot(sastDayKey(r.loggedAt ?? now)).kg = parseFloat(String(r.weight));
    // Their own words — the disclosures a coach would remember ("my knee hurt", "work was
    // mad this week"). Skip short/numeric turns: those are logs, already counted above.
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
      if (e.ate.length) bits.push(`ate ${e.ate.slice(0, 4).join("; ")}${e.kcal ? ` (~${e.kcal} kcal)` : ""}`);
      else bits.push("logged no food");
      if (e.trained) bits.push("trained");
      if (e.steps) bits.push(`walked ${e.steps.toLocaleString()} steps`);
      if (e.kg !== null) bits.push(`weighed ${e.kg}kg`);
      if (e.said.length) bits.push(`told you: "${e.said.join(`" and "`)}"`);
      sentences.push(`${when}: ${bits.join(", ")}.`);
    }
    lines.push(`THE LAST 7 DAYS — WHAT YOU REMEMBER (read it as a story, not a table). Reference a SPECIFIC day or something they actually said, the way a coach who was there would. Never recite the whole list back at them, never quote a day they were silent as if they told you something:\n${sentences.join("\n")}`);

    // ── Last automated (proactive) message — the scheduler talks to the client too.
    // Without this the brain argues with its own system: client says "but you told me
    // my calories were bumped / I gained 0.8kg" hours later and the brain has no idea
    // what was sent (2026-07-05 audit, "you are gonna get people killed").
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

  // ── REMEMBERED DATES: the client TOLD us when they're away/back — never re-ask, never
  // contradict (2026-07-20, Kam: "remember the time and dates when the person tells us").
  try {
    const notes = user.profileNotes || "";
    const backOn = notes.match(/back_on:(\d{4}-\d{2}-\d{2})/)?.[1];
    const sickUntil = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/)?.[1];
    const pausedUntil = notes.match(/paused_until:(\d{4}-\d{2}-\d{2})/)?.[1];
    if (backOn) lines.push(`The client TOLD you they plan to be back on ${backOn}. Remember it — reference it naturally, don't re-ask, and don't push training before then.`);
    if (sickUntil) lines.push(`Client is SICK/resting until ${sickUntil} (they told you). Care first; no training pushes before that date.`);
    if (pausedUntil) lines.push(`Client is on a PAUSE/break until ${pausedUntil}. Respect it — no programme pressure until then.`);
  } catch { /* memory lines are bonus */ }

  // ── LONG-TERM INTELLIGENCE (CIP): what we've LEARNED about this client over months —
  // their patterns, weak days, best streaks, plateau history, the coach narrative. This was
  // wired to the OLD gpt path but NEVER to the new engine (2026-07-19 audit: written in 7
  // places, read into the brain in 0). This closes that gap so the LIVE brain actually knows
  // the person, and gets smarter about them over time. Dynamic import avoids a cycle; bonus-only.
  try {
    const { getClientNarrative } = await import("../intelligence/profile");
    const narrative = await getClientNarrative(user.id);
    if (narrative && narrative.trim()) {
      lines.push(`WHAT YOU'VE LEARNED ABOUT THIS CLIENT OVER TIME (their durable patterns — use it to sound like you know them, never recite it back): ${narrative.trim()}`);
    }
  } catch { /* the long-term narrative is a bonus — never blocks the snapshot */ }

  return lines.join("\n");
}
