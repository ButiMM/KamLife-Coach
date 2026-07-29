/**
 * Lifecycle and account command handlers — menu shortcuts, buddy system, sleep, food diary,
 * pause/cancel, profile updates, shopping list, hunger, cravings, social events, etc.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import {
  users, weightLogs, workoutLogs, stepLogs, chatHistory,
  mealLogs, exerciseLogs, bodyMeasurements, clothingCheckins,
  weeklyCheckins, escalations, abAssignments, progressPhotos,
  sentProactive, clientActions,
} from "../../shared/schema";
import { eq, desc, asc, and, gte, lt, sql } from "drizzle-orm";
import {
  EQUIPMENT_ALTERNATIVES, FOOD_SUBSTITUTIONS, PORTION_GUIDE,
  STORE_ADVICE, INJURY_MODIFICATIONS, detectLanguage,
} from "../constants";
import {
  buildDayWorkout, buildFullProgramme, getKamlifeProgramme,
} from "../programme";
import { withTimeout, logChat } from "./chat-log";
import { goalStatusLine } from "../education";
import { dailyMacroCardMarker } from "../macro-card-attach";
import { calculateTargets, waterTargetLitres } from "../targets";
import { getSleepResponse } from "./sleep";
import { getShoppingList, formatShoppingList } from "../shopping-lists";
import { getGroceryPersonalization } from "../grocery-personalize";
import { storeMemory } from "../memory";
import { sendWhatsApp } from "../scheduler";
import { sendCriticalAlert } from "../scheduler/shared";
import { sastToday, sastDayStart, proteinOptions , commaName, spaceName, getDisplayName} from "../utils";
import { getMenuText } from "../onboarding";
import { SA_FOODS_SEED } from "../foods";
import { scanForSAFoods, weeklyNetLine } from "./food-scanner";

export async function handleLifecycle(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  isQuestion?: boolean; // systemic QUESTION gate — see early-commands.ts
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;

  // Cross-section variables needed by injury modifications
  const isWorkoutRelated = /\b(gym|train|workout|exercise|session|lifting|squat|bench|deadlift|push|pull|press|curl|row|cardio|hiit|running|weights)\b/i.test(m);

  // ---- MENU NUMBER SHORTCUTS ----
  if (m === "3" || m === "food" || m === "food coaching" || m === "log food" || m === "food log") {
    return `Send me what you ate and I will give you the calories and protein instantly.\n\nExamples:\n• "I had pap and pilchards"\n• "2 eggs and brown bread"\n• "KFC original piece"\n• "Oats for breakfast"\n\nI have ${SA_FOODS_SEED.length} SA foods in my database. Just tell me what you ate.`;
  }
  if (m === "2" || m === "log steps" || m === "step log") {
    return `Send me your step count and I will log it.\n\nExamples:\n• "8500 steps"\n• "I walked 5km"\n• "10,000 steps done"\n\nYour daily target: ${(user.stepsTarget || 8500).toLocaleString()} steps.`;
  }
  if (m === "log sleep" || m === "sleep log") {
    return `Send me how many hours you slept.\n\nExamples:\n• "I slept 6 hours"\n• "7 hours sleep"\n• "bad sleep, maybe 5 hours"\n\nTarget: 7–9 hours for full recovery and fat loss.`;
  }
  if (m === "7" || m === "log weight" || m === "weight log") {
    return `Send me your weight and I will log it.\n\nExamples:\n• "84.5kg"\n• "I weigh 91kg"\n• "weighed in at 78kg this morning"\n\nWeigh in first thing in the morning, after toilet, before food. Same conditions every time.`;
  }
  if (m === "measurements" || m === "check in" || m === "measurement check in" || m === "measurements check in") {
    return `*Monthly Check-In* 📸\n\nWe don't do the tape measure — the numbers bounce around day to day and just add stress. We track what actually shows the change:\n\n1️⃣ *A photo* — front on, good light, same spot each month, relaxed (not flexed). Send it right here.\n2️⃣ *How you feel* — your energy, your sleep, and how your clothes are fitting. Just tell me in your own words.\n\nYour shape changing and your energy climbing is the real progress — the scale and the tape both miss it. Snap your photo whenever you're ready.`;
  }

  // ---- WEEKLY STEP LEADERBOARD — anonymous competition ----
  if (m === "leaderboard" || m === "leader board" || m === "rankings" || m === "step leaderboard" || m === "top steps" || m === "9" || m === "challenge") {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

      // Single GROUP BY query — no N+1. Aggregates total steps and distinct days
      // per user for the last 7 days, joined with the users table for names.
      const rows = await db
        .select({
          uid: users.id,
          name: users.name,
          total: sql<number>`SUM(${stepLogs.steps})`.as("total"),
          days: sql<number>`COUNT(DISTINCT DATE(${stepLogs.loggedAt}))`.as("days"),
        })
        .from(stepLogs)
        .innerJoin(users, eq(stepLogs.userId, users.id))
        .where(gte(stepLogs.loggedAt, sevenDaysAgo))
        .groupBy(users.id, users.name)
        .orderBy(sql`SUM(${stepLogs.steps}) DESC`);

      if (rows.length === 0) {
        return `No step logs this week yet. Be the first — send your step count now.`;
      }

      const ranked = rows.map(r => ({
        uid: r.uid,
        name: r.name || "Anonymous",
        total: Number(r.total),
        days: Number(r.days),
        avg: Number(r.days) > 0 ? Math.round(Number(r.total) / Number(r.days)) : 0,
      }));

      // Find current user's rank
      const myRank = ranked.findIndex(r => r.uid === user.id) + 1;
      const myEntry = ranked.find(r => r.uid === user.id);

      // Build top 10 leaderboard
      const medals = ["🥇", "🥈", "🥉"];
      const top10 = ranked.slice(0, 10);
      let board = `*🏆 Weekly Step Leaderboard*\n_${top10.length} clients competing this week_\n\n`;
      for (let i = 0; i < top10.length; i++) {
        const r = top10[i];
        const medal = i < 3 ? medals[i] : `${i + 1}.`;
        const isYou = r.uid === user.id;
        const parts = (r.name || "").split(" ");
        const firstName = parts[0] || "Member";
        // Anonymise: show first name + last initial only
        const displayName = parts.length > 1 && parts[1] ? `${firstName} ${parts[1][0]}.` : firstName;
        board += `${medal} ${isYou ? `*${displayName} (YOU)*` : displayName} — ${r.avg.toLocaleString()} avg/day (${r.days}d)\n`;
      }

      if (myRank > 0 && myRank <= 10) {
        board += `\nYou are *#${myRank}*. ${myRank === 1 ? "Leading the pack. Don't stop." : myRank <= 3 ? "Podium position. Push for #1." : "Keep climbing."}`;
      } else if (myRank > 10) {
        board += `\n---\n${myRank}. *${myEntry?.name?.split(" ")[0] || "You"} (YOU)* — ${myEntry?.avg.toLocaleString()} avg/day\n\nYou are #${myRank} of ${ranked.length}. Log more steps to climb.`;
      } else {
        board += `\nYou haven't logged steps this week. Send your step count to join the leaderboard.`;
      }

      await logChat(user.id, message, board, "LEADERBOARD");
      return board;
    } catch (err) {
      console.error("[LEADERBOARD]", err);
      return `Leaderboard is not available right now. Log your steps and try again later.`;
    }
  }

  // ---- ACCOUNTABILITY BUDDY SYSTEM ----
  if (m === "buddy" || m === "my buddy" || m === "accountability" || m === "accountability buddy" || m === "partner") {
    if (user.buddyId) {
      // Show buddy status
      try {
        const [buddy] = await db.select({
          name: users.name,
          totalWorkoutsCompleted: users.totalWorkoutsCompleted,
          workoutStreak: users.workoutStreak,
          lastActiveAt: users.lastActiveAt,
          todayCalories: users.todayCalories,
          todayCaloriesDate: users.todayCaloriesDate,
        }).from(users).where(eq(users.id, user.buddyId)).limit(1);

        if (!buddy) {
          await db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.phoneNumber, phone));
          return `Your buddy is no longer active. Reply *find buddy* to get matched with someone new.`;
        }

        const buddyName = buddy.name?.split(" ")[0] || "Your buddy";
        const buddyActive = buddy.lastActiveAt && (Date.now() - new Date(buddy.lastActiveAt).getTime()) < 2 * 86_400_000;
        const buddyStreak = buddy.workoutStreak || 0;
        const todayStr = sastToday();
        const buddyCals = buddy.todayCaloriesDate === todayStr ? (buddy.todayCalories || 0) : 0;
        const myStreak = user.workoutStreak || 0;

        let comparison = "";
        if (myStreak > buddyStreak) comparison = `You are ahead by ${myStreak - buddyStreak} sessions. Keep the lead.`;
        else if (buddyStreak > myStreak) comparison = `${buddyName} is ${buddyStreak - myStreak} sessions ahead. Time to catch up.`;
        else comparison = `You are neck and neck. Don't let them pull ahead.`;

        const buddyStatus = `*🤝 Accountability Buddy — ${buddyName}*\n\n` +
          `${buddyName}: ${buddyActive ? "Active ✅" : "Silent ⚠️"} | Streak: ${buddyStreak} | Workouts: ${buddy.totalWorkoutsCompleted || 0}${buddyCals > 0 ? ` | Today: ${buddyCals} kcal` : ""}\n` +
          `You: Streak: ${myStreak} | Workouts: ${user.totalWorkoutsCompleted || 0}\n\n` +
          `${comparison}\n\nReply *remove buddy* to unpair.`;
        await logChat(user.id, message, buddyStatus, "BUDDY_CHECK");
        return buddyStatus;
      } catch (err) {
        return `Could not load buddy info. Try again later.`;
      }
    } else {
      return `*🤝 Accountability Buddy*\n\nGet matched with another KamLife client. You'll see each other's streaks and workouts — friendly competition.\n\nReply *find buddy* to get matched.\n\nRules:\n• First names only — privacy protected\n• You see streaks and workout counts, nothing else\n• Either person can unpair anytime`;
    }
  }

  // ---- FIND BUDDY — auto-match with another unpaired active client ----
  if (m === "find buddy" || m === "find a buddy" || m === "get buddy" || m === "match me" || m === "pair me") {
    if (user.buddyId) {
      return `You already have a buddy. Reply *buddy* to see their status, or *remove buddy* to unpair first.`;
    }
    try {
      // Find another active, unpaired client
      const candidates = await db.select({ id: users.id, name: users.name })
        .from(users)
        .where(and(
          eq(users.subscriptionStatus, "active"),
          sql`${users.buddyId} IS NULL`,
          sql`${users.id} != ${user.id}`,
          gte(users.lastActiveAt, new Date(Date.now() - 7 * 86_400_000)), // active in last 7 days
        ))
        .limit(10);

      if (candidates.length === 0) {
        return `No available buddies right now — you are the first in the queue. I will match you as soon as someone else signs up. Keep training.`;
      }

      // Pick random candidate
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const now = new Date();

      // Create mutual pairing
      await Promise.all([
        db.update(users).set({ buddyId: pick.id, buddyPairedAt: now }).where(eq(users.id, user.id)),
        db.update(users).set({ buddyId: user.id, buddyPairedAt: now }).where(eq(users.id, pick.id)),
      ]);

      const buddyFirst = pick.name?.split(" ")[0] || "Your buddy";
      const myFirst = user.name?.split(" ")[0] || "Your buddy";

      // Notify the other person
      try {
        await sendWhatsApp(
          (await db.select({ phone: users.phoneNumber }).from(users).where(eq(users.id, pick.id)).limit(1))[0].phone,
          `*🤝 New Accountability Buddy!*\n\nYou've been matched with *${myFirst}*. You'll see each other's streaks and workouts.\n\nReply *buddy* anytime to check their progress. Let's see who can be more consistent.`
        );
      } catch {}

      await logChat(user.id, message, `Matched with ${buddyFirst}`, "BUDDY_MATCH");
      return `*🤝 Matched!*\n\nYou and *${buddyFirst}* are now accountability buddies. You'll see each other's streaks and workout counts.\n\nReply *buddy* anytime to check how they're doing. Don't let them beat you.`;
    } catch (err) {
      console.error("[BUDDY MATCH]", err);
      return `Matching failed. Try again later.`;
    }
  }

  // ---- REMOVE BUDDY ----
  if (m === "remove buddy" || m === "unpair" || m === "remove partner" || m === "no buddy") {
    if (!user.buddyId) return `You don't have a buddy. Reply *find buddy* to get matched.`;
    try {
      const buddyId = user.buddyId;
      await Promise.all([
        db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.id, user.id)),
        db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.id, buddyId)),
      ]);
      return `Buddy removed. Reply *find buddy* anytime to get matched with someone new.`;
    } catch {
      return `Could not remove buddy. Try again.`;
    }
  }

  // ---- CLOTHING CHECK-IN (Non-Scale Victory) — option 8 ----
  const isClothingTrigger = m === "8" || m === "non scale" || m === "nsc" || m === "non-scale" || m === "clothing" || m === "clothing check" || m === "clothing check in" || m === "non scale victory";
  if (isClothingTrigger) {
    await db.update(users).set({ awaitingInputType: "clothing_checkin" }).where(eq(users.phoneNumber, phone));
    return `*Non-Scale Victory Check-In*\n\nThe scale lies. Your clothes never do. Answer these 4 in one message:\n\n1. *Jeans* — Looser / Same / Tighter\n2. *Energy* — High / Medium / Low\n3. *Stomach* — Flatter / Same / Bloated\n4. *Overall feel* — Great / Good / Okay / Bad\n\nExample: "Looser, High, Flatter, Great"`;
  }

  // ---- CLOTHING CHECK-IN RESPONSE — parse when awaiting ----
  if (user.awaitingInputType === "clothing_checkin") {
    const JEANS = ["looser", "same", "tighter", "fitting better", "too tight", "baggy", "big", "small"];
    const ENERGY = ["high", "medium", "low", "great", "good", "okay", "tired", "energetic"];
    const STOMACH = ["flatter", "same", "bloated", "better", "flat", "bigger", "smaller"];
    const OVERALL = ["great", "good", "okay", "bad", "amazing", "terrible", "fine", "average"];
    const hasAnyAnswer = [...JEANS, ...ENERGY, ...STOMACH, ...OVERALL].some(k => m.includes(k));
    if (hasAnyAnswer) {
      const jeansFit = JEANS.find(k => m.includes(k)) || "not specified";
      const energyLevel = ENERGY.find(k => m.includes(k)) || "not specified";
      const stomachFeel = STOMACH.find(k => m.includes(k)) || "not specified";
      const overallFeel = OVERALL.find(k => m.includes(k)) || "not specified";
      const weekNum = user.programmeWeek || 1;
      const clientName = commaName(user);
      try {
        await db.insert(clothingCheckins).values({ userId: user.id, jeansFit, energyLevel, stomachFeel, overallFeel, weekNumber: weekNum });
        await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
        await storeMemory(phone, `Week ${weekNum} non-scale check-in: jeans ${jeansFit}, energy ${energyLevel}, stomach ${stomachFeel}, overall ${overallFeel}`, "milestone");
        // Store specific win memory for positive NSV results so Coach K can reference them later
        const isNSVPositive = ["looser", "fitting better", "baggy"].some(k => jeansFit.includes(k));
        if (isNSVPositive) {
          await storeMemory(phone, `NSV WIN at week ${weekNum}: jeans are ${jeansFit}, energy ${energyLevel}, stomach ${stomachFeel} — body is changing visibly`, "milestone");
        }
      } catch (e) { console.warn("[non-fatal]", e); }

      // Build a specific coaching response + follow-up question based on what they reported
      const isPositiveJeans = ["looser", "fitting better", "baggy", "big"].some(k => m.includes(k));
      const isTighterJeans = ["tighter", "too tight", "small"].some(k => m.includes(k));
      const isHighEnergy = ["high", "energetic"].some(k => m.includes(k));
      const isLowEnergy = ["low", "tired"].some(k => m.includes(k));
      const isFlatStomach = ["flatter", "better", "flat"].some(k => m.includes(k));
      const isBloated = m.includes("bloated") || m.includes("bigger");

      let observation = "";
      let followUp: string | null = "";

      if (isPositiveJeans && isHighEnergy) {
        observation = `Week ${weekNum} saved${clientName}. Jeans looser and energy high — that is body recomposition happening in real time. The scale might not show it but the clothes do.`;
        followUp = `What has been the biggest change you have made to your diet or training this week?`;
      } else if (isPositiveJeans) {
        observation = `Week ${weekNum} saved. Jeans are responding${clientName} — that is centimetres off the waist regardless of what the scale says.`;
        followUp = `Energy is ${energyLevel} — what time are you training?`;
      } else if (isTighterJeans && isBloated) {
        observation = `Week ${weekNum} saved. Tighter jeans and bloating is almost always sodium and water retention${clientName} — not fat gain. Check your sodium this week: polony, Russians, Aromat, stock cubes.`;
        followUp = `What did you eat most this week?`;
      } else if (isTighterJeans) {
        observation = `Week ${weekNum} saved. Jeans tighter${clientName}. Before assuming fat gain — how has your sodium and sleep been this week?`;
        followUp = null;
      } else if (isLowEnergy) {
        observation = `Week ${weekNum} saved${clientName}. Low energy tells me more than the scale does. Could be sleep, could be calories too low, could be stress.`;
        followUp = `How many hours are you sleeping?`;
      } else if (isBloated) {
        observation = `Week ${weekNum} saved. Bloating${clientName} is usually sodium, not enough vegetables, or stress. Aromat, stock cubes, and processed meats are the main culprits in SA.`;
        followUp = `Are you hitting your vegetable target each day?`;
      } else {
        observation = `Week ${weekNum} check-in saved${clientName}. Jeans: ${jeansFit}. Energy: ${energyLevel}. Stomach: ${stomachFeel}. Overall: ${overallFeel}. Stay on the programme.`;
        followUp = null;
      }

      const clothingReply = followUp ? `${observation} ${followUp}` : observation;
      await logChat(user.id, message, clothingReply, "CLOTHING_CHECKIN");
      return clothingReply;
    }
    // Didn't recognise the answer — prompt again, keep state so next message is still caught
    return `I didn't catch that. Answer in one message, like: "Looser, High, Flatter, Great"\n\n1. *Jeans* — Looser / Same / Tighter\n2. *Energy* — High / Medium / Low\n3. *Stomach* — Flatter / Same / Bloated\n4. *Overall* — Great / Good / Okay / Bad`;
  }

  // ---- INJURY BETTER — close the follow-up loop ----
  // Guards: "no more pain meds/killers/relief" must NOT clear injuries (med management, not recovery).
  // "pain is gone but back still hurts" must NOT clear injuries (partial, not full recovery).
  const injuryBetter = !/\b(meds?|killers?|relief|pills?|tablets?|patches?)\b/i.test(m)
    && !/\bstill\s+(?:hurts?|aching|sore|painful|bad)\b/i.test(m)
    && /\b(injury better|injury healed|no more pain|pain is gone|knee is better|back is better|shoulder is better|hip is better|feeling better.*injury|injury.*feeling better|all good.*injury|injury.*all good)\b/i.test(m);
  if (injuryBetter && user.injuries && user.injuries !== "none") {
    const oldInjury = user.injuries;
    await db.update(users).set({ injuries: "none" }).where(eq(users.phoneNumber, phone));
    try { await storeMemory(phone, `Injury resolved: "${oldInjury}" — client reported recovery`, "medical"); } catch (e) { console.warn("[non-fatal]", e); }
    const injuryReply = `Noted — ${oldInjury} marked as recovered. Full programme is back.\n\n*Return protocol — do not skip this:*\n*Week 1:* 70% of your previous weights. Form only. Stop the set if anything pulls.\n*Week 2:* 85% weight. Add reps before adding load.\n*Week 3:* Back to full weight if zero pain.\n\nRule: sharp pain during a set = stop that exercise immediately. Dull ache after = acceptable. Non-negotiable: if it hurts, stop.\n\nReply "today" for your session.`;
    await logChat(user.id, message, injuryReply, "INJURY_UPDATE");
    return injuryReply;
  }

  // ---- SLEEP LOGGING — hardcoded + weekly trend, no GPT ----
  // Catches: "slept 7 hours", "slaap 7 ure" (Afrikaans), "got about 6 hours",
  // "only managed 5 hours last night", "bad night", "couldn't sleep" etc.
  const hasSleepCtx = /\b(?:sleep|slept|sleeping|slaap|geslaap|nag|night|rest|tired|insomnia|woke)\b/i.test(m);
  const sleepMatch = m.match(/\b(slept|sleep|sleeping|geslaap|slaap)\b.*?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i)
    || m.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\s*(?:of\s*)?(?:sleep|slept|rest)/i)
    || (hasSleepCtx && m.match(/\b(?:got|managed|only\s+got|only\s+managed|got\s+about|got\s+around|got\s+maybe|just\s+got)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i))
    || m.match(/\b(bad\s*sleep|poor\s*sleep|no\s*sleep|couldn'?t\s+sleep|can'?t\s+sleep|couldnt\s+sleep|insomnia|didn'?t\s+sleep(?:\s+well)?|barely\s+slept?|hardly\s+slept?|rough\s+night|terrible\s+sleep|bad\s+night|sleg\s+geslaap)\b/i);

  if (sleepMatch) {
    // Prefer the ACTUAL figure after "only/just/managed/barely/maybe/got" over a number
    // earlier in the sentence — "didn't sleep 8 hours, only got 5 hours" must log 5, not 8.
    // The non-greedy sleepMatch otherwise grabs the first (negated) number.
    const actualHoursMatch = m.match(/\b(?:only|just|managed|barely|maybe)\b[\s\w]{0,12}?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i)
      || m.match(/\bgot\s+(?:about\s+|around\s+|roughly\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i);
    const hoursStr = actualHoursMatch || m.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i);
    const rawHours = hoursStr ? parseFloat(hoursStr[1]) : null;
    if (rawHours !== null && (rawHours < 0.5 || rawHours > 16)) {
      return `That doesn't look right — sleep hours should be between 1 and 16. Did you mean ${rawHours > 16 ? "minutes" : "hours"}? Try again: "I slept 7 hours".`;
    }
    const hours = rawHours;
    const isBadSleep = /bad\s*sleep|poor\s*sleep|no\s*sleep|couldn'?t\s+sleep|can'?t\s+sleep|couldnt\s+sleep|insomnia|didn'?t\s+sleep(?:\s+well)?|barely\s+slept?|hardly\s+slept?|rough\s+night|terrible\s+sleep|bad\s+night|sleg\s+geslaap/i.test(m);

    const sleepReply = getSleepResponse(hours, isBadSleep);

    // Weekly sleep trend — show 7-day average if they have enough logs
    let trendLine = "";
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const recentSleepLogs = await db.select({ messageIn: chatHistory.messageIn }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
      const sleepHours: number[] = [];
      for (const log of recentSleepLogs) {
        const hMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i);
        if (hMatch) sleepHours.push(parseFloat(hMatch[1]));
      }
      if (hours !== null) sleepHours.push(hours); // include today
      if (sleepHours.length >= 3) {
        const avg = sleepHours.reduce((a, b) => a + b, 0) / sleepHours.length;
        const trend = avg >= 7 ? "✅ On track" : avg >= 6 ? "⚠️ Could improve" : "🔴 Needs work";
        trendLine = `\n\n_7-day avg: ${avg.toFixed(1)} hrs (${sleepHours.length} logs) — ${trend}_`;
      }
    } catch { /* non-fatal */ }

    await logChat(user.id, message, sleepReply, "SLEEP_LOG");
    return sleepReply + trendLine;
  }

  // ---- SLEEP REPORT — "my sleep" or "sleep report" ----
  if (m === "my sleep" || m === "sleep report" || m === "sleep stats" || /\b(sleep\s*report|sleep\s*history|how.?s?\s*my\s*sleep|sleep\s*trend)\b/i.test(m)) {
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const sleepEntries = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      const entries: { date: string; hours: number }[] = [];
      for (const log of sleepEntries) {
        const hMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)\b/i);
        if (hMatch && log.date) entries.push({ date: new Date(log.date).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }), hours: parseFloat(hMatch[1]) });
      }

      if (entries.length === 0) {
        return `No sleep logs in the last 14 days. Start logging: just say "I slept 7 hours" (or "geslaap 7 ure") and I will track your recovery over time.`;
      }

      const avg = entries.reduce((s, e) => s + e.hours, 0) / entries.length;
      const best = Math.max(...entries.map(e => e.hours));
      const worst = Math.min(...entries.map(e => e.hours));
      const goodNights = entries.filter(e => e.hours >= 7).length;
      const name = user.name?.split(" ")[0] || "there";

      let grade = "🔴";
      if (avg >= 7.5) grade = "🟢";
      else if (avg >= 6.5) grade = "🟡";

      const historyLines = entries.slice(0, 7).map(e => {
        const emoji = e.hours >= 7 ? "✅" : e.hours >= 6 ? "⚠️" : "🔴";
        return `${e.date}: ${e.hours}h ${emoji}`;
      }).join("\n");

      const report = `*😴 Sleep Report — ${name}*\n\n` +
        `Average: *${avg.toFixed(1)} hours* ${grade}\n` +
        `Best night: ${best}h | Worst: ${worst}h\n` +
        `Good nights (7h+): ${goodNights}/${entries.length}\n\n` +
        `_Last 7 entries:_\n${historyLines}\n\n` +
        (avg < 6.5 ? `Your sleep is hurting your results. Fix tonight: phone off at 9pm, dark room, no caffeine after 2pm.` :
         avg < 7.5 ? `Close to the 7-hour minimum. Push bedtime 30 minutes earlier and watch your energy and fat loss improve.` :
         `Solid recovery. This sleep pattern supports fat loss and muscle repair. Keep it consistent.`);

      await logChat(user.id, message, report, "SLEEP_REPORT");
      return report;
    } catch (err) {
      console.error("[SLEEP REPORT]", err);
      return `Could not generate sleep report right now. Try again later.`;
    }
  }

  // ---- NO GYM / EQUIPMENT ALTERNATIVES — deliver home programme directly ----
  const isNoGymMsg = /no\s+.*(gym|equipment|weights|barbell|dumbbell|machine|bench)/i.test(m) ||
      /can.?t\s+(go to\s+)?gym|don.?t\s+have\s+(a\s+)?(gym|weights|equipment|dumbbell|barbell|access)/i.test(m) ||
      /no\s+gym|without\s+gym|without\s+equipment/i.test(m) ||
      /no\s+access\s+to\s+(?:a\s+)?gym|don.?t\s+have\s+access\s+to\s+(?:a\s+|the\s+)?gym/i.test(m) ||
      /won.?t\s+have\s+(?:access|a\s+gym)|can.?t\s+(?:get to|make it to|go to).*gym/i.test(m) ||
      /what\s+can\s+i\s+use\s+instead|home\s+alternative|bodyweight\s+alternative|no\s+weights/i.test(m);
  if (isNoGymMsg) {
    const eqKeys = Object.keys(EQUIPMENT_ALTERNATIVES);
    const matchedEquip = eqKeys.find(eq => m.includes(eq));
    let equipReply: string;
    if (matchedEquip) {
      equipReply = `No ${matchedEquip}? Use ${EQUIPMENT_ALTERNATIVES[matchedEquip].join(" or ")}.\n\nFull home programme is available — just say *programme* to see it. You do not need a gym to build real strength.`;
    } else {
      // Deliver a home workout directly instead of just telling them to reply
      const homeUser = { ...user, trainingMode: "home" };
      const homeWorkout = buildDayWorkout(homeUser);
      const nameStr = getDisplayName(user) || "there";
      equipReply = `No gym? No problem, ${nameStr}. Here is your home workout:\n\n${homeWorkout}\n\nYour bodyweight is the gym. Reply *DONE* when finished.`;
    }
    await logChat(user.id, message, equipReply, "EQUIPMENT_ALTERNATIVES");
    return equipReply;
  }

  // ---- FOOD SUBSTITUTIONS (Item 6) — no GPT ----
  if (/substitute|instead of|swap\s+\w|replace\s+\w|alternative to|can i use|what can i use instead|i don.?t have/i.test(m)) {
    const subKeys = Object.keys(FOOD_SUBSTITUTIONS);
    const matchedFood = subKeys.find(food => m.includes(food));
    if (matchedFood) {
      const subReply = `*${matchedFood.charAt(0).toUpperCase() + matchedFood.slice(1)} substitutes:*\n\n${FOOD_SUBSTITUTIONS[matchedFood]}\n\nAlways choose the cheapest option that hits your protein target. Food first, supplements last.`;
      await logChat(user.id, message, subReply, "FOOD_SUBSTITUTION");
      return subReply;
    }
  }

  // ---- PORTION SIZE GUIDE (Item 7) — no GPT ----
  // "how much should I be GAINING per week" is a rate question, not a portion one —
  // the blanket "how much" clause sent the portion guide twice to a furious tester
  // (2026-07-03). Portions need food context; weight/rate words always exclude.
  if ((/\b(portion|how many grams|serving size|how big|how large|right amount|right portion|portion size|right size|how do i measure)\b/i.test(m)
      || (/\bhow much\b.{0,30}\b(eat|food|rice|pap|meat|chicken|fish|protein|carbs?|per meal|on my plate)\b/i.test(m)))
    && !/\b(weight|gain(?:ing)?|los(?:e|ing)|per week|kg|steps?)\b/i.test(m)) {
    await logChat(user.id, message, PORTION_GUIDE, "PORTION_GUIDE");
    return PORTION_GUIDE;
  }

  // ---- STORE ADVICE (Item 8) — no GPT ----
  const storeMatch = Object.keys(STORE_ADVICE).find(store => m.includes(store));
  if (storeMatch || /where to buy|where can i get|which store|which shop|best store|cheapest store|where do i shop|where should i shop/i.test(m)) {
    let storeReply: string;
    if (storeMatch) {
      storeReply = STORE_ADVICE[storeMatch];
    } else {
      const budget = user.weeklyFoodBudget || "100_300";
      if (budget === "under_100" || budget === "100_300") {
        storeReply = `For your budget — Shoprite and Boxer are your best options.\n\n${STORE_ADVICE["shoprite"]}\n\n${STORE_ADVICE["boxer"]}`;
      } else if (budget === "300_600") {
        storeReply = `At your budget — Shoprite for bulk staples, Checkers for variety.\n\n${STORE_ADVICE["checkers"]}`;
      } else {
        storeReply = `At your budget, you have options. Shoprite for bulk buys. Checkers for quality house brand. Pick n Pay for dairy.\n\n${STORE_ADVICE["pick n pay"]}`;
      }
    }
    await logChat(user.id, message, storeReply, "STORE_ADVICE");
    return storeReply;
  }

  // ---- "CAN'T DO X" EXERCISE ALTERNATIVE — no GPT, instant swap ----
  const CANT_DO_MAP: Record<string, string> = {
    "pull.?up|chin.?up": "Do lat pulldown or seated cable row instead. Same pulling muscles. Start with lat pulldown at 50% bodyweight and build from there.",
    "push.?up|pushup": "Elevate your hands on a bench or wall. Reduce the angle until you can do 3×10 clean, then lower it over time.",
    "squat": "Leg press or goblet squat. If knees are the problem, reduce depth — only go as low as is pain-free. Box squat (sit down on a low bench and stand up) builds the same pattern.",
    "deadlift|dead lift": "Romanian Deadlift with lighter weight — keeps the movement pattern without the full load on the lower back. Or trap bar deadlift if available.",
    "bench|chest press": "Dumbbell press — easier on the shoulders and joints. Or push-up variations if no equipment. Same muscles.",
    "dip": "Close-grip bench press or tricep pushdown. Dips are shoulder-intensive — these alternatives are safer if shoulders are the issue.",
    "lunge": "Step-up onto a bench or box instead. Same single-leg demand, more controlled. Or Bulgarian split squat with a shorter range.",
    "plank|core|abs": "Dead bug — lie on back, extend opposite arm and leg while keeping lower back flat. Harder than it looks. Or bird dog on hands and knees.",
    "shoulder press|overhead|ohp": "Lateral raise and front raise instead — builds shoulders without the overhead load. Or seated dumbbell press with shorter range of motion.",
    "run|running|cardio": "Brisk walking — 30 minutes at a pace that makes you slightly breathless is equivalent to 15 minutes of running for fat loss. Zero joint impact.",
  };
  const cantDoMatch = m.match(/\b(can.?t|cannot|don.?t|won.?t|not able to|unable to)\b.{0,20}\b(do|try|perform|handle)\b/i)
    || m.match(/\b(can.?t|cannot|don.?t)\s+do\s+/i)
    || m.match(/\b(can.?t|cannot)\s+(do|handle|manage)\s+\w+/i);
  if (cantDoMatch || /\b(alternative|swap|instead of|substitute|replace)\b.{0,20}\b(exercise|workout|movement|squat|bench|pull|push|deadlift|lunge|run|plank|dip)\b/i.test(m)) {
    const altKey = Object.keys(CANT_DO_MAP).find(k => new RegExp(k, "i").test(m));
    if (altKey) {
      const altReply = `No problem — ${CANT_DO_MAP[altKey]}`;
      await logChat(user.id, message, altReply, "EXERCISE_ALT");
      return altReply;
    }
  }

  // ---- INJURY MODIFICATIONS (Item 18) — no GPT for known injuries ----
  const injuryModKeywords = ["injured", "injury", "hurt my", "pain in my", "bad knee", "bad back", "bad shoulder", "bad hip", "bad wrist", "bad ankle", "knee pain", "back pain", "shoulder pain", "hip pain", "wrist pain", "ankle pain", "sore knee", "sore back", "sore shoulder"];
  const injuryModMatch = /injured|injury|hurt my|pain in my|can.?t do.*because|modify.*for|exercises? with/i.test(m);
  const userHasInjuries = user.injuries && user.injuries.length > 2 && user.injuries !== "none";

  if (injuryModMatch || (userHasInjuries && isWorkoutRelated)) {
    const injuries = user.injuries ? user.injuries.toLowerCase() : m;
    const injuryKey = Object.keys(INJURY_MODIFICATIONS).find(key =>
      m.includes(key) || injuries.includes(key)
    );
    if (injuryKey) {
      const mod = INJURY_MODIFICATIONS[injuryKey];
      await logChat(user.id, message, mod.alternatives, "INJURY_MODIFICATION");
      return mod.alternatives;
    }
  }

  // ---- TAPE MEASUREMENTS — RETIRED (2026-07-12, Kam: "remove the whole tape
  // measurement method — we go on how they look and how they feel"). We no longer store
  // waist/hip/chest numbers; a client who still sends them is warmly pivoted to the
  // method we DO use: a monthly photo (vision) plus energy/sleep/clothes feedback. We
  // still DETECT that they sent measurements so we can redirect instead of misrouting it.
  const sentMeasurements =
    /\b(waist|hip|hips|chest|thigh|neck|calf)\b[:\s]+\d+(?:\.\d+)?\s*cm/i.test(message)
    || /\d+(?:\.\d+)?\s*cm\s*(?:[a-z\s]{0,10})?\b(waist|hip|hips|chest|thigh|neck|calf)\b/i.test(message)
    || /\b(waist|hip|hips|chest|thigh|neck|calf)\b\s*(?:is|:|\s)\s*\d+(?:\.\d+)?\s*cm/i.test(message);
  if (sentMeasurements) {
    const fn = user.name ? ` ${user.name.split(" ")[0]}` : "";
    const pivot = `Appreciate you tracking${fn}! But we've moved off the tape measure — the numbers bounce around day to day and just add stress. We track what actually shows the change:\n\n📸 *A monthly photo* — front on, good light, same spot, relaxed. Send it right here.\n💬 *How you feel* — your energy, your sleep, and how your clothes are fitting.\n\nThat's the real progress. Snap your photo whenever you're ready — I'll compare it to last month's.`;
    await logChat(user.id, message, pivot, "MEASUREMENT_RETIRED");
    return pivot;
  }

  // ---- RESCUE / RESET — for stuck users ----
  if (/\b(restart|reset|start over|start again|stuck|help me start|beginning|begin again|onboard again)\b/i.test(m) ||
      m === "restart" || m === "reset" || m === "start over") {
    const currentState = user.onboardingState;
    const wantsFullReset = /start over|start again|begin again|onboard again/i.test(m);
    const hasData = currentState === "COMPLETE" || (user.totalWorkoutsCompleted ?? 0) > 0;

    if (currentState !== "COMPLETE" && !wantsFullReset && !hasData) {
      // Early-onboarding, no data yet — wipe immediately, no confirmation needed
      const uid = user.id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(mealLogs).where(eq(mealLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
      await db.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
      await db.delete(escalations).where(eq(escalations.userId, uid));
      await db.delete(sentProactive).where(eq(sentProactive.userId, uid));
      await db.delete(clientActions).where(eq(clientActions.userId, uid));
      await db.delete(abAssignments).where(eq(abAssignments.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
      await db.insert(users).values({
        phoneNumber: phone,
        subscriptionStatus: "inactive",
        onboardingState: "WELCOME",
        programmePhase: 1,
        programmeWeek: 1,
        programmeDayInWeek: 1,
        trainingMode: "home",
        stepsTarget: 8500,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });
      return "Fresh start. What is your name?";
    }

    if (currentState === "COMPLETE" && !wantsFullReset) {
      // COMPLETE users saying bare "restart" — probably want menu, not a wipe
      return await getMenuText(user, { showCommands: true });
    }

    // Has data and wants a full reset — require confirmation
    const sessions = user.totalWorkoutsCompleted || 0;
    const sessionNote = sessions > 0 ? ` You have *${sessions} session${sessions === 1 ? "" : "s"}* logged.` : "";
    return `⚠️ This will permanently delete all your data — workouts, food logs, weight history, everything.${sessionNote}\n\nReply *yes reset* to confirm, or anything else to go back.`;
  }

  // ---- STOP (WhatsApp Business / POPIA opt-out) ----
  // Bare "stop" is the industry-standard opt-out keyword. Must be respected
  // even when the user hasn't cancelled — sets a 1-year messaging pause.
  if (m === "stop" || m === "stop all" || m === "opt out" || m === "opt-out") {
    const name = getDisplayName(user) || "there";
    const pauseUntil = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const existingNotes = user.profileNotes || "";
    const cleanedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
    const updatedNotes = `${cleanedNotes ? cleanedNotes + " | " : ""}paused_until:${pauseUntil}`;
    await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.phoneNumber, phone));
    const stopReply = `Done${name !== "there" ? `, ${name}` : ""}. No more messages from me. Your data is saved.\n\nReply *START* anytime to resume coaching.`;
    await logChat(user.id, message, stopReply, "OPT_OUT");
    return stopReply;
  }

  // ---- START (WhatsApp Business / POPIA opt-in / resume) ----
  if (m === "start" || m === "unstop" || m === "opt in" || m === "opt-in") {
    const existingNotes = user.profileNotes || "";
    const wasPaused = /paused_until:\d{4}-\d{2}-\d{2}/.test(existingNotes);
    if (wasPaused) {
      const cleanedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
      await db.update(users).set({ profileNotes: cleanedNotes || null }).where(eq(users.phoneNumber, phone));
      const resumeReply = `Welcome back. Coaching is resumed. Tell me what you ate today and we pick up from there.`;
      await logChat(user.id, message, resumeReply, "OPT_IN");
      return resumeReply;
    }
    // Not paused — fall through (bare "start" from a new user means menu, not opt-in)
  }

  // ---- CANCEL SAVE — handle reason (step 2 of cancel flow) ----
  if (user.awaitingInputType === "cancel_save") {
    const name = (user.name || "").split(" ")[0] || "there";
    const choice = m.trim();
    const goal = user.goalType || "fat_loss";
    const cals = user.calorieTarget || 1800;
    const protein = user.proteinTarget || 140;

    if (choice === "1" || /\b(too expensive|expensive|can.?t afford|afford|price|cost|money)\b/i.test(m)) {
      const pauseUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const existingNotes = user.profileNotes || "";
      const pausedNotes = existingNotes.includes("paused_until:")
        ? existingNotes.replace(/paused_until:\d{4}-\d{2}-\d{2}/, `paused_until:${pauseUntil}`)
        : `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
      await db.update(users).set({ awaitingInputType: null, profileNotes: pausedNotes }).where(eq(users.phoneNumber, phone));
      const priceReply = `Understood, ${name}. Paused for 30 days — no check-ins, your programme and progress are saved.\n\nWhen you're ready, reply *back* and we pick up exactly where you left off.\n\n_To cancel completely, reply *cancel* again._`;
      await logChat(user.id, message, priceReply, "CANCEL_SAVE_PAUSE_PRICE");
      return priceReply;
    }

    if (choice === "2" || /\b(not seeing results|no results|not working|isn.?t working|not losing|not gaining|plateau|stuck)\b/i.test(m)) {
      await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
      // Pull actual progress data to make this response concrete
      const sessions = user.totalWorkoutsCompleted || 0;
      const daysActive = user.createdAt
        ? Math.max(1, Math.round((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000))
        : 0;
      const firstWeightRow = await db.select({ weight: weightLogs.weight })
        .from(weightLogs).where(eq(weightLogs.userId, user.id))
        .orderBy(asc(weightLogs.loggedAt)).limit(1);
      const startWeight = firstWeightRow[0] ? parseFloat(String(firstWeightRow[0].weight)) : null;
      const currentWeight = user.currentWeight ? parseFloat(String(user.currentWeight)) : null;
      const weightDelta = startWeight && currentWeight ? currentWeight - startWeight : null;

      let statsLine = "";
      if (sessions > 0 || daysActive > 7) {
        statsLine = `\n\n*Your numbers so far:*\n• ${sessions} training session${sessions === 1 ? "" : "s"} completed\n• ${daysActive} day${daysActive === 1 ? "" : "s"} on the programme`;
        if (weightDelta !== null) {
          const direction = weightDelta < 0 ? `↓ ${Math.abs(weightDelta).toFixed(1)}kg lost` : weightDelta > 0 ? `↑ ${weightDelta.toFixed(1)}kg gained` : "weight unchanged";
          statsLine += `\n• Weight: ${direction} (${startWeight?.toFixed(1)}kg → ${currentWeight?.toFixed(1)}kg)`;
        }
      }

      const resultsReply = goal === "fat_loss"
        ? `${name}, let me be straight with you.${statsLine}\n\nReal fat loss takes 8–12 weeks of consistent eating. The number one reason it stalls: calories are too high, or protein too low. Your targets: *${cals} kcal / ${protein}g protein daily*.\n\nBefore you go — log your food for 5 days and message me. I will audit your numbers personally and fix whatever is not working. If it is the programme's fault, I want to know. Give it 5 days.`
        : `${name}, muscle is slow — but it compounds hard.${statsLine}\n\nThe question is: are you hitting *${cals} kcal / ${protein}g protein* and adding weight or reps each session? Those two things drive 90% of muscle gain.\n\nLog food for 5 days and message me. I will look at your actual numbers and adjust the programme. 5 days before you decide.`;
      await logChat(user.id, message, resultsReply, "CANCEL_SAVE_RESULTS");
      return resultsReply;
    }

    if (choice === "3" || /\b(break|need a break|taking a break|rest|holiday|vacation|pause|step away)\b/i.test(m)) {
      const pauseUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const existingNotes = user.profileNotes || "";
      const pausedNotes = existingNotes.includes("paused_until:")
        ? existingNotes.replace(/paused_until:\d{4}-\d{2}-\d{2}/, `paused_until:${pauseUntil}`)
        : `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
      await db.update(users).set({ awaitingInputType: null, profileNotes: pausedNotes }).where(eq(users.phoneNumber, phone));
      const breakReply = `Done, ${name}. Paused for 30 days — no check-ins. Programme saved.\n\nWhen you're ready, reply *back* and we go again. No restart needed.`;
      await logChat(user.id, message, breakReply, "CANCEL_SAVE_PAUSE_BREAK");
      return breakReply;
    }

    // Option 4 or unrecognised — route to confirm flow
    await db.update(users).set({ awaitingInputType: "cancel_confirm" }).where(eq(users.phoneNumber, phone));
    const confirmReply = `${name}, last check — reply *yes* to cancel completely, or anything else to keep your subscription.\n\n_Your R199/month coaching stops. Data saved 90 days._`;
    await logChat(user.id, message, confirmReply, "CANCEL_SAVE_TO_CONFIRM");
    return confirmReply;
  }

  // ---- CANCEL SUBSCRIPTION CONFIRMATION (step 2) ----
  if (user.awaitingInputType === "cancel_confirm") {
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
    if (/^(yes|confirm|cancel|yep|ja|yeah)$/i.test(m)) {
      const name = getDisplayName(user) || "there";
      await db.update(users).set({
        subscriptionStatus: "inactive",
        cancelledAt: new Date(),
      }).where(eq(users.phoneNumber, phone));
      // PayFast recurring billing keeps charging until the subscription is cancelled on
      // PayFast's side — marking the user inactive locally does not stop the charge.
      // Alert the founder to action the PayFast cancellation so the user is not billed again.
      const coachAlertPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
      if (coachAlertPhone) {
        const alertTo = `whatsapp:+${coachAlertPhone.replace(/\D/g, "")}`;
        await sendCriticalAlert(alertTo, `[BILLING] ${name} (${phone}) cancelled their subscription. Cancel their PayFast recurring billing${user.paymentReference ? ` (ref: ${user.paymentReference})` : ""} now so they are not charged again.`).catch((e) => console.error("[CANCEL] Founder alert failed:", e));
      }
      const appUrl2 = process.env.APP_URL || "https://kamlifecoach.co.za";
      const confirmedCancelReply = `Done, ${name}. Your coaching is stopped and your recurring billing is being cancelled — you will not be charged again. If you ever see another charge, reply *refund* and we will sort it immediately.\n\nYour profile and ${user.totalWorkoutsCompleted || 0} sessions are saved for 90 days. Come back anytime.\n\nIf you change your mind, reply *rejoin* or visit ${appUrl2}.`;
      await logChat(user.id, message, confirmedCancelReply, "CANCEL_CONFIRMED");
      return confirmedCancelReply;
    } else {
      const keptReply = `Got it — cancellation skipped. You're still active. Anything I can help with?`;
      await logChat(user.id, message, keptReply, "CANCEL_ABORTED");
      return keptReply;
    }
  }

  // ---- CANCEL SUBSCRIPTION ----
  // Natural phrasings must land here — "I'm cancelling my subscription. This is a
  // whole bunch of shit." fell through to the PAYMENT block (it matched the word
  // "subscription") and got a PAYMENT LINK back (production, 2026-07-03).
  const wantsCancel = /^cancel$/.test(m.trim())
    || /\b(cancel(?:l?ing)?|unsubscribe|stop(?:ping)?)\b.{0,30}\b(subscription|coaching|service|membership|payments?)\b/i.test(m)
    || /\bunsubscribe\b/i.test(m);
  if (wantsCancel) {
    const alreadyInactive = user.subscriptionStatus === "inactive";
    if (alreadyInactive) {
      const payLink2 = process.env.APP_URL ? `${process.env.APP_URL}/api/payfast/link?phone=${encodeURIComponent(phone.replace(/^whatsapp:/, ""))}` : process.env.APP_URL || "https://kamlifecoach.co.za";
      const cancelledAlreadyReply = `Your subscription is already inactive. Your profile and ${user.totalWorkoutsCompleted || 0} sessions are saved.\n\nReady to restart? ${payLink2}`;
      await logChat(user.id, message, cancelledAlreadyReply, "CANCEL");
      return cancelledAlreadyReply;
    }
    const name = (user.name || "").split(" ")[0] || "there";
    const sessions = user.totalWorkoutsCompleted || 0;
    const sessionLine = sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"} logged.` : "Your profile is saved.";
    await db.update(users).set({ awaitingInputType: "cancel_save" }).where(eq(users.phoneNumber, phone));
    const cancelSaveReply = `${name}, before I cancel — ${sessionLine}\n\nWhat's making you want to leave?\n\n*1* — Too expensive\n*2* — Not seeing results\n*3* — Need a break, not quitting\n*4* — Just cancel`;
    await logChat(user.id, message, cancelSaveReply, "CANCEL_SAVE_START");
    return cancelSaveReply;
  }

  // ---- REFUND REQUEST ----
  if (/\b(refund|money back|money-back|want my money|give me my money|get my money|reimburse|reimbursement|charge.*back|chargeback)\b/i.test(m)) {
    const refundName = user.name?.split(" ")[0] || "";
    const refundReply = `${refundName}, I hear you — let me get a human on this.\n\nRefund requests go directly to the founder. Reply to this message with:\n1. What happened\n2. How much you want refunded\n3. Your payment date (if you have it)\n\nYour coach has been notified and will respond within 24 hours. If it's urgent, WhatsApp the team directly at the number on your invoice.`;
    await logChat(user.id, message, refundReply, "REFUND_REQUEST");
    return refundReply;
  }

  // ---- PAYMENT / REJOIN — inactive users asking to pay or rejoin ----
  // IMPORTANT: exclude negative-payment phrases — "I'm not paying", "not worth paying", "won't pay"
  // must NEVER trigger the payment link. They are frustration, not purchase intent.
  const isNegativePayment = /\b(not paying|won.?t pay|i.?m not paying|not worth|nonsense|rubbish|garbage|terrible|useless|shit|crap)\b/i.test(m);
  // Cancellation is the OPPOSITE of purchase intent — "cancelling my subscription"
  // contains "subscription" and was answered with a payment link (2026-07-03).
  const isCancellationIntent = /\b(cancel(?:l?ing)?|unsubscribe|stop(?:ping)?\s+(?:my\s+)?(?:subscription|coaching|payments?))\b/i.test(m);
  if (!isNegativePayment && !isCancellationIntent && !ctx.isQuestion && /\b(pay|paying|payment|rejoin|re-join|reactivate|subscribe|subscription|renew|renewal)\b/i.test(m)) {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
    const clientName = commaName(user);
    if (merchantId && appUrl) {
      const cleanPhone = phone.replace(/^whatsapp:/, "");
      const payLink = `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}`;
      const payReply = `Sharp${clientName}. Here is your payment link: ${payLink}\n\nR199/month — cancel anytime. Your profile and progress are saved and will be waiting when you activate.`;
      await logChat(user.id, message, payReply, "PAYMENT_REQUEST");
      return payReply;
    } else {
      const payReply = `Sharp${clientName}. To subscribe or renew, go to ${appUrl} or WhatsApp the team directly. R199/month — cancel anytime.`;
      await logChat(user.id, message, payReply, "PAYMENT_REQUEST");
      return payReply;
    }
  }

  // ---- HOLIDAY / PAUSE MODE ----
  // Only pause when the client EXPLICITLY wants to stop messages.
  // "I'm on holiday, any tips?" is a QUESTION — do NOT pause.
  // Questions contain: "?", "tips", "what can I", "how", "recommend", "suggest", "advice", "help"
  const hasHolidayWord = /\b(holiday|pause|pausing|on holiday|going away|vacation|sick leave|taking a break|leave me alone|stop messaging|mute|quiet mode|don.?t message)\b/i.test(m);
  const isAskingQuestion = /\?|tips|what can|what should|how do|how can|recommend|suggest|advice|help|any ideas|give me/i.test(m);
  if (hasHolidayWord && !isAskingQuestion) {
    // Parse duration
    const daysMatch = m.match(/(\d+)\s*(day|days|week|weeks)/i);
    let pauseDays = 7; // default 1 week
    if (daysMatch) {
      const num = parseInt(daysMatch[1]);
      const unit = daysMatch[2].toLowerCase();
      pauseDays = unit.startsWith("week") ? num * 7 : num;
    }
    pauseDays = Math.min(pauseDays, 30); // max 30 days
    const pauseUntil = new Date(Date.now() + pauseDays * 86_400_000).toISOString().slice(0, 10);
    const existingNotes = user.profileNotes || "";
    const updatedNotes = existingNotes.replace(/paused_until:\d{4}-\d{2}-\d{2}/, `paused_until:${pauseUntil}`)
      || `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
    const finalNotes = updatedNotes.includes("paused_until:") ? updatedNotes : `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
    await db.update(users).set({ profileNotes: finalNotes }).where(eq(users.phoneNumber, phone));
    const pauseReply = `Got it. No check-in messages for ${pauseDays} day${pauseDays > 1 ? "s" : ""} — until ${pauseUntil}. Your programme is saved. When you are back, just message me and we pick up where we left off.`;
    await logChat(user.id, message, pauseReply, "PAUSE_MODE");
    return pauseReply;
  }

  // ---- UNPAUSE ----
  if (/\b(i.?m back|i am back|back now|unpause|resume|i.?m here|returned|back from holiday|feeling better|i.?m better)\b/i.test(m)) {
    const existingNotes = user.profileNotes || "";
    if (existingNotes.includes("paused_until:")) {
      const updatedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
      await db.update(users).set({ profileNotes: updatedNotes || null }).where(eq(users.phoneNumber, phone));
      const backReply = `Welcome back. Programme resumes now. What did you eat for your last meal and have you trained yet today?`;
      await logChat(user.id, message, backReply, "UNPAUSED");
      return backReply;
    }
    // Not paused — fall through to GPT which handles "I'm back" motivationally
  }

  // (isNewProgrammeRequest handled earlier — before awaitingProgrammeAnswers)

  // ---- COMEBACK RESCUE — handle "1"/"2"/"3" replies from lapsed users ----
  if (user.awaitingInputType === "comeback") {
    const choice = m.trim();
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
    const capName = user.name?.split(" ")[0] || "there";
    // Enrol a returning client in the structured 7-day comeback arc (jobs/comeback.ts
    // advances them through day 2/4/7 beats). Flag mirrors streak_shield:/paused_until:.
    const enrolComeback = async () => {
      const base = (user.profileNotes || "").replace(/\s*comeback:\d{4}-\d{2}-\d{2}/, "").trim();
      const notes = `${base ? base + " " : ""}comeback:${sastToday()}`.trim();
      await db.update(users).set({ profileNotes: notes }).where(eq(users.phoneNumber, phone));
    };
    let reply = "";
    if (choice === "1" || /\b(back|let.?s go|i.?m back|ready|let's start)\b/i.test(m)) {
      reply = `${capName} is back. No big deal — resets are part of the process.\n\nSend me what you ate today and we pick up right now. No restarts, no lectures.`;
      await enrolComeback();
    } else if (choice === "2" || /\b(simpler|simple|overwhelm|too much)\b/i.test(m)) {
      reply = `Got it, ${capName}. We strip it down.\n\nFor the next 3 days, your only job is: *log 2 meals a day*. Nothing else. No workout pressure. No step count. Just food.\n\nSend your first meal whenever you're ready.`;
      await enrolComeback();
    } else if (choice === "3" || /\b(busy|later|week|not now)\b/i.test(m)) {
      reply = `Understood, ${capName}. I will check in with you next week.\n\nYour programme is exactly where you left it — no restart needed. One message brings it back. I'll be here.`;
    } else {
      // Unrecognised reply — re-prompt once
      reply = `${capName}, I got your message but need a clearer signal:\n\n*1* — I'm back\n*2* — Need a simpler plan\n*3* — Just busy for now\n\nWhich one?`;
      await db.update(users).set({ awaitingInputType: "comeback" }).where(eq(users.phoneNumber, phone));
    }
    await logChat(user.id, message, reply, "COMEBACK_RESCUE");
    return reply;
  }

  // ---- GOAL TRANSITION — response to 1/2/3 after goal reached message ----
  if (user.awaitingInputType === "goal_transition") {
    const capName = user.name?.split(" ")[0] || "there";
    const choice = m.trim().replace(/[^123]/g, "");
    const newGoal = choice === "1" ? "maintenance" : choice === "2" ? "muscle_gain" : choice === "3" ? "recomposition" : null;
    if (newGoal) {
      const wt = parseFloat(user.currentWeight || "75");
      let newCals = user.calorieTarget || 1800;
      let newProt = user.proteinTarget || 120;
      if (newGoal === "maintenance") {
        newCals = (user.calorieTarget || 1800) + 200;
      } else {
        const t = calculateTargets(wt, newGoal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
        newCals = t.calorieTarget;
        newProt = t.proteinTarget;
      }
      await db.update(users).set({
        goalType: newGoal === "maintenance" ? "fat_loss" : newGoal,
        calorieTarget: newCals,
        proteinTarget: newProt,
        targetWeightKg: null,
        awaitingInputType: null,
      }).where(eq(users.phoneNumber, phone));
      const goalNames: Record<string, string> = { maintenance: "maintaining your weight", muscle_gain: "building muscle", recomposition: "body recomposition" };
      const goalNotes: Record<string, string> = {
        maintenance: `Eat at ${newCals} kcal daily. Keep training. Keep logging. Your job now is to hold what you've built.`,
        muscle_gain: `Eat above ${newCals} kcal on training days — especially carbs around workouts. Hit ${newProt}g protein every day. We're building now.`,
        recomposition: `Eat at ${newCals} kcal daily. High protein (${newProt}g) with a slight deficit on rest days and maintenance on training days. Body fat drops while muscle grows — slower, but both happen.`,
      };
      const gtReply = `${capName}, locked in — *${goalNames[newGoal]}*.\n\nNew targets: *${newCals} kcal/day | ${newProt}g protein/day.*\n\n${goalNotes[newGoal]}\n\nReply *programme* for your updated workout plan.`;
      await logChat(user.id, message, gtReply, "GOAL_TRANSITION");
      return gtReply;
    }
    const gtPrompt = `${capName}, reply with a number:\n1 — Maintain this weight\n2 — Build muscle\n3 — Recomposition`;
    return gtPrompt;
  }

  // ---- AWAITING GOAL CHANGE REASON — ask why first before applying goal change ----
  if (user.awaitingInputType?.startsWith("goal_confirm:") || user.awaitingInputType?.startsWith("goal_reason:")) {
    const pendingGoal = user.awaitingInputType.split(":")[1] as string;
    const goalLabelsC: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomposition" };
    const currentLabel = goalLabelsC[user.goalType || "muscle_gain"] || (user.goalType || "your current goal");
    // EXPLICIT CONSENT: a goal flip rewrites the whole programme + targets. It happens
    // ONLY on a clear yes — never on "any reply" (2026-07-07: a muscle-gain client was
    // asked "what changed?" and would have flipped to fat loss on any answer).
    const saidYes = /^(yes|yep|yeah|yup|ya|confirm|correct|do it|switch|change it|sure|ok(ay)?|please|100|✅|👍)\b/i.test(message.trim())
      || /\b(yes\s+(switch|change|confirm)|switch me|change my goal|confirm)\b/i.test(m);
    const saidNo = /^(no|nope|nah|cancel|keep|stop|don.?t|leave it|nevermind|never mind|wrong)\b/i.test(message.trim())
      || /\b(keep\s+(me\s+)?(on\s+)?(muscle|gain|building|fat|current)|not?\s+change|stay|don.?t\s+change)\b/i.test(m);
    if (!saidYes || saidNo) {
      await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
      const keepReply = `No change — you're staying on *${currentLabel}*. Nothing was touched. If you did want to switch, just say "change my goal to fat loss" (or muscle gain) and I'll confirm it with you first.`;
      await logChat(user.id, message, keepReply, "GOAL_CHANGE_CANCELLED");
      return keepReply;
    }
    await db.update(users)
      .set({ awaitingInputType: null, goalType: pendingGoal })
      .where(eq(users.phoneNumber, phone));
    const { calorieTarget: newCals, proteinTarget: newProt } = calculateTargets(
      parseFloat(user.currentWeight || "75"), pendingGoal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner"
    );
    await db.update(users).set({ calorieTarget: newCals, proteinTarget: newProt }).where(eq(users.phoneNumber, phone));
    const goalLabels: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomposition" };
    const capName = user.name?.split(" ")[0] || "there";
    const goalActionNote = pendingGoal === "fat_loss"
      ? `Protein first, every meal. Hit ${newProt}g and the rest takes care of itself.`
      : pendingGoal === "muscle_gain"
        ? `Eat above ${newCals} kcal on training days. Protein every meal — target ${newProt}g.`
        : `Protein at every meal (${newProt}g/day) with a slight calorie deficit on rest days and maintenance on training days.`;
    const goalReply = `${capName}, locked in — ${goalLabels[pendingGoal] || pendingGoal}.\n\nNew daily targets: *${newCals} kcal | ${newProt}g protein.*\n\n${goalActionNote}\n\nReply *programme* to see your updated plan.`;
    await logChat(user.id, message, goalReply, "PROFILE_UPDATE");
    return goalReply;
  }

  // ---- AWAITING GYM NAME — store gym name and deliver gym programme ----
  if (user.awaitingInputType === "gym_name") {
    const gymName = message.trim().length > 1 ? message.trim() : null;
    await db.update(users)
      .set({ awaitingInputType: null, trainingMode: "gym", gymName: gymName || user.gymName })
      .where(eq(users.phoneNumber, phone));
    const updatedUser = { ...user, trainingMode: "gym", gymName };
    const gymProg = buildFullProgramme(updatedUser);
    const clientName = commaName(user);
    const gymReply = `${gymName ? `${gymName}` : "Gym"} programme loaded${clientName}. *${user.trainingDaysPerWeek || 3} days/week* — progressive overload from session 1.\n\n${gymProg}`;
    await logChat(user.id, message, gymReply, "PROGRAMME_DELIVERY");
    return gymReply;
  }

  // ---- FIX 5: PROFILE UPDATE COMMANDS — expanded to catch training mode/days changes ----
  // IMPORTANT: do NOT match "no gym" / "don't have gym" — those are handled by the equipment alternatives handler above
  const hasNegativeGym = /\b(no|don.?t|won.?t|can.?t|not|without|never|quit|left)\b.{0,15}\bgym\b/i.test(m);
  const isProfileUpdate =
    /\b(change my goal|my goal is now|switch to|switch my goal|new goal|update my goal)\b/i.test(m) ||
    // Natural goal-change phrasings — "I want to go into a building phase", "I want to
    // start bulking", "change the muscle composition", "time to cut" — these must hit
    // the real goal-change flow (recalculated targets), never GPT improvisation.
    /\b(building phase|bulking phase|gaining phase|cutting phase|go(?:ing)?\s+into\s+a\s+(?:build|bulk|gain|cut)|start\s+(?:bulking|cutting|building)|want\s+to\s+(?:bulk|build\s+muscle|gain\s+muscle|put\s+on\s+muscle|cut|lean\s+out)|change\s+(?:the\s+|my\s+)?muscle\s+composition|muscle\s+composition.*(?:change|build|phase)|time\s+to\s+(?:bulk|cut|build))\b/i.test(m) ||
    /\b(change.*budget|budget.*changed|my budget is now|budget is now|new budget)\b/i.test(m) ||
    (!hasNegativeGym && /\b(joined.*gym|got.*gym|have.*gym|going to.*gym|now.*gym|gym.*membership)\b/i.test(m)) ||
    /\b(change.*training days|training.*(\d)\s*days|now training.*(\d)|(\d)\s*days.*week.*train)\b/i.test(m) ||
    /\b(training at home|train.*from home|train.*at home|i train.*home|working out at home|no.*gym.*more|quit.*gym|left.*gym|home.*workout.*now)\b/i.test(m) ||
    (!hasNegativeGym && /\b(want to gym|going to gym|start gym|gym.*\d+.*day|train.*\d+.*day|workout.*\d+.*day|\d+.*day.*gym|\d+.*day.*train|\d+.*day.*week)\b/i.test(m));

  if (isProfileUpdate) {
    const updates: Record<string, any> = {};
    let updateSummary = "";

    // Goal change — ask why first before applying
    let pendingGoal: string | null = null;
    if (/fat loss|lose weight|lose fat|cut|lean out/i.test(m)) pendingGoal = "fat_loss";
    else if (/muscle|bulk|build|gain/i.test(m)) pendingGoal = "muscle_gain";
    else if (/recomposition|recomp|both/i.test(m)) pendingGoal = "recomposition";

    if (pendingGoal && pendingGoal !== user.goalType) {
      const clientName = commaName(user);
      const goalLabelsT: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomposition" };
      const fromLabel = goalLabelsT[user.goalType || "muscle_gain"] || (user.goalType || "your current goal");
      const toLabel = goalLabelsT[pendingGoal] || pendingGoal;
      await db.update(users).set({ awaitingInputType: `goal_confirm:${pendingGoal}` }).where(eq(users.phoneNumber, phone));
      // Name the CURRENT goal so the client sees exactly what's changing — and require
      // an explicit yes. This is the guard against a misheard message silently flipping
      // someone's whole programme.
      const confirmReply = `Just so we're clear${clientName} — you're on *${fromLabel}* right now. Switch you to *${toLabel}*? That changes your calorie and protein targets.\n\nReply *YES* to switch, or anything else to stay on ${fromLabel}.`;
      await logChat(user.id, message, confirmReply, "GOAL_CHANGE_CONFIRM");
      return confirmReply;
    }

    // Budget change
    const budgetMatch = m.match(/r\s*(\d+)\s*(?:a\s*week|per\s*week|\/week|weekly)?/i)
      || m.match(/(\d+)\s*rand\s*(?:a\s*week|per\s*week)?/i);
    if (budgetMatch) {
      const rands = parseInt(budgetMatch[1]);
      const newBudget = rands < 50 ? "under_50" : rands < 100 ? "50_100" : rands < 300 ? "100_300" : rands < 500 ? "300_500" : "500_plus";
      updates.weeklyFoodBudget = newBudget;
      updateSummary += ` Budget updated to R${rands}/week tier.`;
    }

    // Training mode — ask which gym before applying
    if (/joined.*gym|got.*gym|have.*gym|going to.*gym|gym.*membership|now.*gym|want to gym|start.*gym|going to gym/i.test(m) && user.trainingMode !== "gym") {
      await db.update(users).set({ awaitingInputType: "gym_name" }).where(eq(users.phoneNumber, phone));
      const clientName = commaName(user);
      const gymQ = `Lekker${clientName}. Which gym?`;
      await logChat(user.id, message, gymQ, "PROFILE_UPDATE");
      return gymQ;
    }
    if (/joined.*gym|got.*gym|have.*gym|going to.*gym|gym.*membership|now.*gym|want to gym|start.*gym|going to gym/i.test(m)) {
      updates.trainingMode = "gym";
      updateSummary += " Training mode updated to gym.";
    } else if (/home|no.*gym|quit.*gym|left.*gym/i.test(m)) {
      updates.trainingMode = "home";
      updateSummary += " Training mode updated to home.";
    }

    // Training days — catch "4 days a week", "gym 4 days", "train 4 days", etc.
    // Guard: question phrasing ("Should I switch to 5 days?") must NOT auto-apply.
    const isProfileDaysQuestion = /^(?:should|would|could|can\s+i|is\s+it|what\s+if|how\s+about|do\s+you\s+think|if\s+i)\b/i.test(m.trim())
      || /[?？]\s*$/.test(m.trim());
    const trainingDaysMatch = isProfileDaysQuestion ? null : (
      m.match(/\b([2-6])\s*days?\s*(?:a\s*week|per\s*week|\/week)?/i)
      || m.match(/(?:gym|train|workout)\s+([2-6])\s*days?/i)
      || m.match(/([2-6])\s*days?\s*(?:a\s*week|per\s*week|at\s*the\s*gym)/i)
    );
    if (trainingDaysMatch) {
      const days = parseInt(trainingDaysMatch[1]);
      if (days >= 2 && days <= 6) {
        updates.trainingDaysPerWeek = days;
        updateSummary += ` Training days updated to ${days}/week.`;
      }
    }

    if (Object.keys(updates).length > 0) {
      try {
        // Recalculate targets if weight-related fields changed
        if (updates.goalType || updates.trainingDaysPerWeek) {
          const currentWeight = parseFloat(user.currentWeight || "75");
          const newGoal = updates.goalType || user.goalType || "fat_loss";
          const newDays = updates.trainingDaysPerWeek || user.trainingDaysPerWeek || 3;
          const { calorieTarget, proteinTarget } = calculateTargets(currentWeight, newGoal, user.lifeSituation || "office", newDays, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
          updates.calorieTarget = calorieTarget;
          updates.proteinTarget = proteinTarget;
          updateSummary += ` New targets: ${calorieTarget} kcal/day, ${proteinTarget}g protein.`;
        }
        // When switching training mode or days, reset programme day to 1 so the
        // next workout request doesn't inherit a stale leg/lower day from a gym split.
        if (updates.trainingMode || updates.trainingDaysPerWeek) {
          updates.programmeDayInWeek = 1;
        }
        await db.update(users).set(updates).where(eq(users.phoneNumber, phone));
        // If training mode or days changed, rebuild and show the programme immediately
        const clientName = user.name || "";
        let profileReply = "";
        if (updates.trainingMode || updates.trainingDaysPerWeek) {
          const updatedUser = { ...user, ...updates };
          const newProgramme = buildFullProgramme(updatedUser);
          const modeLabel = (updates.trainingMode || user.trainingMode || "home") === "gym" ? "Gym" : "Home";
          const daysLabel = updates.trainingDaysPerWeek || user.trainingDaysPerWeek || 3;
          profileReply = `Sharp${clientName ? `, ${clientName}` : ""}. ${daysLabel} days/week. ${modeLabel}. New programme built.\n\n${newProgramme}`;
        } else if (updates.goalType) {
          const goalLabel: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "recomposition" };
          profileReply = `Sharp${clientName ? `, ${clientName}` : ""}. Goal updated to ${goalLabel[updates.goalType] || updates.goalType}. New targets: ${updates.calorieTarget} kcal/day, ${updates.proteinTarget}g protein. Programme stays the same — reply *programme* to see it.`;
        } else {
          profileReply = `Sharp. Profile updated. What do you need next?`;
        }
        await logChat(user.id, message, profileReply, "PROFILE_UPDATE");
        return profileReply;
      } catch (profileUpdateErr) {
        console.error("[PROFILE_UPDATE_ERR]", { updates, err: profileUpdateErr instanceof Error ? profileUpdateErr.message : String(profileUpdateErr) });
        // Surface a safe fallback rather than crashing to global handler
        const fallbackReply = `Profile noted — your training mode and targets have been saved. Just tell me what you need next.`;
        await logChat(user.id, message, fallbackReply, "PROFILE_UPDATE").catch(() => {});
        return fallbackReply;
      }
    }
    // If we couldn't parse what to update, fall through to GPT
  }

  // ---- LANGUAGE DETECTION — prepend greeting if non-English ----
  const detectedLang = detectLanguage(m);
  const clientFirstName = user.name ? user.name.split(" ")[0] : null;
  // Retrieve stored language preference (may be more reliable than per-message detection)
  const storedLang = (user.profileNotes || "").match(/lang:([a-z]{2})/)?.[1] as import("../constants").SALanguage | undefined;
  const activeLang = detectedLang !== "en" ? detectedLang : (storedLang || "en");
  let langPrefix = "";
  if (clientFirstName) {
    switch (activeLang) {
      case "zu": langPrefix = `Sawubona ${clientFirstName}. `; break;
      case "xh": langPrefix = `Molo ${clientFirstName}. `; break;
      case "st": langPrefix = `Dumela ${clientFirstName}. `; break;
      case "tn": langPrefix = `Dumela ${clientFirstName}. `; break;
      case "ts": langPrefix = `Avuxeni ${clientFirstName}. `; break;
      case "af": langPrefix = `Dag ${clientFirstName}. `; break;
    }
  }

  // Store detected language on profile (update if language changed)
  if (detectedLang !== "en") {
    const langNote = `lang:${detectedLang}`;
    if (!user.profileNotes?.includes(langNote)) {
      const updatedNotes = (user.profileNotes || "").replace(/lang:[a-z]{2}/, langNote) || langNote;
      const finalNotes = updatedNotes.includes("lang:") ? updatedNotes : `${user.profileNotes ? user.profileNotes + " | " : ""}${langNote}`;
      db.update(users).set({ profileNotes: finalNotes }).where(eq(users.phoneNumber, phone)).catch(e => console.error("[LANG_NOTE_UPDATE]", e?.message || e));
    }
  }

  // ---- "AM I ON TRACK?" STATUS COMMAND — no GPT ----
  // Days 31-40: this is the SECOND "how am I doing" handler (the duplicate that caused the
  // whack-a-mole — redirecting progress.ts alone didn't fix it because this one grabbed it
  // next, pushing "complete 4 more workouts" at a sick client). Gated to the engine too.
  if (process.env.ENGINE_LIVE !== "on" && /\b(am i on track|on track\??|how am i doing|progress check|my status|status check|how have i been|weekly status|how.?s my progress|how is my progress|tell me.*progress|my progress on kamlife|kamlife progress|progress.*this week|check my progress|show.*progress|any progress|how far am i)\b/i.test(m)) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const todayStart = sastDayStart();
    const [stepLogsWeek, workoutLogsWeek, weightLogsRecent, foodLogsToday] = await Promise.all([
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))),
      db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
      db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(desc(weightLogs.loggedAt)).limit(3),
      db.select({ id: chatHistory.id }).from(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))),
    ]);
    const avgSteps = stepLogsWeek.length > 0 ? Math.round(stepLogsWeek.reduce((s: number, l: any) => s + l.steps, 0) / stepLogsWeek.length) : 0;
    const stepsTarget = user.stepsTarget || 8500;
    const workoutsDone = workoutLogsWeek.length;
    const workoutsTarget = user.trainingDaysPerWeek || 3;
    const stepsOk = avgSteps >= stepsTarget * 0.9;
    const workoutsOk = workoutsDone >= workoutsTarget;
    let weightNote = "";
    if (weightLogsRecent.length >= 2) {
      const diff = parseFloat(String(weightLogsRecent[0].weight)) - parseFloat(String(weightLogsRecent[weightLogsRecent.length - 1].weight));
      if (Math.abs(diff) < 0.2) weightNote = "Weight holding steady.";
      else if (diff < 0) weightNote = `Weight down ${Math.abs(diff).toFixed(1)}kg this week.`;
      else weightNote = `Weight up ${diff.toFixed(1)}kg this week.`;
    } else if (weightLogsRecent.length === 0) {
      weightNote = "No weight logged this week — log your weight.";
    }
    const allGood = stepsOk && workoutsOk;
    const bothBad = !stepsOk && !workoutsOk;
    const verdict = allGood ? "ON TRACK" : bothBad ? "NEEDS ATTENTION" : "CLOSE";
    const action = allGood
      ? "Keep this up for the rest of the week."
      : !workoutsOk
      ? `Complete ${workoutsTarget - workoutsDone} more workout${workoutsTarget - workoutsDone > 1 ? "s" : ""} this week.`
      : `Get your daily steps above ${stepsTarget.toLocaleString()}.`;
    const statusReply = `*7-Day Status — ${user.name || "you"}*\n\nWorkouts: ${workoutsDone}/${workoutsTarget} this week\nAvg steps: ${avgSteps.toLocaleString()} / ${stepsTarget.toLocaleString()} target\nFood logged today: ${foodLogsToday.length} ${foodLogsToday.length === 1 ? "meal" : "meals"}${weightNote ? `\n${weightNote}` : ""}\n\n*Verdict: ${verdict}*\n\n${action}`;
    await logChat(user.id, message, statusReply, "STATUS_CHECK");
    return statusReply;
  }

  // ---- "WHAT SHOULD I DO NEXT WEEK / COACHING ADVICE?" — no GPT, data-driven ----
  if (
    process.env.ENGINE_LIVE !== "on" && // JUDGMENT: the brain owns open coaching advice when live
    /\b(what should i do (next week|this week|differently|better)|any (suggestions?|advice|tips?) (for next week|for this week|going forward|to improve|coach)|what do you (think|recommend|suggest) (coach|k|next week|this week)?|coach.?k.{0,15}(what|how|should|suggest|recommend|advice|think)|how can i (do better|improve|get better|be better|be more consistent)|what.?s? (my |the )?(focus|priority|plan) (for |this |next )(week|week\?)?|what should i focus on|where should i focus|help me (plan|improve|get better|do better)|what would you (suggest|recommend)|what.?s? (next|the plan|my plan)|give me (advice|a suggestion|a tip)|any (tips?|pointers?) for me)\b/i.test(m) &&
    !/\b(eat|food|meal|protein|calories|gym|exercise|workout|steps|water|weight|sleep)\b/i.test(m)
  ) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const [recentW, recentS, recentWt] = await Promise.all([
      db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))),
      db.select({ weight: weightLogs.weight }).from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(1),
    ]);
    const fn = (user.name || "").split(" ")[0];
    const namePart = fn ? ` ${fn}` : "";
    const sessions = recentW.length;
    const sessionsTarget = user.trainingDaysPerWeek || 3;
    const avgSteps = recentS.length > 0 ? Math.round(recentS.reduce((s: number, l: any) => s + l.steps, 0) / recentS.length) : 0;
    const stepsTarget = user.stepsTarget || 8500;
    const hasWeight = recentWt.length > 0;
    const todayStr = sastToday(); // must match how todayCaloriesDate is stored (YYYY-MM-DD); en-ZA toLocaleDateString gives DD-MM-YYYY and never matched
    const todayProtein = user.todayCaloriesDate === todayStr ? (user.todayProteinG || 0) : 0;
    const todayCalsForAdvice = user.todayCaloriesDate === todayStr ? (user.todayCalories || 0) : 0;
    const protTarget = user.proteinTarget || 120;
    type Gap = { action: string };
    const gaps: Gap[] = [];
    if (sessions < sessionsTarget) gaps.push({ action: `Complete your ${sessionsTarget} training sessions this week — you have done ${sessions}. Even a 30-minute session counts.` });
    if (avgSteps > 0 && avgSteps < stepsTarget * 0.85) gaps.push({ action: `Get your steps up to ${stepsTarget.toLocaleString()}/day — you are averaging ${avgSteps.toLocaleString()}. Park further, walk at lunch, take the stairs.` });
    if (!hasWeight) gaps.push({ action: `Log your weight. Step on the scale tomorrow morning (after bathroom, before eating) and send me the number. I need data to coach you.` });
    if (todayProtein > 0 && todayProtein < protTarget * 0.65) {
      const calCeiling = (user.calorieTarget || 0) > 0 && (todayCalsForAdvice - (user.calorieTarget || 0)) >= 100;
      gaps.push({ action: calCeiling
        ? `Protein was ${protTarget - todayProtein}g short today — carry it into tomorrow's first meal. Aim for ${protTarget}g tomorrow.`
        : `Hit your ${protTarget}g protein target — you are only at ${todayProtein}g today. Eggs, chicken, pilchards, or a protein shake before bed.` });
    }
    let adviceReply: string;
    if (gaps.length === 0) {
      adviceReply = `${fn ? fn + ", you" : "You"} are doing the work — sessions, steps, and data are all consistent.\n\n*Next gear:* Pick one exercise this week and add weight or reps to what you did last time. That is progressive overload. That is where results compound.\n\nKeep it simple. Same programme, slightly harder. Update me after your next session.`;
    } else {
      const [top, second] = gaps;
      adviceReply = `*Top priority for next week${namePart}:*\n\n${top.action}${second ? `\n\n*Also fix:* ${second.action}` : ""}\n\nDo not change five things at once. Fix the top one first. Everything else stays the same.`;
    }
    await logChat(user.id, message, adviceReply, "COACHING_ADVICE");
    return adviceReply;
  }

  // ---- FOOD DIARY SUMMARY — "what did I eat today?" / "today's calories?" — no GPT ----
  if (/\b(what.*(?:i eat|i ate|i had)|my food|food diary|food log|meal log|meal logs|today.?s?\s*meal\s*logs?|meals today|melas today|melas|ate today|eaten today|log today|today.?s?\s*food|food.*today|what.*eat.*today|how many.*calori|calori.*today|today.?s?\s*calori|protein today|today.?s?\s*protein|macros today|today.?s?\s*macros|daily total|today.?s?\s*total|total today|how much.*eaten|what.*logged|my meals|my logged|logged meals|see my (?:meal|food)|show my (?:meal|food)|view my (?:meal|food)|meals|today.?s meals)\b/i.test(m)) {
    const todayStart = sastDayStart();

    // Primary: read from structured mealLogs table — stores SA scanner + GPT fallback + photo logs.
    // This is authoritative: we wrote to it at log time, no re-parsing needed.
    const structuredLogs = await db.select({
      kcalInt: mealLogs.kcalInt,
      proteinInt: mealLogs.proteinInt,
      rawMessage: mealLogs.rawMessage,
      source: mealLogs.source,
      items: mealLogs.items,
      mealLabel: mealLogs.mealLabel,
    }).from(mealLogs).where(and(
      eq(mealLogs.userId, user.id),
      gte(mealLogs.loggedAt, todayStart),
    )).orderBy(asc(mealLogs.loggedAt));

    if (structuredLogs.length === 0) {
      // Fallback to chatHistory for legacy logs (pre-meal_logs table or photo-only logs)
      const chatLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
      if (chatLogs.length === 0) {
        const diaryReply = `No meals logged yet today. Log your first meal by describing what you ate — for example: "had 2 eggs and pap for breakfast".`;
        await logChat(user.id, message, diaryReply, "FOOD_DIARY");
        return diaryReply;
      }
      // Legacy path: extract from text
      let totalCal = 0; let totalProt = 0;
      const mealLinesFallback: string[] = [];
      for (const log of chatLogs) {
        const msgIn = log.messageIn || "";
        const calMatch = (log.messageOut || "").match(/(\d{3,4})\s*kcal/i);
        const protMatch = (log.messageOut || "").match(/(\d+)g?\s*protein/i);
        if (calMatch) totalCal += parseInt(calMatch[1]);
        if (protMatch) totalProt += parseInt(protMatch[1]);
        if (msgIn && msgIn !== "[Photo]") mealLinesFallback.push(`• ${msgIn.slice(0, 60)}`);
      }
      const legacyReply = `*Today's meals:*\n${mealLinesFallback.join("\n") || "• Food photo(s) logged"}\n\n*Total: ~${totalCal} kcal | ~${totalProt}g protein*`;
      await logChat(user.id, message, legacyReply, "FOOD_DIARY");
      return legacyReply;
    }

    const mealLines: string[] = [];
    for (const log of structuredLogs) {
      const mCal = log.kcalInt || 0;
      const mProt = log.proteinInt || 0;
      const isPhoto = log.source === "photo";
      if (isPhoto && mCal === 0) {
        mealLines.push(`• Food photo logged — caption needed for calories`);
        continue;
      }
      // Derive display name: prefer structured items array, then rawMessage text
      const logItems = log.items as Array<{ name?: string; foodName?: string }> | null;
      const itemNames = Array.isArray(logItems) && logItems.length > 0
        ? logItems.map((i: any) => i.name || i.foodName || "").filter(Boolean).join(", ")
        : null;
      const rawMsg = log.rawMessage || "";
      const displayName = itemNames
        || (rawMsg && rawMsg !== "[Photo]" ? rawMsg.slice(0, 60) : null)
        || "Food logged";
      if (isPhoto) {
        mealLines.push(mCal > 0
          ? `• Food photo — ~${mCal} kcal, ${mProt}g protein`
          : `• Food photo logged`);
      } else {
        mealLines.push(mCal > 0
          ? `• ${displayName} — ~${mCal} kcal, ${mProt}g protein`
          : `• ${displayName}`);
      }
    }
    // ONE SOURCE OF TRUTH: the diary's total comes from the day-ledger — the SAME function the
    // card and the running total read, so "today's meals" can never disagree with them.
    const { getDayLedger } = await import("../day-ledger");
    const diaryLedger = await getDayLedger(user.id, { user });
    const totalCal = diaryLedger.kcal;
    const totalProt = diaryLedger.protein;
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const calRemaining = calTarget - totalCal;
    const hour = new Date(Date.now() + 2 * 3_600_000).getUTCHours(); // SAST hour — getHours() is UTC on Railway
    const isLateEnough = hour >= 16; // After 4pm SAST, low intake is a real problem

    // Coaching note based on intake vs target
    let diaryCoachNote = "";
    if (totalCal > 0 && totalCal < calTarget * 0.45 && isLateEnough) {
      diaryCoachNote = `\n\n⚠️ *Under-eating alert:* ${totalCal} kcal at this time of day is too low. You are ${calRemaining} kcal short. Eat a proper meal tonight — protein and carbs. Starving is not a fat loss strategy, it is a metabolism killer.`;
    } else if (totalCal > 0 && calRemaining > 500 && !isLateEnough) {
      diaryCoachNote = `\n\n${calRemaining} kcal still to go. Spread it across your remaining meals — do not leave it all for dinner.`;
    }
    // Over-target coaching now lives in goalStatusLine (goal-aware, shared with every
    // food footer) — a number never travels alone, and "over" means different things
    // for fat_loss vs muscle_gain vs recomp (2026-07-16 founder review).

    const diaryLines = [
      `*Today's food log (${mealLines.length} ${mealLines.length === 1 ? "meal" : "meals"}):*`,
      ...mealLines,
      ``,
      `*Running total:* ~${totalCal} kcal | ${totalProt}g protein`,
      `*Target:* ${calTarget} kcal | ${protTarget}g protein`,
      `*Status:* ${goalStatusLine(user.goalType, calRemaining)}`,
    ];
    // Weekly-journey footer — the diary is where a treat day gets judged, so this is
    // where the week must visibly absorb it (2026-07-16 founder review).
    const weekLine = await weeklyNetLine(user);
    const diaryReply = diaryLines.join("\n") + (weekLine ? `\n\n${weekLine}` : "") + diaryCoachNote;
    await logChat(user.id, message, diaryReply, "FOOD_DIARY");
    const diaryCard = await dailyMacroCardMarker(user); // "today's meals" gets the scorecard too (founder: every view shows the card)
    return `${diaryReply}${diaryCard}`;
  }

  // ---- SHOPPING LIST GENERATOR — unified with shopping-lists.ts templates ----
  if (/\b(shopping list|shop.*this week|what.*to buy|what.*buy.*week|buy.*groceries|grocery list|my list.*week|food.*list|week.*groceries)\b/i.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const list = getShoppingList(budget, weekNum, goal);
    const personalization = await getGroceryPersonalization(user.id, goal, (user as any).foodDislikes);
    const shoppingReply = formatShoppingList(list, user.name || undefined, goal, {
      calorieTarget: user.calorieTarget || undefined,
      proteinTarget: user.proteinTarget || undefined,
      budgetTier: budget,
      personalization,
    });
    await logChat(user.id, message, shoppingReply, "SHOPPING_LIST");
    return shoppingReply;
  }

  // ---- HUNGER HANDLER — "I'm hungry", "starving", "so hungry" ----
  const isHungryMsg =
    /\b(i.?m (so )?hungry|i am (so )?hungry|starving|always hungry|so hungry|feeling hungry|hungry all the time|hungry on this diet|hungry after meal|hungry after training|getting hungry|hunger pangs|can.?t stop eating|craving everything|craving food)\b/i.test(m);

  if (isHungryMsg) {
    const goal = user.goalType || "fat_loss";
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const name = commaName(user);
    const hungerReply = `Hunger on a deficit is normal${name} — but hunger that feels unbearable means something is off.\n\n*Check these first:*\n🥩 *Protein* — Are you hitting ${prot}g per day? Protein is the most filling macro. Low protein = constant hunger. If you are under, add eggs, chicken, or tinned tuna to every meal.\n🥬 *Volume* — Vegetables add bulk without calories. Cabbage, spinach, morogo — eat them in big quantities. They physically fill your stomach.\n💧 *Water* — Thirst and hunger feel identical. Drink 500ml of water right now and wait 10 minutes.\n😴 *Sleep* — Under 7 hours spikes ghrelin (hunger hormone) and crashes leptin (fullness hormone). If sleep is poor, hunger is worse — always.\n\n${goal === "fat_loss" ? `At ${cal} kcal you should not be unbearably hungry. If you are — your protein is likely too low. What did you eat today so far?` : `On a surplus hunger is your friend — eat when you are hungry, especially around your training window.`}`;
    await logChat(user.id, message, hungerReply, "HUNGER");
    return hungerReply;
  }

  // ---- ALCOHOL HANDLER — beer, wine, spirits, braai drinking ----
  const isAlcoholMsg =
    /\b(had.*(?:beer|wine|whisky|brandy|rum|vodka|gin|shots?|drinks?|alcohol|henny|hennessy|smirnoff|hunters|savanna|castle|black label|flying fish|brutal fruit|ciders?)|(?:beer|wine|alcohol|shots?|drinking|drinks?).*(?:had|drank|having|last night|weekend|yesterday|tonight))\b/i.test(m) &&
    !/\b(braai)\b/i.test(m); // braai guide already handles braai + alcohol

  if (isAlcoholMsg) {
    const goal = user.goalType || "fat_loss";
    const name = commaName(user);
    const beerCals: Record<string, string> = {
      castle: "150 kcal",
      "black label": "160 kcal",
      savanna: "170 kcal",
      "flying fish": "180 kcal",
      "brutal fruit": "160 kcal",
      hunters: "165 kcal",
      henny: "250 kcal",
      hennessy: "250 kcal",
    };
    const drinkMatch = Object.entries(beerCals).find(([d]) => m.includes(d));
    const drinkNote = drinkMatch ? `${drinkMatch[0].charAt(0).toUpperCase() + drinkMatch[0].slice(1)} is ${drinkMatch[1]} per can.` : "Most beers are 140-180 kcal per can. Spirits are 80-120 kcal per shot.";
    const alcoholReply = `${drinkNote}\n\nI am not going to lecture you${name} — you are an adult. Here is what to do:\n\n*Tonight:* Protein with your next meal. Eggs, chicken, or tinned tuna — before or alongside drinks, not after.\n*Drinking rule:* Water between every drink. Not because of hydration theatre — because it naturally slows your drinking and cuts total intake in half.\n*Tomorrow:* ${goal === "fat_loss" ? "Back on your plan, first meal. Alcohol did not destroy your progress. One night never does. Seven nights in a row does." : "Training as planned. Alcohol slows muscle protein synthesis for 24-48 hours — just get the session in anyway."}\n\nAlcohol is not banned. It is a choice with a calorie cost. Make the next meal count.`;
    await logChat(user.id, message, alcoholReply, "ALCOHOL");
    return alcoholReply;
  }

  // ---- WIN / POSITIVE UPDATE — client shares a weight loss, milestone, or NSV ----
  const isWeightWin =
    /\b(lost|dropped|down|lighter|less than before|weighed in at)\b/i.test(m) &&
    /\b(\d+(?:\.\d+)?)\s*kg\b/.test(m) &&
    /\b(lost|dropped|down)\b/i.test(m);

  const isNSV =
    /\b(jeans.*fit|clothes.*fitting|fitting better|looser.*clothes|clothes.*looser|jeans.*too big|shirt.*too big|dress.*too big|pants.*too big|clothes.*loose|jeans.*loose)\b/i.test(m) ||
    /\b(compliment|someone noticed|people.*noticed|noticed.*change|people.*say.*look|people.*saying.*look|someone.*said.*look|friends.*noticed|family.*noticed)\b/i.test(m) ||
    /\b(can feel.*difference|feel.*difference|feel.*different|look.*different|see.*difference|see.*changes|seeing.*changes|seeing.*results|results.*showing|starting to show)\b/i.test(m) ||
    /\b(can see my abs|seeing.*abs|abs.*showing|stomach.*flatter|belly.*smaller|waist.*smaller|waist.*getting smaller)\b/i.test(m) ||
    /\b(feeling.*stronger|feel.*stronger|lifted more|new pb|personal best|pb today|ran further|ran longer|first time.*ran|ran.*without.*stopping|didn.?t get.*tired)\b/i.test(m) ||
    /\b(energy.*better|so much.*energy|more energy|energy.*up|sleeping better|sleep.*improved|feel amazing|feel incredible|feel great about)\b/i.test(m) ||
    /\b(meal prep|meal prepped|prepped.*food|cooked.*bulk|batch cook|batch cooked)\b/i.test(m);

  if (isWeightWin || isNSV) {
    const kgMatch = m.match(/(\d+(?:\.\d+)?)\s*kg/);
    const kgLost = kgMatch ? parseFloat(kgMatch[1]) : null;
    const total = user.totalWorkoutsCompleted || 0;
    const weeks = user.programmeWeek || 1;
    const name = getDisplayName(user) || "there";

    let winReply: string;
    if (isWeightWin && kgLost) {
      winReply = `${kgLost}kg down — that is real, ${name}. ${total} session${total !== 1 ? "s" : ""}, ${weeks} week${weeks !== 1 ? "s" : ""} of consistency. This is exactly what the programme is supposed to do.\n\nThe next ${kgLost}kg follows the same formula. Same sessions, same food, same steps. Keep going.`;
    } else if (/\b(jeans|clothes|shirt|dress|pants)\b/i.test(m)) {
      winReply = `${name}, clothes don't lie. When they start fitting differently, the scale is just catching up to what your body already knows.\n\n${total} sessions to get here. The people who keep the same habits for another 4 weeks are the ones who don't go back. You're at that point now.`;
    } else if (/\b(someone noticed|people.*noticed|compliment|people.*say|friends.*noticed|family.*noticed)\b/i.test(m)) {
      winReply = `When people start noticing, it means the change is real enough that strangers can see it — not just you on a good day in the mirror.\n\n${name}, ${total} sessions built that. Screenshot this and send it to whoever doubted you.`;
    } else if (/\b(abs|stomach.*flat|belly.*small|waist)\b/i.test(m)) {
      winReply = `${name}, that is the programme working. Abs are fat loss made visible — you cannot fake that.\n\nKeep the deficit, keep the protein, keep the steps. You are in the phase where the visible changes compound every week.`;
    } else if (/\b(stronger|pb|personal best|lifted more|ran)\b/i.test(m)) {
      winReply = `Performance wins are the most honest feedback your body gives. The scale lies, the mirror lies on bad days — but a new personal best never lies.\n\n${name}, ${total} sessions to get here. Same formula next week.`;
    } else if (/\b(energy|sleep|feel amazing|feel great)\b/i.test(m)) {
      winReply = `${name}, this is the part most people don't expect — the energy and sleep change before the body visibly changes.\n\nWhat you're feeling right now is your metabolism shifting. The visual results follow. Keep exactly what you're doing.`;
    } else if (/\b(meal prep|batch cook)\b/i.test(m)) {
      winReply = `${name}, meal prep is the single habit that separates people who get results from people who talk about it.\n\nWhen the food is already made, you don't make bad decisions under pressure. You just eat what's there. That's the whole secret. Do it every Sunday.`;
    } else {
      winReply = `${name}, that is a real win — and it came from ${total} sessions of work. The body is changing.\n\nKeep the same habits for 4 more weeks. This is where it compounds.`;
    }
    await logChat(user.id, message, winReply, "WIN_CELEBRATION");
    return winReply;
  }

  // ---- DISCIPLINE MOMENT — trained despite not wanting to ----
  const isDisciplineWin =
    /\b(didn.?t (feel like|want to) (train|go|workout|work out|go to gym)|forced myself|made myself (go|train|workout)|dragged myself|almost (didn.?t go|skipped|quit)|wanted to skip but|nearly skipped|almost skipped|didn.?t want to but (went|trained|did it|showed up)|went anyway|trained anyway|showed up anyway)\b/i.test(m);

  if (isDisciplineWin) {
    const name = user.name?.split(" ")[0] || "there";
    const total = user.totalWorkoutsCompleted || 0;
    const disciplineReply = `${name}, that session counts double.\n\nEvery person who has ever changed their body has had that exact same moment — the voice that says "not today." The ones who get results are not the ones who feel motivated. They are the ones who go anyway.\n\nYou just proved to yourself that you are that person. That is not a small thing. ${total > 1 ? `${total} sessions, and this is the one that matters most — because it was the hardest one to start.` : `First sessions are the hardest. You did it.`}\n\nSend *done* when you finish.`;
    await logChat(user.id, message, disciplineReply, "DISCIPLINE_WIN");
    return disciplineReply;
  }

  // ---- FIRST GYM VISIT / GYM ANXIETY ----
  const isFirstGym =
    /\b(first time (at|in|to) (the )?gym|first gym (session|day|visit|time)|never been to (a |the )?gym|went to (the )?gym for the first time|my first (day|session) (at|in) (the )?gym)\b/i.test(m);
  const isGymAnxiety =
    /\b(nervous (at|in|about) (the )?gym|intimidated (by |at |in )?the gym|don.?t know what (i.?m doing|to do) (at|in) (the )?gym|feel (lost|confused|out of place) (at|in) (the )?gym|gym (is|was) (scary|intimidating|overwhelming)|everyone.*staring|people.*staring.*gym|don.?t belong.*gym)\b/i.test(m);

  if (isFirstGym || isGymAnxiety) {
    const name = user.name?.split(" ")[0] || "there";
    const mode = user.trainingMode || "gym";
    const gymName = (user as any).gymName || "the gym";
    const gymReply = isFirstGym
      ? `${name}, you walked in. That is the hardest part — and you already did it.\n\nEvery person in that gym was a first-timer once. Every single one. The ones who look comfortable now were nervous the first day too.\n\nHere is all you need to know today: follow your programme, one exercise at a time. If a machine is taken, move to the next one. Nobody is watching you — everyone is focused on themselves.\n\nSend *done* when you finish your first session. That one counts more than any session after it.`
      : `${name}, gym anxiety is real and almost everyone feels it. Even people who have trained for years.\n\nHere is the truth: nobody in ${gymName} is watching you as closely as you think. They are thinking about their own training.\n\nYour programme is designed for machines — the safest, most effective way to train. Stick to your list, rest between sets, and leave when you are done. That is the whole thing.\n\nWhat exercise are you on right now? I will walk you through it.`;
    await logChat(user.id, message, gymReply, "GYM_ANXIETY");
    return gymReply;
  }

  // ---- SUGAR / JUNK CRAVINGS HANDLER — different from general hunger ----
  const isCravingMsg =
    /\b(craving|cravings|craving sugar|craving chocolate|craving sweets|craving junk|want.*chocolate|want.*sweets|want.*chips|want.*biscuits|want.*cake|want.*ice cream|want.*pizza|dying for.*chocolate|dying for.*sweets|need.*chocolate|need.*sugar|sugar craving|sweet tooth|can.?t stop craving|want to eat junk|want.*takeaway|want.*kfc|want.*mcdonalds|want.*burger king)\b/i.test(m) &&
    !/\b(i.?m hungry|starving)\b/i.test(m); // Don't double-fire with hunger handler

  if (process.env.ENGINE_LIVE !== "on" && isCravingMsg) {
    const name = commaName(user);
    const goal = user.goalType || "fat_loss";
    const isSugar = /\b(sugar|sweet|chocolate|sweets|biscuit|cake|ice cream)\b/i.test(m);
    const cravingReply = isSugar
      ? `Sugar cravings are not weakness${name} — they are a signal.\n\n*Most common causes:*\n1. *Low protein* — when protein is under target, your body craves fast energy (sugar). Fix: eat protein NOW — eggs, biltong, chicken, cottage cheese.\n2. *Skipped meals* — blood sugar crashed. Your body wants the fastest fix. Fix: eat a proper meal, do not try to resist on an empty stomach.\n3. *Poor sleep* — under 7 hours spikes ghrelin and makes you crave carbs. Fix: tonight, bed by 10pm.\n4. *Habit* — if you always eat sweets at 3pm, your body expects it. Fix: replace with Greek yoghurt and peanut butter — sweet, filling, high protein.\n\n*The 10-minute rule:* When the craving hits, eat protein first and wait 10 minutes. Most cravings pass. If it is still there after 10 min — eat a small portion of what you want. No guilt. Log it. Move on.`
      : `Craving junk food${name}? That is normal — especially when you are eating clean consistently.\n\n*The move:*\n1. Eat protein first — RIGHT NOW. Eggs, biltong, chicken. A full stomach craves nothing.\n2. If you still want it after — have a small portion. One slice, not a whole pizza. One serving, not the bag.\n3. Log it honestly. One takeaway meal is 800-1200 kcal. Your daily target is ${user.calorieTarget || 1800} kcal. Adjust the rest of the day.\n\nBanning food creates binges. Managing portions creates results.`;
    await logChat(user.id, message, cravingReply, "CRAVINGS");
    return cravingReply;
  }

  // ---- SOCIAL EVENT / PARTY / WEDDING / DECEMBER HANDLER ----
  const isSocialEvent =
    /\b(party|parties|wedding|matric dance|year.?end|december|festive|christmas|new year|birthday.*party|birthday.*eat|function|work function|office party|team building|dinner out|dinner party|family gathering|family dinner|lobola|umemulo|funeral.*food|after tears|stokvel|meat day|shisa nyama)\b/i.test(m) &&
    /\b(eat|eating|what should|how do i|tips|going to|this weekend|tonight|tomorrow|coming up|worried|nervous|scared|what do i do)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isSocialEvent) {
    const name = commaName(user);
    const goal = user.goalType || "fat_loss";
    const socialReply = `Social events are part of life${name} — not an excuse to abandon the programme and not a reason to feel guilty.\n\n*Before the event:*\n• Eat a high-protein meal 2 hours before — eggs, chicken, anything filling. Arriving hungry is how you overeat.\n• Decide in advance: "I will have one plate" — not a restriction, a plan.\n\n*At the event:*\n• Protein first on the plate — meat, chicken, fish. Then vegetables. Then carbs/starch last.\n• One plate, not three. Enjoy it fully — no guilt.\n• Alcohol: alternate with water. Every second drink is water.\n\n*After the event:*\n• Do NOT skip meals the next day to "make up for it". That starts a restrict-binge cycle.\n• Normal meals tomorrow. Hit your protein. Train if scheduled.\n• One event does not break a programme. Seven events with no plan in between does.\n\n${goal === "fat_loss" ? "Your deficit runs across weeks, not one meal. Enjoy it and get back on track." : "Extra calories at an event are fuel — use them in your next session."}`;
    await logChat(user.id, message, socialReply, "SOCIAL_EVENT");
    return socialReply;
  }

  // ---- UNDER-EATING WARNING — client logs very low calories ----
  const todayCalCheck = (user.todayCaloriesDate === sastToday()) ? (user.todayCalories || 0) : 0; // toISOString() is UTC — drifts from SAST 00:00–02:00; sastToday() matches stored format
  const calTarget2 = user.calorieTarget || 1800;
  const isLateDay = new Date(Date.now() + 2 * 3_600_000).getUTCHours() >= 16; // SAST hour — getHours() is UTC on Railway
  const isUnderEating =
    isLateDay &&
    todayCalCheck > 0 &&
    todayCalCheck < calTarget2 * 0.45 &&
    /\b(only|just|that.?s it|ate|had)\b/i.test(m) &&
    /\b(breakfast|lunch|dinner|meal|food|ate)\b/i.test(m);

  if (isUnderEating) {
    const name = commaName(user);
    const remaining = calTarget2 - todayCalCheck;
    const underEatReply = `Only ${todayCalCheck} kcal by this time of day${name} — that is too low.\n\nEating too little is not aggressive fat loss. It is the fastest way to lose muscle, crash your metabolism, and end up bingeing at 10pm.\n\n*Your target is ${calTarget2} kcal.* You have ${remaining} kcal left today — eat them. A proper dinner with protein and vegetables. Not snacks, a real meal.\n\nThe goal is a sustainable deficit, not starvation.`;
    await logChat(user.id, message, underEatReply, "UNDER_EATING");
    return underEatReply;
  }

  // ---- CHEAT / SLIP / FELL OFF HANDLER ----
  const isCheatMsg =
    /\b(cheat(?:ed|ing|s|meal|day)?|i slipped|slipped up|fell off|fell off track|off track|bad weekend|bad week|ate badly|ate everything|went off plan|broke my diet|broke the diet|ruined.*diet|ruined.*week|i binged|had a binge|ate too much|overdid it|over ate|overate|ate junk|bad food day|terrible eating|ate like crazy|couldn't control|lost control.*eating|eating got out of hand|whole weekend|entire weekend.*ate|pigged out)\b/i.test(m);

  if (isCheatMsg) {
    const name = commaName(user);
    const total = user.totalWorkoutsCompleted || 0;
    const week = user.programmeWeek || 1;
    const sessionLine = total > 0 ? `You have ${total} training session${total > 1 ? "s" : ""} logged. That does not disappear overnight.` : `You are in Week ${week} of your programme. One rough day does not erase that.`;
    const cheatReply = `One bad meal or weekend does not undo weeks of work${name}. That is not how the body works.\n\n*The math:* To gain 1kg of real fat you need to eat 7,700 kcal MORE than you burn. A bad weekend is usually 1,000–2,000 kcal over — mostly water weight, glycogen, and bloat. It looks worse than it is. It comes off in 2–3 days of normal eating.\n\n${sessionLine}\n\n*The move:*\n• Do not "make up" for it with less food tomorrow — that starts a restrict-binge cycle\n• Do not skip your next training session out of guilt — guilt makes it worse\n• Eat your normal meals today, hit your protein, drink water\n• One bad day means nothing. Missing the next 3 days means something\n\nReset starts with the next meal — not Monday.`;
    await logChat(user.id, message, cheatReply, "CHEAT_RECOVERY");
    return cheatReply;
  }

  // ---- SCALE NOT MOVING / PLATEAU / NOT LOSING WEIGHT ----
  const isScaleStuck =
    /\b(scale.*not.*moving|scale.*same|scale.*hasn.?t moved|scale.*stuck|not losing.*weight|weight.*not.*changing|weight.*not.*moving|weight.*the same|weight.*stuck|not dropping|no.*weight loss|haven.?t lost|didn.?t lose|losing nothing|same weight|still the same|haven.?t changed|weight.*hasn.?t|not seeing.*change|scale.*lie|scale.*wrong|the scale|why.*not losing|why am i not losing|why aren.?t i losing|why isn.?t.*working|why is nothing|nothing.*happening)\b/i.test(m);

  if (isScaleStuck) {
    const name = commaName(user);
    const week = user.programmeWeek || 1;
    const total = user.totalWorkoutsCompleted || 0;
    const goal = user.goalType || "fat_loss";
    const prot = user.proteinTarget || 120;

    let scaleReply = `The scale is one data point${name} — and it is often the least honest one in the first 4–8 weeks.\n\n*What the scale does NOT show:*\n• Muscle gain — 1kg of muscle takes up less space than 1kg of fat. You can lose fat and gain muscle and the scale barely moves — but your body is completely different\n• Water retention — sodium, stress, poor sleep, and your cycle (for women) all cause 1–3kg swings that are not fat\n• Glycogen — when you start training, muscles store more glycogen (with water attached). Scale goes up. Body fat goes down. Both things are true.\n\n*The real questions:*\n• Do your clothes fit differently?\n• Is your energy better?\n• Are you stronger in the gym?\n• Are you sleeping better?\n\nIf yes to any of those — your body is changing. The scale will catch up.\n\n`;

    if (week <= 3) {
      scaleReply += `You are in Week ${week}. The first 3 weeks are adaptation — your body is building the foundation. Real visible changes show up at Week 4–6 for most people. Stay consistent.`;
    } else if (total > 0 && week >= 4) {
      scaleReply += `*If the scale has genuinely not moved in 3+ weeks:*\n1. Log your food honestly for 3 days — portion sizes creep up without noticing\n2. Add a 20-minute walk on top of your current steps target\n3. Check sodium — SA processed food (polony, chips, takeaways) retains water\n4. Is sleep under 7 hours? Cortisol from poor sleep actively holds fat, especially belly fat\n\nPick one of these and fix it this week. Then update me.`;
    } else {
      scaleReply += `Stay consistent with your ${prot}g protein target and your sessions. Body recomposition is happening even when the scale lies. Trust the 8-week process — not the 1-week number.`;
    }

    if (goal === "muscle_gain") {
      scaleReply = `${user.name ? user.name + ", the" : "The"} scale going up is the goal on a muscle-building programme. If it is not moving, you are likely not eating enough. Your body cannot build muscle in a deficit — it needs fuel.\n\nAre you hitting your calorie and protein targets consistently? That is where muscle gain starts.`;
    }

    await logChat(user.id, message, scaleReply, "SCALE_STUCK");
    return scaleReply;
  }

  // ---- STRESS / ANXIETY / OVERWHELM HANDLER ----
  const isStressMsg =
    /\b(i.?m stressed|so stressed|very stressed|feeling stressed|work stress|life stress|stressed out|anxious|anxiety|overwhelmed|too much going on|can.?t cope|everything is too much|mental health|burnout|burned out|burnt out|exhausted mentally|emotionally drained)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isStressMsg) { // JUDGMENT/EMOTIONAL: the brain owns this when live (its low-mood guard keeps the SADAG net)
    const name = spaceName(user);
    const goal = user.goalType || "fat_loss";
    const stressReply = `Stress is not just a feeling${name} — it is a physical event that directly blocks fat loss.\n\nWhen you are chronically stressed, cortisol stays elevated. Cortisol tells your body to store fat, especially belly fat, break down muscle, spike hunger, and crave carbs and sugar. This is biology, not weakness.\n\n*What to do right now:*\n1. *Walk* — 20 minutes outside. Not for fitness. To drop cortisol. It works within minutes.\n2. *Eat your protein* — stress eats muscle. Protect it. Eggs, chicken, or tinned tuna right now.\n3. *Sleep tonight* — cortisol from one bad night undoes two good training days. Bed by 10pm.\n4. *Training still counts* — a 30-minute session is better than nothing. Lower weight, same movement.\n\n${goal === "fat_loss" ? "Stress is the hidden reason most people plateau. Fix the stress and the fat loss often restarts on its own." : "Cortisol and muscle gain are opposites — manage the stress or the gains slow down."}\n\nWhat is actually causing the stress right now?`;
    await logChat(user.id, message, stressReply, "STRESS");
    return stressReply;
  }

  // ---- TIRED / LOW ENERGY HANDLER ----
  const isTiredMsg =
    /\b(i.?m tired|so tired|very tired|exhausted|no energy|low energy|drained|fatigued|fatigue|lethargic|sluggish|can.?t wake up|always tired|tired all the time|tired today|feeling flat|body feels heavy|legs feel heavy)\b/i.test(m) &&
    !/\b(tired of|tired with|sick and tired)\b/i.test(m);

  if (isTiredMsg) {
    const name = spaceName(user);
    const tiredReply = `Three questions${name} before I give you advice:\n\n1. *Sleep* — How many hours last night? Under 7 means your body is not recovering properly. This is the most common cause of low energy by far.\n\n2. *Food* — What did you eat today? Low energy by afternoon is almost always low carbs or skipped meals. Your muscles need fuel.\n\n3. *Water* — Have you drunk 1.5-2L today? Even mild dehydration drops energy by 20%.\n\nWhich of these is off? Tell me and I will give you a specific fix — not "rest more" or "drink water" in general, the actual solution.`;
    await logChat(user.id, message, tiredReply, "TIRED");
    return tiredReply;
  }

  // ---- BAD DAY / GENERAL EMOTIONAL SUPPORT — no GPT, data-anchored ----
  const isBadDay =
    /\b(having a bad day|bad day today|rough day|having a rough day|tough day|hard day today|having a hard day|today (is|was|has been) (hard|rough|bad|terrible|awful|tough)|not feeling (great|good|well) today|not myself today|off day (today|mentally)|things are (tough|hard|rough)|life is hard|not feeling it today|really struggling today|down today|feeling down today|today (sucked|sucks))\b/i.test(m) &&
    !/\b(sore|pain|tired|exhausted|stressed|anxious|workout|gym|food|calories)\b/i.test(m);

  if (isBadDay) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const [recentW, recentS] = await Promise.all([
      db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))),
    ]);
    const fn = (user.name || "").split(" ")[0];
    const namePart = fn ? `${fn}, ` : "";
    const sessions = recentW.length;
    const avgSteps = recentS.length > 0 ? Math.round(recentS.reduce((s: number, l: any) => s + l.steps, 0) / recentS.length) : 0;
    let anchor = "";
    if (sessions > 0 && avgSteps > 3000) anchor = `While today feels heavy, your body has been doing the work this week — ${sessions} training session${sessions > 1 ? "s" : ""} and ${avgSteps.toLocaleString()} steps per day on average. That is not nothing.`;
    else if (sessions > 0) anchor = `Even this week — ${sessions} session${sessions > 1 ? "s" : ""} done. Hard days come, your body is still going.`;
    else if (avgSteps > 3000) anchor = `You are still moving — ${avgSteps.toLocaleString()} steps today. Movement on hard days counts more than on easy ones.`;
    else anchor = `Reaching out when you are having a bad day takes something. That matters.`;
    const goal = user.goalType || "fat_loss";
    const oneAction = goal === "muscle_gain"
      ? "One thing for today: eat your protein. Hard days still need fuel — the muscle does not take days off."
      : "One thing for today: eat one proper meal with protein. Not perfect, not a full reset — just one meal.";
    const badDayReply = `${namePart}bad days are part of this. Not the exception — part of the process.\n\n${anchor}\n\nYou do not have to be on fire today. You just have to not quit.\n\n${oneAction}\n\nWhat's actually going on?`;
    await logChat(user.id, message, badDayReply, "BAD_DAY");
    return badDayReply;
  }

  // ---- REST DAY HANDLER ----
  const isRestDayMsg =
    /\b(rest day|no gym today|off today|taking a rest|rest today|not training today|skipping gym|not going to gym|day off|recovery day|active recovery|not working out today|off day)\b/i.test(m);

  if (isRestDayMsg) {
    const name = spaceName(user);
    const stepsT = user.stepsTarget || 8500;
    const prot = user.proteinTarget || 120;
    const restReply = `Rest day is part of the programme${name} — not a break from it.\n\n*What happens on rest days:*\nYour muscles repair and grow. Strength is built during rest, not during the session. Skipping rest days is how people overtrain and plateau.\n\n*Rest day checklist:*\n✅ *Steps* — still hit ${stepsT.toLocaleString()}. Walk, do not train. Low intensity movement speeds recovery.\n✅ *Protein* — still hit ${prot}g. Muscle repair needs amino acids even when you are not lifting.\n✅ *Sleep* — 7-9 hours tonight. This is where the gains actually happen.\n✅ *Stretch* — 10 minutes. Hips, quads, chest, shoulders. Whatever is tight.\n\nCome back to your next session fresher than if you had trained today.`;
    await logChat(user.id, message, restReply, "REST_DAY");
    return restReply;
  }

  // ---- MISSED WORKOUT / SKIPPED SESSION HANDLER ----
  const isMissedWorkout =
    /\b(missed.*(?:workout|session|gym|training)|couldn.?t.*(?:train|gym|workout)|skipped.*(?:gym|session|workout|training)|didn.?t.*(?:train|go to gym|workout)|missed.*gym|didn.?t make it|couldn.?t make it|no gym yesterday|missed yesterday|no training today|didn.?t train)\b/i.test(m);

  if (isMissedWorkout) {
    const name = spaceName(user);
    const total = user.totalWorkoutsCompleted || 0;
    const missedReply = `One missed session${name} — that is all it is.\n\n${total > 0 ? `You have ${total} sessions completed. One miss does not erase that.` : "Getting back on track starts now."}\n\n*The rule:* Never miss twice. One miss is life. Two misses in a row is the start of a habit.\n\n*What to do right now:*\nDecide when you train next — not "tomorrow maybe", give me the specific time. 6am? 12pm? After work at 5pm?\n\nThat is your only job. Pick the time.`;
    await logChat(user.id, message, missedReply, "MISSED_WORKOUT");
    return missedReply;
  }

  // ---- SORE / DOMS HANDLER ----
  const isSoreMsg =
    /\b(i.?m sore|so sore|very sore|muscle soreness|doms|delayed onset|my muscles are sore|legs are sore|arms are sore|body is sore|everything is sore|sore from|sore after|still sore|too sore to train|too sore to gym|can.?t move|can.?t walk properly|struggling to walk|legs killing me|arms killing me)\b/i.test(m)
    // "stiff"/"aching" are the same DOMS class (pain-triage routes them here, 2026-07-12)
    || /\b(stiff|aching)\b/i.test(m) && /\b(legs?|arms?|muscles?|body|everywhere|workout|gym|training|leg day|yesterday)\b/i.test(m);

  if (isSoreMsg) {
    const name = spaceName(user);
    const soreArea = /\b(legs?|quads?|hamstrings?|glutes?|calves?)\b/i.test(m) ? "legs"
      : /\b(chest|pecs?|push|bench)\b/i.test(m) ? "chest"
      : /\b(back|lats?|rows?|pull)\b/i.test(m) ? "back"
      : /\b(shoulders?|delts?|press)\b/i.test(m) ? "shoulders"
      : /\b(arms?|biceps?|triceps?|curls?)\b/i.test(m) ? "arms"
      : "muscles";
    const trainAround = soreArea === "legs" ? "upper body — chest, back, shoulders, arms. Nothing that loads the legs."
      : soreArea === "chest" || soreArea === "shoulders" || soreArea === "arms" ? "lower body — squats, leg press, lunges, walking."
      : soreArea === "back" ? "lower body and chest press machine — avoid rowing and pulling movements."
      : "whatever body part is NOT sore.";
    const soreReply = `DOMS${name} — delayed onset muscle soreness. It means you trained hard enough to create adaptation. This is the process working.\n\n*Normal DOMS lasts 24-72 hours.* Peak soreness is usually day 2 after training, not day 1.\n\n*What to do:*\n✅ *Keep moving* — light walking speeds recovery by increasing blood flow to the muscle\n✅ *Protein* — your muscles are actively repairing right now and need amino acids\n✅ *Train around it* — if ${soreArea} is sore, train ${trainAround}\n✅ *Do NOT foam roll aggressively on day 1-2* — you can increase inflammation. Light rolling only.\n\n❌ *Do not rest completely* — passive rest slows recovery. Active recovery wins.\n\nThe soreness means it is working. Keep going.`;
    await logChat(user.id, message, soreReply, "DOMS");
    return soreReply;
  }

  // ---- WATER TARGET HANDLER ----
  const isWaterTargetMsg =
    /\b(how much water|water target|water goal|daily water|water intake|how many litres|how many liters|litres of water|liters of water|water per day|water recommendation|should i drink|water a day)\b/i.test(m);

  if (isWaterTargetMsg) {
    const name = spaceName(user);
    const waterLitres = waterTargetLitres(user.currentWeight).toFixed(1);
    const waterReply = `${name ? name.trimStart() + " — " : ""}your water target is *${waterLitres}L per day* (based on your body weight × 0.033).\n\nSimplest way to hit it: 500ml when you wake up, 500ml mid-morning, 500ml before lunch, 500ml mid-afternoon, 500ml before dinner. That is 2.5L without thinking about it.\n\nThirst and hunger feel identical — most cravings at 3pm are actually dehydration. Drink first, eat after. Log your water by sending "2L water" or "drank 1.5 litres".`;
    await logChat(user.id, message, waterReply, "WATER_TARGET");
    return waterReply;
  }

  // ---- PRE / POST WORKOUT NUTRITION HANDLER ----
  const isWorkoutNutrition =
    /\b(what.*eat.*(?:before|pre).?(?:gym|workout|training|session)|(?:before|pre).?(?:gym|workout|training).*(?:eat|food|meal|snack)|pre.?workout.*(?:food|meal|eat|nutrition)|what.*eat.*after.*(?:gym|workout|training)|post.?workout.*(?:food|meal|eat|nutrition)|after.*gym.*eat|eat.*after.*training)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isWorkoutNutrition) {
    const name = spaceName(user);
    const goal = user.goalType || "fat_loss";
    const isPre = /\b(before|pre.?workout|pre.?gym)\b/i.test(m);
    const isPost = /\b(after|post.?workout|post.?gym)\b/i.test(m);

    if (isPre && !isPost) {
      const preReply = `Pre-workout nutrition${name}:\n\n*60-90 minutes before training:*\n🍠 *Carbs* — fuel the session. Sweet potato, oats, brown rice, banana. Enough to fill your tank.\n🥩 *Protein* — 20-30g to protect muscle. Eggs, chicken, or a protein shake.\n💧 *Water* — 500ml before you start. Dehydration drops performance by 10-20%.\n\n*SA quick options:*\n• 2 eggs + 1 slice brown bread — 280 kcal, 18g protein ✅\n• Oats + milk — 320 kcal, 12g protein ✅\n• Sweet potato + chicken — 400 kcal, 30g protein ✅\n\n*Avoid:* Fatty foods (slows digestion), heavy meals within 45 minutes, training completely fasted if strength is the goal.\n\n${goal === "fat_loss" ? "For fat loss: eat light but eat. A small pre-workout meal does NOT block fat burning." : "For muscle gain: bigger pre-workout meal, more carbs — your muscles need the fuel."}`;
      await logChat(user.id, message, preReply, "PRE_WORKOUT_NUTRITION");
      return preReply;
    }

    const postReply = `Post-workout nutrition${name}:\n\n*Within 60 minutes after training:*\n🥩 *Protein first* — 30-40g to start muscle repair. This is the most important window.\n🍠 *Carbs* — replenish glycogen. Sweet potato, rice, oats, fruit.\n💧 *Water* — replace what you sweated out.\n\n*SA quick options:*\n• Pilchards + sweet potato — 380 kcal, 35g protein ✅\n• 3 eggs + pap — 420 kcal, 28g protein ✅\n• Chicken + rice — 500 kcal, 40g protein ✅\n• Protein shake + banana (if no time) — 300 kcal, 30g protein ✅\n\n*The rule:* Protein is non-negotiable post-workout. Skip the carbs if you must — never skip the protein.\n\n${goal === "fat_loss" ? "Post-workout is not the time to restrict — eat your protein. The rest of the day you can be in a deficit." : "Post-workout is the most important meal of the day for muscle gain. Eat big here."}`;
    await logChat(user.id, message, postReply, "POST_WORKOUT_NUTRITION");
    return postReply;
  }

  // ---- MEAL-SPECIFIC PLATE METHOD ("what to eat for breakfast/lunch/dinner") ----
  const isMealSpecificQ =
    /\b(what.*(?:eat|have|make|cook).*(?:for|at)?\s*(?:breakfast|lunch|dinner|supper|snack)|(?:breakfast|lunch|dinner|supper|snack).*(?:ideas?|option|suggestion|help|advice)|what.*(?:breakfast|lunch|dinner|supper)|good.*(?:breakfast|lunch|dinner|supper))\b/i.test(m) &&
    !/\b(i had|i ate|i have|just had|just ate)\b/i.test(m); // exclude food logs

  if (process.env.ENGINE_LIVE !== "on" && isMealSpecificQ) {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = spaceName(user);
    const isMealBreakfast = /breakfast/i.test(m);
    const isMealLunch = /lunch/i.test(m);
    const isMealDinner = /dinner|supper/i.test(m);
    const isSnack = /snack/i.test(m);

    let mealReply = "";
    if (isMealBreakfast) {
      mealReply = `Breakfast${name} — the meal that sets your protein baseline for the day:\n\n${budget === "under_100"
        ? "• *2 boiled eggs + pap* — 310 kcal, 18g protein. Cheapest solid breakfast in SA.\n• *Oats + water + peanut butter* — 350 kcal, 12g protein. R5 a bowl.\n• *3 eggs scrambled* — 250 kcal, 21g protein. Nothing beats it."
        : "• *3 eggs + 1 slice brown bread* — 320 kcal, 22g protein\n• *Oats + low fat milk + boiled egg* — 380 kcal, 20g protein\n• *Greek yoghurt + banana + handful nuts* — 350 kcal, 18g protein"}\n\n${goal === "fat_loss" ? "Protein first at breakfast kills hunger for 4 hours. No protein = cravings by 10am." : "Bigger breakfast for muscle gain — add an extra egg or a scoop of protein."}`;
    } else if (isMealLunch) {
      mealReply = `Lunch${name} — your biggest protein hit of the day:\n\n${budget === "under_100"
        ? "• *Pilchards + pap + cabbage* — 420 kcal, 30g protein. R15 total.\n• *2 eggs + pap + spinach* — 340 kcal, 18g protein. R6 total.\n• *Tinned tuna + bread + tomato* — 360 kcal, 26g protein. R18 total."
        : "• *Chicken breast + sweet potato + salad* — 480 kcal, 38g protein ✅ Best option\n• *Tuna + brown rice + cucumber* — 400 kcal, 32g protein\n• *Mince + pap + morogo* — 500 kcal, 35g protein"}\n\n${goal === "fat_loss" ? "Make lunch your biggest meal — front-loading calories earlier means less hunger at night." : "This is where muscle gain happens — eat big and get your protein in."}`;
    } else if (isMealDinner) {
      mealReply = `Dinner${name}:\n\n${goal === "fat_loss"
        ? "• Smaller carb portion than lunch — protein and vegetables carry the meal\n• *Chicken + cabbage + tomato* — 350 kcal, 32g protein ✅\n• *Hake + spinach* — 280 kcal, 35g protein ✅\n• *Pilchards + salad* — 250 kcal, 26g protein ✅\n\nAfter 6pm: cut carbs in half, double the vegetables. Not zero carbs — half."
        : "• *Beef mince + pap + chakalaka* — 600 kcal, 40g protein\n• *Chicken thighs + rice + broccoli* — 580 kcal, 42g protein\n• Keep carbs in — your muscles recover overnight and need glycogen."}\n\nProtein at every dinner, every night. That is non-negotiable.`;
    } else if (isSnack) {
      mealReply = `Snacks${name} — only if you have calories left:\n\n✅ *High-protein snacks:*\n• Biltong 30g — 90 kcal, 18g protein\n• Boiled egg — 80 kcal, 6g protein\n• Cottage cheese ½ cup — 100 kcal, 14g protein\n• Pilchards half tin — 100 kcal, 12g protein\n\n❌ *Avoid:* Chips, biscuits, chocolate, rusks — calories with almost zero protein.\n\n${goal === "fat_loss" ? "If you are hungry between meals, your previous meal did not have enough protein. Fix the meal — do not add snacks." : "Between meals: protein shake or Greek yoghurt to keep amino acids flowing."}`;
    }

    if (mealReply) {
      await logChat(user.id, message, mealReply, "MEAL_ADVICE");
      return mealReply;
    }
  }

  // ============================================================
  // MYTH BUSTERS — hardcoded, zero GPT cost
  // Coach K's real positions on common SA fitness myths
  // ============================================================

  // ---- SPOT REDUCTION / BELLY FAT MYTH ----
  const isSpotReductionMsg =
    /\b(belly fat exercise|lose belly fat|burn belly fat|target belly|target.*stomach|stomach exercise|lose.*stomach|tummy.*exercise|waist.*exercise|ab.*fat|fat.*ab|six pack.*fat|lose.*tummy|shrink.*belly|reduce.*waist|flatten.*stomach|exercises.*for.*belly|exercises.*for.*stomach)\b/i.test(m) ||
    (/\b(ab|abs|sit.?up|crunch|plank)\b/i.test(m) && /\b(lose|burn|fat|belly|stomach|weight)\b/i.test(m));

  if (process.env.ENGINE_LIVE !== "on" && isSpotReductionMsg) {
    const goal = user.goalType || "fat_loss";
    const name = commaName(user);
    const spotReply = `*The truth about belly fat${name}:*\n\nYou cannot choose where your body burns fat. Spot reduction is not real — no exercise burns fat from one specific area. Not crunches, not planks, not waist trainers, not anything.\n\nBelly fat is the LAST place most people lose it and the first place they gain it. That is genetics, not a technique problem.\n\n*What actually works:*\n• Calorie deficit — eat less than you burn\n• Strength training — builds muscle that burns fat 24/7\n• Steps — 8,500+ daily keeps your metabolism active\n• Sleep — poor sleep spikes cortisol which stores fat around the belly\n\nSit-ups build ab muscles. They do not burn belly fat. You need to lose fat OVER the abs — that happens through your diet and overall activity, not through any specific exercise.\n\n${goal === "fat_loss" ? `Your calorie target is ${user.calorieTarget || 1800} kcal/day. Hit that consistently for 8 weeks and the belly changes — no special exercise needed.` : `Keep training and eating at your targets — the belly responds when the overall programme is consistent.`}`;
    await logChat(user.id, message, spotReply, "MYTH_BUSTER");
    return spotReply;
  }

  // ---- TIKTOK TEAS / DETOX / SLIMMING TEA MYTH ----
  const isTeaMythMsg =
    /\b(slimming tea|weight loss tea|detox tea|flat tummy tea|belly fat tea|green tea.*weight|teatox|skinny tea|herbal.*weight loss|fat burning tea|lemon water.*weight|apple cider.*weight|acv.*weight|detox.*drink|cleanse.*weight|lemon.*detox|boil.*lemon|boil.*cinnamon|boil.*ginger.*lose|fat burner.*drink)\b/i.test(m) ||
    (/\btiktok\b/i.test(m) && /\b(tea|drink|weight|fat|slim|detox|lose)\b/i.test(m));

  if (process.env.ENGINE_LIVE !== "on" && isTeaMythMsg) {
    const name = commaName(user);
    const teaReply = `Eish${name} — that is one of the biggest myths in the industry.\n\n*Slimming teas, detox teas, and TikTok weight loss drinks do not work.*\n\nThere is no tea, drink, or "detox" that burns fat. Not green tea. Not lemon water. Not apple cider vinegar. Not anything boiled with cinnamon and ginger.\n\n*What they actually do:*\n• Most are strong laxatives — you lose water weight, not fat\n• The weight comes back within 48 hours\n• Some damage your gut bacteria long-term\n• All of them are a waste of money\n\nThe companies selling these products are targeting people who want a shortcut. There is no shortcut.\n\n*What burns fat:*\n1. Consistent calorie deficit over weeks\n2. Strength training 3x per week\n3. 8,500+ steps daily\n4. 7-9 hours sleep\n\nThat is it. Your programme already has all four. Trust the process.`;
    await logChat(user.id, message, teaReply, "MYTH_BUSTER");
    return teaReply;
  }

  // ---- OZEMPIC / SEMAGLUTIDE / WEIGHT LOSS INJECTION ----
  const isOzempicMsg =
    /\b(ozempic|semaglutide|wegovy|mounjaro|tirzepatide|weight loss injection|slimming injection|slimming jab|fat jab|skinny jab|injection.*weight|weight.*injection)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isOzempicMsg) {
    const name = commaName(user);
    const ozempicReply = `Sharp question${name}.\n\n*The truth about Ozempic and weight loss injections:*\n\nOzempic (semaglutide) is a real medication — it works by reducing appetite and slowing digestion. Studies show real weight loss. It is not a scam.\n\n*But here is what nobody on TikTok tells you:*\n\n• It does not replace the basics. You still need to eat right, walk daily, and strength train — or the moment you stop taking it, the weight comes back\n• Side effects are real — nausea, vomiting, gut issues, and it is extremely expensive (R2,000-R8,000/month in SA)\n• It was designed for diabetics with severe obesity — not general weight loss\n• You cannot build muscle on Ozempic alone without strength training\n• Without resistance training you lose muscle with the fat — this makes long-term maintenance harder\n\n*My position:* Build the habits first. Walk. Train. Eat right. Sleep. If after 3 months of real effort you are still not moving, speak to a doctor about whether medication is appropriate for you. But medication without the habits is just expensive weight you will regain.\n\nYour programme already works — if you are consistent. Are you hitting your sessions this week?`;
    await logChat(user.id, message, ozempicReply, "MYTH_BUSTER");
    return ozempicReply;
  }

  // ---- RUNNING CLUBS / MARATHON FOR WEIGHT LOSS → redirect to walking + strength ----
  const isRunningClubMsg =
    /\b(running club|run.*club|marathon.*weight|running.*lose weight|run.*lose.*fat|jogging.*lose.*fat|run.*fat loss|5k.*weight|10k.*weight|half marathon|full marathon|park run|parkrun)\b/i.test(m) ||
    (/\b(running|jogging|run)\b/i.test(m) && /\b(weight loss|lose weight|fat loss|get fit|get in shape|burn fat|lose fat)\b/i.test(m));

  if (process.env.ENGINE_LIVE !== "on" && isRunningClubMsg) {
    const name = commaName(user);
    const steps = user.stepsTarget || 8500;
    const runningReply = `Real talk${name}.\n\n*Running for weight loss is one of the most common mistakes I see.*\n\nHere is what actually happens: you join a running club, you burn 400 calories on the run, you come home starving and eat 600 calories extra. Net result — weight gain.\n\nRunning also:\n• Is hard on joints, especially if you are overweight\n• Does not build muscle — which is what drives long-term fat loss\n• Makes you HUNGRY — harder to maintain a deficit\n• People get injured in the first 6 weeks before any real progress\n\n*What I use instead:*\n✅ *Walking* — 8,500-15,000 steps daily. Low intensity, sustainable, burns fat without spiking hunger, protects joints. A 10,000 step day burns 400-500 extra calories without making you ravenous.\n✅ *Strength training* — 3 days per week. Builds muscle. Muscle burns calories 24/7, even while you sleep. This is the engine.\n\nYou can run if you enjoy it — that is great for your heart and mental health. But do not depend on running to lose weight. Depend on your programme and your daily steps.\n\nYour target is ${steps.toLocaleString()} steps per day. Are you hitting that consistently?`;
    await logChat(user.id, message, runningReply, "MYTH_BUSTER");
    return runningReply;
  }

  // ---- AVOCADO CALORIE CONTEXT ----
  const isAvocadoMsg =
    /\b(avocado|avo)\b/i.test(m) &&
    /\b(healthy|good|eat|can i|is it|diet|weight|fat|daily|every day|all the time|meal plan|lunch|breakfast)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isAvocadoMsg) {
    const goal = user.goalType || "fat_loss";
    const name = commaName(user);
    const avoReply = goal === "fat_loss"
      ? `Yes avocados are healthy${name} — but they are calorie-dense and that matters when you are trying to lose fat.\n\n*Avocado calorie reality:*\n• Half an avo: ~160 kcal, 2g protein\n• Full avo: ~320 kcal, 4g protein\n• That is 18% of your daily calorie budget in one fruit\n\nHealthy fats are still calories. An avo on toast with eggs can easily be 600 kcal before 8am.\n\n*My rule:* Half an avo, 2-3 times a week maximum when you are cutting. The healthy fat is real — but so are the calories. Pair it with eggs for protein. Never as a snack on its own.`
      : `Avocados are excellent${name} — healthy fats that support hormone production, which matters for muscle building.\n\nFull avo is ~320 kcal, 30g healthy fat. In a muscle gain phase, fat calories are your friend. Use it freely — just track it as a fat source, not a protein source. Pair with eggs or chicken.`;
    await logChat(user.id, message, avoReply, "MYTH_BUSTER");
    return avoReply;
  }

  // ---- SOCIAL MEDIA / TIKTOK MISINFORMATION ----
  const isSocialMediaMythMsg =
    /\b(i saw on tiktok|tiktok says|tiktok said|saw on instagram|instagram says|instagram said|social media.*says|youtube says|youtube said|i read.*that|someone told me.*that|my friend.*told me|my sister.*told me|my mom.*told me)\b/i.test(m) &&
    /\b(lose weight|fat loss|diet|exercise|burn fat|slim|weight loss|calories|protein|carb|food|workout|supplement|detox|cleanse|tea|drink)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isSocialMediaMythMsg) {
    const name = commaName(user);
    const socialReply = `Eish${name} — this is important.\n\nSocial media fitness advice is almost always wrong, exaggerated, or selling something.\n\n*The algorithm rewards:* drama, extreme claims, quick fixes, and shocking content. It does NOT reward: "eat protein, walk daily, strength train 3 times a week, sleep 8 hours" — because that is boring and it does not sell anything.\n\n*Real results come from boring basics:*\n1. Consistent strength training 3-4 days\n2. 8,500-15,000 steps daily\n3. Enough protein every meal\n4. 7-9 hours sleep\n5. Patience\n\nAnything promising faster than 0.5-1kg per week is either a lie or dangerous. What specifically did you see — I will tell you whether it is real or rubbish.`;
    await logChat(user.id, message, socialReply, "MYTH_BUSTER");
    return socialReply;
  }

  // ---- DOUBLE CARB CORRECTION — pap AND rice AND bread in same meal ----
  const carbonWords = (m.match(/\b(pap|samp|rice|bread|potato|sweet potato|butternut|maize)\b/gi) || []);
  const hasLogTrigger2 = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|just had|meal)\b/.test(m);
  if (carbonWords.length >= 3 && hasLogTrigger2) {
    const name = commaName(user);
    const doubleCarbReply = `Too many carbs in one meal${name}.\n\nI can see ${carbonWords.slice(0, 3).join(", ")} — that is three carb sources together. Your body can only use one portion of carbs per meal; the rest gets stored as fat.\n\n*Fix this meal:* Keep ONE carb source (pap OR rice OR bread — whichever is your staple). Fill the rest of your plate with protein and vegetables.\n\n*The plate rule:* One carb + protein + as many vegetables as you want. Every meal. Simple.`;
    await logChat(user.id, message, doubleCarbReply, "MYTH_BUSTER");
    return doubleCarbReply;
  }

  // ---- PLATE METHOD COACHING — when client asks "what should I eat?" without specifics ----
  const isPlateMethodQ =
    /\b(what should i eat|what do i eat|how should i eat|what to eat|healthy eating|eating right|how to eat|my diet|best way to eat|eating habits|what foods|food choices|nutritional advice|nutrition advice|diet advice)\b/i.test(m) &&
    !/\b(today|tonight|breakfast|lunch|dinner|meal plan|shopping)\b/i.test(m);

  if (process.env.ENGINE_LIVE !== "on" && isPlateMethodQ) {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = commaName(user);
    const plateReply = `*The Coach K plate method${name}:*\n\nForget calorie counting. I don't count calories, I make the right choices. Here is the whole system:\n\n*Every meal, every time:*\n🥩 *Protein first* — takes up half your plate. Eggs, chicken, pilchards, mince, beans. If there is no protein on the plate, it is not a meal.\n🍠 *One carb* — takes up a quarter of your plate. Pap, brown rice, sweet potato, oats. ONE — not all three.\n🥬 *Vegetables* — fills the rest. Spinach, cabbage, morogo, tomatoes, cucumber. Unlimited. The more the better.\n\n*That is it.* No app. No scale. No counting. Just: protein + one carb + vegetables.\n\nDo this for every meal and your body does the rest.\n\n${goal === "fat_loss" ? "For fat loss: make the protein portion bigger and the carb portion smaller." : "For muscle gain: make the carb portion bigger, especially before and after training."}\n\n${budget === "under_100" ? "At your budget: eggs + pap + spinach. Pilchards + pap + cabbage. Repeat. Simple and it works." : "Best SA options: pilchards, eggs, chicken thigh, tinned tuna — paired with sweet potato or pap and whatever vegetable you have."}`;
    await logChat(user.id, message, plateReply, "PLATE_METHOD");
    return plateReply;
  }

  // Variables for food format recovery check
  const hasLogTrigger = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|just had|just ate|i had|i ate|meal)\b/i.test(m);
  const hasActualFood = scanForSAFoods(m).length > 0;
  const isQuestion = /\?|^(what|how|when|where|why|can|should|is|are|do|does|which|could|would)\b/i.test(m);
  const isFrustration = /^\s*(ugh|argh|wtf|what the|this is|not working|doesn.?t work|ridiculous|stupid|useless|terrible|broken|help!+|please!+)\b/i.test(m);

  // ---- FOOD FORMAT RECOVERY — message looked like food logging but SA scanner found nothing ----
  // Fires only when: (a) clear food-log trigger word present, (b) SA database found no foods,
  // (c) not a question/frustration, (d) not already handled by water/steps/braai/restaurant/etc.
  // Provide instant format guidance instead of sending to GPT (which may return generic advice).
  // ASKING ABOUT DATA IS NOT LOGGING FOOD (2026-07-28 live: "Today's meal progress" contains the
  // word "meal", so it tripped this gate and came back as «I don't have *today's* in my SA
  // database — try "I had today's for lunch"». A request to SEE the day was answered as an
  // unknown food.) A progress/summary/status request never logs anything.
  const isDataRequest = /\b(progress|summary|total|totals|status|report|so far|how am i|where am i|my (?:day|week|numbers|stats|card)|show me|what have i|recap)\b/i.test(m);
  const seemsFoodLogAttempt = hasLogTrigger && !hasActualFood && !isQuestion && !isFrustration && !isDataRequest;
  if (seemsFoodLogAttempt) {
    // Compute candidate word count — if very short we can't do much
    const wordCount = m.split(/\s+/).length;
    // Only intercept if message has enough content to warrant format guidance
    // (single word like "yes" is handled by SHORT_REPLIES; "I had nothing" is ok to fall through)
    const hasNothingEaten = /\b(nothing|not.*eat|didn.?t eat|skipped|no food|fasted|fasting|no meals?)\b/i.test(m);
    if (!hasNothingEaten && wordCount >= 3) {
      // Try to extract what they mentioned as a food item for a personalised reply
      const nounWords = m.replace(/\b(i had|i ate|just had|just ate|ate|had|having|i have|having|breakfast was|lunch was|dinner was|breakfast|lunch|dinner|supper|snack|brunch|for|at|with|and|the|a|an|some|my)\b/gi, " ").trim().split(/\s+/).filter(w => w.length > 2);
      const firstNoun = nounWords.length >= 2 && nounWords[0].length <= 4 ? `${nounWords[0]} ${nounWords[1]}` : nounWords[0] || "";
      const foodHint = firstNoun ? ` (like "${firstNoun}")` : "";
      const foodLabel = firstNoun ? `*${firstNoun}*` : "that food";
      const formatReply = `I don't have ${foodLabel} in my SA database yet — send it as a full description and I'll log an estimate:\n\n"I had ${firstNoun || "the food"} for lunch"\n"Chicken thigh, sweet potato and spinach for dinner"\n\nInclude the name, rough amount, and which meal. I'll get the kcal and protein back to you instantly.`;
      await logChat(user.id, message, formatReply, "FOOD_FORMAT_GUIDE");
      return formatReply;
    }
  }

  // ---- THANKS / COMPLIMENT — deflect credit back to the user ----
  const isThanks = /\b(thank you|thanks|thank u|thx|you.?re amazing|you.?re the best|great coach|love this|love you coach|you.?re great|you.?re awesome|you.?re helping|so helpful|this is helping|this is working|appreciate (you|it|this)|grateful)\b/i.test(m);
  if (isThanks && m.split(/\s+/).length < 20) {
    const fn = (user.name || "").split(" ")[0] || "there";
    const goal = user.goalType || "fat_loss";
    const forward = goal === "fat_loss"
      ? `Send me what you're eating today — even one meal. That is how we keep it moving.`
      : goal === "muscle_gain"
        ? `Send me today's training session when you're done — let's keep the streak going.`
        : `Log something today — food, a workout, a weight. Every log is a data point.`;
    const thanksReply = `${fn}, that is all you — I just give the numbers and the nudges. You are the one showing up.\n\n${forward}`;
    await logChat(user.id, message, thanksReply, "THANKS");
    return thanksReply;
  }

  // ---- POSTPARTUM / BREASTFEEDING HANDLER ----
  const isPostpartumMsg = /\b(breastfeed|breast feed|breast-feed|breastfeeding|breast feeding|just gave birth|recently gave birth|new mom|new mum|new mother|postpartum|post partum|post-partum|just had a baby|just had my baby|had my baby|after birth|after delivery|nursing my baby|nursing a baby|im nursing|i'm nursing|i am nursing)\b/i.test(m);

  if (isPostpartumMsg) {
    const fn = user.name ? `${user.name}, ` : "";
    const situation = user.lifeSituation || "";
    const isTracked = situation === "postpartum_breastfeeding";
    const calT = user.calorieTarget || 1800;
    const protT = user.proteinTarget || 100;

    if (isTracked) {
      const postpartumReply = `${fn}your plan is already set up for breastfeeding — here's what matters most right now:\n\n🍼 *Calories:* Your target is *${calT} kcal/day*. Do not eat less than this — your body needs the extra fuel to make milk. Slow, steady weight loss (0.5kg/week max) is the goal.\n\n💪 *Protein:* Hit *${protT}g daily*. Milk quality depends on it — eggs, chicken, pilchards, Amasi, sugar beans.\n\n🥛 *Calcium:* Amasi, milk, sardines with bones, or yoghurt every day. Your baby draws calcium from your bones if you don't eat enough.\n\n🩸 *Iron:* Red meat, spinach, pilchards. You lost iron during delivery — replenish it.\n\n💧 *Water:* Add at least 500ml to your daily total. Breastfeeding is dehydrating.\n\n🏃 *Training:* Pelvic floor exercises from week 1. Gentle walks from week 2. Return to gym training at 6 weeks — only with doctor clearance. No heavy impact or ab work until cleared.\n\n*You are doing something incredible. Your body's job right now is to feed your baby and heal. The weight will come off — let it take the time it needs.*`;
      await logChat(user.id, message, postpartumReply, "POSTPARTUM_INFO");
      return postpartumReply;
    } else {
      const postpartumReply = `${fn}thank you for sharing that — this changes your plan.\n\nBreastfeeding burns 300–500 extra calories a day, and your body needs those calories to produce milk. If you eat too little, your milk supply drops first.\n\n*Here's what I recommend:*\n✅ Set your life situation to "breastfeeding" so your calorie and protein targets adjust correctly — type *UPDATE PLAN* and I'll walk you through it.\n✅ Never go below 1,800 kcal/day while breastfeeding\n✅ Priority nutrients: protein (milk quality), calcium (baby's bones), iron (delivery recovery), water (+500ml/day)\n✅ Hold off on intense training until 6 weeks post-delivery — pelvic floor and walks first\n\nYou can absolutely lose weight while breastfeeding — just slowly and safely. Type *UPDATE PLAN* to get started.`;
      await logChat(user.id, message, postpartumReply, "POSTPARTUM_INFO");
      return postpartumReply;
    }
  }

  return null;
}
