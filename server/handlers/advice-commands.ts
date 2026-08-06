/**
 * ADVICE & MASTERCLASS COMMANDS — extracted verbatim from early-commands.ts (2026-07-21) to
 * decompose the keyword wall (file-size + isolation: a workout regex can't reach a food message).
 * WHAT IS LEFT (2026-08-06). The judgment handlers that used to live here — bereavement,
 * alcohol, foods-to-avoid, binge recovery, shift work, results timeline and twenty more — were
 * gated behind `ENGINE_LIVE !== "on"`, and the engine has been on for every client for weeks.
 * They could not run. They are deleted, and a unit test now fails if a gated branch reappears.
 *
 * What remains is MECHANICAL or carries a MEDICAL-SCOPE guarantee, so it runs for everyone
 * regardless of any flag: the step-target update, the step-app answer, walking calories, the
 * digestive-issue boundary and the health-quick-fix boundary. Runs after numbers-literacy.
 */

import { db } from "../db";
import { users, stepLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { logChat } from "./chat-log";
import { looksSickMention } from "./sick-flow";
import { scanForSAFoods } from "./food-scanner";
import { nextDayDate, extractStepTargetChange, looksLikeLowMobility, looksLikeDefeatedNoResults, looksLikeDigestiveIssue, looksLikeFoodDislike, looksLikeOvertrainingPlan, sastDayStart } from "../utils";
import { stepBurnKcal } from "../targets";

export async function handleAdviceCommands(ctx: { message: string; m: string; user: any; phone: string }): Promise<string | null> {
  const { message, m, user, phone } = ctx;
  const firstName = user.name?.split(" ")[0] || "";
  const capName = user.name?.split(" ")[0] || "there";

  // ---- LOAD SHEDDING ----
  const isSick = looksSickMention(m); // sick itself is handled at the TOP now (understanding before keywords)

  // ---- RETURN PLANNING ("I'll be back Wednesday", "let's confirm I go back Monday") ----
  const isReturnPlanning = /\b(i.?ll (be back|start|resume|return|train|come back)|let.?s confirm|confirm (i|that i)|going back|back (on|from) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|start(ing)? (again|back|monday|tuesday|wednesday|thursday|friday|tomorrow)|resume (on|from|monday|tuesday|wednesday|thursday|friday)|back to (training|gym|it) (on|from|monday|tuesday|wednesday|thursday|friday))\b/i.test(m)
    && !isSick
    && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|next month)\b/i.test(m);
  // MEMORY (always, whoever replies): persist the stated return day as back_on:<date> — surfaced in the snapshot so the brain REMEMBERS it (2026-07-20 Kam).
  const rpDay = isReturnPlanning ? m.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i) : null;
  const rpDate = rpDay ? nextDayDate(rpDay[0]) : null;
  if (rpDate && user.id) {
    const rpBase = (user.profileNotes || "").replace(/\s*\|?\s*back_on:\d{4}-\d{2}-\d{2}/g, "").trim();
    const rpNotes = `${rpBase ? rpBase + " | " : ""}back_on:${rpDate}`;
    db.update(users).set({ profileNotes: rpNotes }).where(eq(users.id, user.id)).then(() => { user.profileNotes = rpNotes; }).catch((e: any) => console.error("[RETURN_PLAN] persist failed:", e));
    // TEMPORAL LOOP: nudge them the evening before they said they'd be back, so we never go silent.
    import("../reminders").then(({ scheduleReturnNudge }) => scheduleReturnNudge(user.id, phone, rpDate, "away")).catch((e: any) => console.error("[RETURN_PLAN] nudge failed:", e));
  }

  // ---- OVER-TRAINING SIGNAL ----

  // ---- ALCOHOL QUESTION (not a log — asking about it) ----

  // ---- FOODS TO AVOID / LIMIT ----
  // "cut.*out" was unanchored — it hijacked "scared of CUTting because I'm worried abOUT
  // losing my muscle" (2026-07-23). Anchored to the actual phrase "cut(ting) out".

  // ---- BAD EATING DAY / BINGE RECOVERY ----

  // ---- LOGGING CONFESSION — "I haven't been logging" (general, not about skipping meals) ----
  // Catches people apologising for not logging. Research: respond with curiosity not consequence.

  // ---- NIBBLING / GRAZING — "I was just nibbling on things" ----
  // Client ate, but grazed rather than had proper meals. Don't shame — just get the data.
  // Research: any eating occasion logged is better than none.

  // ---- CHRONIC UNDER-EATING — "I only eat once a day", "I struggle to eat", "no appetite most days" ----
  // Distinct from the acute "forgot to eat today" below. This is the recurring SA pattern:
  // work-from-home, low movement, low appetite, one meal a day. Research: 2 eating occasions/day
  // is the threshold. Movement drives appetite. Never shame — make adding ONE thing feel easy.

  // ---- DEFER START / NOT MENTALLY READY — keep the habit forming, no pressure ----
  // Active client wants to push their start to next month. Don't let them go dark —
  // offer minimum viable engagement (walk + photo food) so the habit forms in the gap.

  // ---- RESULTS TIMELINE — "how long until I see results?" ----
  // The #1 dropout question. User's proven answer: 3 months visual. Set honest expectations.

  // ---- SHIFT WORKER — "I work 4 days dayshift 4 days nightshift 4 days off" ----
  // Mining, nursing, security, casino — rotating schedules. Build around the schedule.

  // ---- INACTIVE GYM MEMBER — "only went 4 days in 3 months", "barely use my membership" ----
  // Sunk cost guilt. Don't reinforce it — offer the real choice honestly.

  // ---- SKIPPING MEALS / FORGOT TO EAT ----

  // ---- FUNERAL / BEREAVEMENT ----
  // "passed on" / "passed" (with a relative) are as common as "passed away" in SA
  // English — a real client wrote "my grandfather passed on in the wee hours" and it
  // must reach this compassion path, never generic handling (2026-07-08 screenshot).

  // UPDATE STEP TARGET — ONE parser (utils.extractStepTargetChange) shared with the brain gate; all SA number formats caught + persisted (2026-07-12).
  const parsedStepTarget = extractStepTargetChange(m);
  if (parsedStepTarget !== null) {
    if (parsedStepTarget >= 2000 && parsedStepTarget <= 30000) {
      const oldTarget = user.stepsTarget || 8500;
      await db.update(users).set({ stepsTarget: parsedStepTarget }).where(eq(users.phoneNumber, phone));
      const direction = parsedStepTarget > oldTarget ? "raised" : parsedStepTarget < oldTarget ? "lowered" : "kept";
      const stepUpdateReply = `Step target ${direction} to *${parsedStepTarget.toLocaleString()} steps/day*. ✅ Every screenshot you log — and your morning brief — now tracks against this.`;
      await logChat(user.id, message, stepUpdateReply, "STEP_TARGET_UPDATE");
      return stepUpdateReply;
    }
    return `That step count doesn't look right (valid range: 2,000–30,000). What should your daily step goal be?`;
  }

  // ---- STEP TRACKING APP RECOMMENDATION ----
  // "Which app?" "What app to track steps?" — comes up every onboarding conversation.
  // Give a clear, device-aware answer so the client can act immediately.
  const isStepAppQ = /\b(which\s+app|what\s+app|step\s+(?:app|counter|tracker)|app\s+(?:for\s+)?steps?|steps?\s+app|track\s+(?:my\s+)?steps|how\s+(?:do\s+i\s+)?(?:count|track)\s+(?:my\s+)?steps|best\s+app\s+for\s+steps|google\s+fit|samsung\s+health|pedometer)\b/i.test(m);
  if (isStepAppQ) {
    const stepAppReply = `For counting steps, here is what I recommend based on your phone:\n\n*Android (Samsung):* Samsung Health — already on your phone. Open it, tap *Activity*, then *Steps*. It tracks automatically in the background.\n\n*Android (other):* Google Fit — free on Google Play. Takes 2 minutes to set up. If you already have it, open it and look for the steps circle on the home screen.\n\n*iPhone:* Apple Health — already installed. It counts steps automatically. Open it, tap *Browse → Activity → Steps*.\n\n*No smartphone / basic phone:* A cheap pedometer from Pick n Pay or Checkers works — clip it to your waistband, reset it in the morning.\n\nOnce it is set up, just send me your step count at the end of each day — type *"walked 8,000 steps"* or similar and I log it for you.\n\n_Target: ${(user.stepsTarget || 8500).toLocaleString()} steps/day._`;
    await logChat(user.id, message, stepAppReply, "STEP_APP_GUIDE");
    return stepAppReply;
  }

  // ---- PHONE IN CAR / INFLATED STEPS — driving or machine vibration inflates step count ----
  // Accelerometer can't distinguish walking from road/machine vibration.
  // Common: truck drivers, miners, taxi drivers, machine operators.

  // LOW MOBILITY — concern-first; results come from the FOOD deficit, not steps; offer a lower step goal in one tap (2026-07-12 Kam, detector: utils.looksLikeLowMobility). JUDGMENT → brain owns it when live (brain bullet: CAN'T WALK MUCH).

  // DEFEATED / "IT'S MY GENETICS" — Kam's masterclass (2026-07-12) now lives in the brain
  // (coach-brain.ts), which owns this judgment for every client. The template fallback that
  // stood here was deleted on 2026-08-06 with the rest of the unreachable branches.

  // ---- DIGESTIVE ISSUES — bloating / acid reflux / heartburn / indigestion (2026-07-12
  // onboarding screenshot). Care first, practical food guidance, and a defer-to-doctor
  // safety line. Detector (utils.looksLikeDigestiveIssue) excludes period + check-in noise.
  // NOT GATED — same reason: it carries the "check with your doctor, I work alongside
  // them, never instead of them" line, which is a scope boundary, not coaching flavour.
  if (looksLikeDigestiveIssue(m)) {
    const giReply = `Thanks for telling me${capName ? ", " + capName : ""} — that matters, and we can work with it. 💛\n\nBloating, reflux and heartburn are really common. What helps most people:\n• *Smaller meals, more often* — big meals overload the gut.\n• Eat *slower*, sit up, and don't lie down for 2–3 hours after eating.\n• Common triggers: fizzy drinks, very fatty/fried food, too much dairy, big late-night meals, eating in a rush.\n• Sip water *between* meals, not gulping during.\n\nI'll keep your meals lighter and easier on your stomach. If it's regular or you're already on tablets for it, please also check in with your doctor — I work *alongside* them, never instead of them.\n\nTell me when it hits worst and I'll help you spot the trigger.`;
    await logChat(user.id, message, giReply, "DIGESTIVE_ISSUE");
    return giReply;
  }

  // ---- FOOD DISLIKE — "I hate chicken breast" / "I force myself to eat X" (2026-07-12).
  // Offer an alternative in the same role; never make someone force down food they hate.

  // ---- OVER-TRAINING PLAN — client states 5+ sessions/week or "every day" (2026-07-12,
  // Kam: "5 is unnecessary"). Right-size it: rest is where results happen.

  // ---- WALKING CALORIE BURN — "how many calories did I burn walking/steps?" ----
  // Previously the bot ignored this cross-reference question and just showed food totals.
  // Key coaching point: their calorie target already accounts for activity — don't eat back steps.
  const isWalkingCalQ =
    /\b(how\s+(many\s+)?calories?\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?|my\s+walk(ing)?|my\s+steps?|the\s+walk(ing)?))\b/i.test(m)
    || /\b(how\s+much\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?))\b/i.test(m)
    || /\b(walk(ing)?\s+calories?|step\s+calories?|calories?\s+(from|burned\s+from)\s+(walking|steps?))\b/i.test(m)
    || /\b(how\s+(does|do)\s+(the\s+)?(walking|steps?)\s+(affect|impact|count|factor\s+into|fit\s+into)\s+(my\s+)?(total\s+calories?|calorie\s+total|calories?\s+(for\s+)?today|daily\s+(intake|calories?|budget)|calorie\s+(target|budget)))\b/i.test(m)
    || /\b(burned|burnt)\s+(walking|from\s+(walking|steps?))\b/i.test(m);

  if (isWalkingCalQ) {
    const todayStart = sastDayStart();
    let todaySteps = 0;
    try {
      const stepRow = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(1);
      todaySteps = stepRow[0]?.steps || 0;
    } catch { /* non-fatal */ }

    const bodyWeightKg = user.currentWeight ? parseFloat(String(user.currentWeight)) : 75;
    const estimatedKcal = stepBurnKcal(todaySteps, bodyWeightKg);
    const stepsTarget = user.stepsTarget || 8500;
    const calTarget = user.calorieTarget || 1800;
    const nm = firstName ? `${firstName}, ` : "";

    let walkCalReply: string;
    if (todaySteps === 0) {
      const perK = stepBurnKcal(1000, bodyWeightKg);
      const targetBurn = stepBurnKcal(stepsTarget, bodyWeightKg);
      walkCalReply = `${nm}no steps logged yet today — send me your step count ("walked 6,000 steps") and I'll work it out exactly.\n\nFor you specifically, every 1,000 steps ≈ *~${perK} kcal*.\nHitting your ${stepsTarget.toLocaleString()} steps target burns roughly *~${targetBurn} kcal*.\n\n*One thing to know:* your *${calTarget} kcal daily target already includes your activity level.* Walk your steps, hit your calorie target — you're on track. You don't need to eat extra because you walked.`;
    } else {
      walkCalReply = `${nm}*Today's step burn:*\n${todaySteps.toLocaleString()} steps ≈ *~${estimatedKcal} kcal*\n\n*Important — how this fits your plan:*\nYour *${calTarget} kcal target already accounts for your activity level.* You don't "eat back" those walking calories on top of your target — the target was set to include them.\n\n*The rule:*\n✅ Hit your calorie target → you're eating the right amount\n✅ Hit your step target (${stepsTarget.toLocaleString()}) → your metabolism stays active, fat loss is faster\n❌ Adding step calories on top of your food target = eating at maintenance, not a deficit\n\nWalking accelerates fat loss. It doesn't mean you can eat more.`;
    }

    await logChat(user.id, message, walkCalReply, "WALKING_CALORIE_BURN");
    return walkCalReply;
  }

  // ---- BELLY FAT / MKHABA — "I want to lose my belly", "mkhaba", "stomach fat" ----
  // The #1 specific fat loss target. SA word "mkhaba" = belly/stomach fat (Zulu/Sotho).
  // Acknowledge specifically — people feel heard when you know their word.

  // ---- GAINS-FEAR / "I don't want to get lean" — the intermediate myth-victim ----
  // (2026-07-23, Kam: intermediates at high body fat refuse the deficit because "last time
  // I lost all my gains" — social media lied to them; they leave when the truth has no soft
  // landing. Meet the fear with respect, hold the cut-first line, leave the door open.)

  // ---- HEALTH QUICK-FIX EXPECTATION — "will losing weight fix my BP/sugar fast?" ----
  // (2026-07-23, Kam: clients with health problems expect a two-week cure, quit when the
  // miracle doesn't come. Honest timeline up front keeps them — or filters them on day one.)
  const isHealthQuickFix =
    /\b(blood\s*pressure|bp|diabetes|diabetic|sugar\s+(?:is|levels?|problem)|cholesterol|knees?\s+(?:pain|hurt|problem))\b/i.test(m)
    && /\b(fix|cure|heal|sort(?:\s+out)?|go\s+away|reverse|help)\b/i.test(m)
    && /\b(weight|fat|slim|lose|losing|kg)\b/i.test(m);
  // NOT GATED (2026-08-03). This carries a MEDICAL-SCOPE GUARANTEE — the honest timeline and
  // "medication decisions stay with your doctor". It sat behind the engine flag, which has
  // been on in production for weeks, so it never ran: a client asking whether losing weight
  // fixes their blood pressure got whatever the model improvised, with no guaranteed doctor
  // referral. A safety guarantee must never depend on a feature flag being off.
  if (isHealthQuickFix) {
    const healthReply = `${capName}, straight answer: *yes, losing weight genuinely improves this* — blood pressure, sugar control, joint load all respond to fat loss. Doctors see it every day.\n\nBut I owe you the honest timeline: the real improvements show up after roughly *5–10% of your body weight* comes off and stays off — that's a *12-week-plus steady project*, not a two-week fix. Anyone promising faster is selling something.\n\nWhat you'll notice early (weeks 1–3): better energy, better sleep, clothes easing. The clinic numbers follow the consistency.\n\nTwo rules while we work:\n• Keep seeing your doctor — medication decisions stay with them, always.\n• Our lane: food logged, steps walked, strength trained — every day, boring, effective.\n\nIf you're in for the real timeline, I'm in with you the whole way.`;
    await logChat(user.id, message, healthReply, "HEALTH_QUICK_FIX");
    return healthReply;
  }

  // ---- CRIME / SAFETY WALKING OBJECTION ----
  // "Can't walk outside — crime", "not safe to walk in my area", "too dangerous outside"
  // This is a real SA barrier. Acknowledge it, give indoor alternatives immediately.

  // ---- MONTH-END / FINANCIAL STRESS ----

  return null;
}
