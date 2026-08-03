import { db } from "./db";
import { users, weightLogs, chatHistory, stepLogs, escalations } from "../shared/schema";
import { escalationSLA } from "./safety-detection";
import { generateReferralCode } from "./onboarding-referral";
import { parseFoodPreferences, parseVisionAnswer, looksLikeBulkIntake, applyIntakeBrake, describeIntake, type BulkIntake } from "./onboarding-intake";
import { TRIAL_DAYS, TRIALS_ENABLED } from "./pricing-config";
import { buildActivationBrief } from "./activation";
import { eq, and, desc, gte } from "drizzle-orm";
import { buildFullProgramme, getKamlifeProgramme } from "./programme";
import { calculateTargets, calculateStepsTarget } from "./targets";
import { looksLikeGoalAnswer, classifyGoalFromText } from "./goal-profiles";
import { replyWithButtons } from "./twilio-interactive";
import { askCoachK } from "./gpt";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { getDisplayName, sastDayStart, timeGreeting } from "./utils";
import { getTodayWorkoutState } from "./workout-state";
import { parseFirstName } from "./onboarding-name";
import { MEDICAL_QUESTION } from "./onboarding-physique";

// ============================================================
// ONBOARDING STATE MACHINE — valid states (CTO audit #17/#41)
// Single source of truth for every onboardingState the FSM uses. If a user lands
// in a state not in this set, handleOnboarding logs it (instead of silently
// returning nothing) so the silent-death bug is visible in logs/Sentry. This is
// warn-only — it never blocks the flow.
// ============================================================
export const ONBOARDING_STATES = new Set<string>([
  "START", "PRE_ONBOARD", "ASK_POPIA", "WELCOME", "COMPLETE", "BLOCKED_UNDERAGE",
  
  "ASK_GENDER", "ASK_AGE_NEW", "ASK_GOAL", "ASK_EXPERIENCE",
  "ASK_EQUIPMENT",
  "ASK_GYM_SETUP", "ASK_HOME_EQUIPMENT", "ASK_WEIGHT_HEIGHT",
  "ASK_WEIGHT_HEIGHT_FAST", "ASK_MEDICAL", "ASK_INJURIES",
  
  "ASK_BUDGET", "ASK_FEMALE_FOCUS", "ASK_POSTPARTUM",
  "ASK_GOAL_CONFIRM",
]);

// ============================================================
// MENU TEXT — context-aware
// ============================================================

export async function getMenuText(user: any, opts?: { showCommands?: boolean }): Promise<string> {
  const name = getDisplayName(user);
  // Time-aware, human greeting — "Good morning Kam 👋" / "Good afternoon" / "Good evening".
  const hey = name ? `${timeGreeting()} ${name} 👋` : `${timeGreeting()} 👋`;
  const mode = user.trainingMode || "home";
  const stepsTarget = user.stepsTarget || 8000;

  const todayStart = sastDayStart();

  let todayStepCount: number | null = null;
  let workoutState: Awaited<ReturnType<typeof getTodayWorkoutState>>;

  try {
    const [todaySteps, ws] = await Promise.all([
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1),
      getTodayWorkoutState(user),
    ]);
    todayStepCount = todaySteps.length > 0 ? todaySteps[0].steps : null;
    workoutState = ws;
  } catch {
    workoutState = await getTodayWorkoutState(user);
  }

  // Trial countdown — business-critical, stays on every greeting
  let trialLine = "";
  if (user.subscriptionStatus === "trial" && user.betaBypassUntil) {
    const daysLeft = Math.max(0, Math.ceil((new Date(user.betaBypassUntil).getTime() - Date.now()) / 86_400_000));
    trialLine = daysLeft <= 3
      ? `\n\n⏰ *${daysLeft} day${daysLeft !== 1 ? "s" : ""} left on free trial* — reply *pay* to keep coaching`
      : `\n\n_Free trial: ${daysLeft} days remaining_`;
  }

  // Full command list only when explicitly asked (menu/help) or the user is lost.
  // A greeting gets a coach, not a sitemap.
  // Gym users: surface the photograph-a-machine feature. Dumbbell/home users don't need it.
  // Machine-identification-from-a-photo was deleted 2026-07-31 (a vision call on every gym
  // photo that answered a machine with a bodyweight workout). This line promised it anyway —
  // the first message a gym client reads was selling a feature that no longer exists.
  const machineLine = mode === "gym"
    ? `\n🏋️ *At the gym?* Type *show me* and any exercise name — I'll send you the form demo.`
    : "";
  const commandsBlock = opts?.showCommands
    // FOUR THINGS, NOT TWELVE (2026-07-28). The menu used to promote shopping lists, meal prep,
    // supplements, badges, referrals, step-connect and pause — surface a beginner does not need
    // and cannot hold. All of it still WORKS when asked for by name; it just isn't pushed. The
    // last line teaches the real interface: talk normally, the coach works it out.
    ? `\n\n*What you can send me:*\n🍳 Any meal — photo, voice note or plain text. I do the maths.${machineLine}\n💪 _workout_ · _done_\n📊 _my progress_ · _weight 82_\n\n_Or just talk to me normally — tell me what you ate, how you feel, what you need. I'll work it out._`
    : "";

  const tail = `${commandsBlock}${trialLine}`;

  const daysSilent = user.lastActiveAt
    ? Math.floor((Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000)
    : 0;

  // Already done today
  if (workoutState.type === "ALREADY_DONE") {
    const body = todayStepCount !== null && todayStepCount < stepsTarget
      ? `Session done ✅ — ${(stepsTarget - todayStepCount).toLocaleString()} steps to go and today's full.`
      : `Session done ✅ — good work today.`;
    return `${hey} ${body}${tail}[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // Rest day
  if (workoutState.type === "REST") {
    return `${hey} ${workoutState.todayName} — rest day. Next session: ${workoutState.nextTrainingName}.\n\nRecovery is where the work pays off. Protein in, water up, walk if you can.${tail}[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // Missed sessions — flag it in the greeting
  if (workoutState.type === "MISSED") {
    // Name days only when they're unambiguous; otherwise report the count. Naming a weekday
    // that is ALSO today read as a contradiction ("you missed Monday… Monday is a training day").
    const n = workoutState.missedCount || workoutState.missedSessions.length;
    const missed = workoutState.missedSessions.length > 0
      ? `You missed ${workoutState.missedSessions.join(" + ")}.`
      : `You've missed ${n} session${n === 1 ? "" : "s"}.`;
    return `${hey} ${missed} ${workoutState.todayName} is still a training day — let's get it done.${tail}[BUTTONS:Today's workout|Log food|My progress]`;
  }

  // Returning after silence
  if (daysSilent >= 3) {
    const daysText = daysSilent <= 7 ? `${daysSilent} days` : "a while";
    return `${hey} Been ${daysText} — no lecture. We pick up where you left off.${tail}[BUTTONS:Today's workout|Log food|My progress]`;
  }

  // Normal training day
  const stepsSoFar = todayStepCount !== null
    ? ` You're at ${todayStepCount.toLocaleString()} steps — ${todayStepCount >= stepsTarget ? "target hit ✅" : `${(stepsTarget - todayStepCount).toLocaleString()} to go`}.`
    : "";
  const trainBody = mode === "walk_only"
    ? `Today's job: ${stepsTarget.toLocaleString()} steps.${stepsSoFar}`
    : `Training day — your session's ready.${stepsSoFar}`;
  return `${hey} ${trainBody}${tail}[BUTTONS:Today's workout|Log food|My progress]`;
}

// ============================================================
// ONBOARDING MEAL PLAN
// ============================================================

export { getOnboardingMealPlan } from "./onboarding-meal-plan";

// ============================================================
// ONBOARDING COMPLETION HELPER
// Called from ASK_BUDGET (legacy path) and ASK_EXPERIENCE (fast-track path)
// ============================================================

/**
 * DEFERRED-CAPTURE DEFAULTS (2026-07-30, founder: onboarding is the biggest distribution leak).
 *
 * Onboarding was 18 turns for a man and 21 for a woman — an interrogation before anyone has been
 * given a single thing of value. Every question below used to be asked BEFORE the programme was
 * built; none of them changes whether the programme can be built at all. So they are defaulted
 * here and asked in conversation once the client is already getting value: grocery budget the
 * first time meal ideas come up, experience the first time a session is delivered, food likes
 * the first time a swap is asked for, photos whenever they want.
 *
 * The rule: NOTHING that is safety-relevant or that changes the maths is deferred. Weight,
 * height, age, gender, goal and medical conditions are all still asked up front, because the
 * calorie target and the safety gates cannot be honest without them.
 */
const DEFERRED_BUDGET = "100_300";
const DEFERRED_BUDGET_LEVEL = "medium";
const DEFERRED_EXPERIENCE = "beginner";

async function completeOnboarding(phone: string, u: any, budget: string, budgetLevel: string, exp: string): Promise<string> {
  const actualWeight = parseFloat(u.currentWeight || "75");
  const age = u.age || 30;
  const gender = u.gender || "male";
  const heightCm = u.heightCm || 170;
  const isYouth = age < 18;
  const isElderly = age >= 60;

  // UNDERWEIGHT GATE — duty of care: never build a calorie deficit for someone under
  // the healthy range (BMI < 18.5, possible eating-disorder territory). Flip the plan
  // to building UP, say it plainly in the welcome, and flag the coach to review.
  const bmiGate = heightCm > 0 && actualWeight > 0 ? actualWeight / Math.pow(heightCm / 100, 2) : 0;
  let underweightNote = "";
  if ((u.goalType || "fat_loss") === "fat_loss" && bmiGate > 0 && bmiGate < 18.5) {
    u.goalType = "muscle_gain";
    underweightNote = `⚠️ One important change before we start: at ${actualWeight}kg your numbers sit *under* the healthy range, so I won't coach weight loss — it would cost you muscle and health. Your plan builds you UP instead: strength, fuel, protein. If a doctor or dietitian is part of your health picture, keep them in the loop.\n\n---\n\n`;
    db.update(users).set({ goalType: "muscle_gain" }).where(eq(users.phoneNumber, phone)).catch(() => {});
    db.insert(escalations).values({ userId: u.id, reason: "underweight_fatloss_request", triggerMessage: `BMI ${bmiGate.toFixed(1)} (${actualWeight}kg/${heightCm}cm) requested fat loss — auto-flipped to muscle_gain at onboarding`, priority: "high", slaDeadline: escalationSLA("high") }).catch((e) => console.error("[UNDERWEIGHT_GATE]", e));
  }
  // GOAL-REALITY GATE — the mirror of the underweight gate (Mahle masterclass, made
  // deterministic): catch a goal that fights the body's reality so we never set someone up to
  // fail from day one. Overweight/obese choosing to BULK just piles on more fat; an experienced
  // client wanting RECOMP while carrying fat is the slow road — a focused cut wins. We steer to
  // the honest goal, explain warmly and firmly, flag the coach, and tell them how to override.
  const _reFirst = u.name?.split(" ")[0] || "";
  const _reExp = exp || u.trainingExperience || "beginner";
  let goalRealityNote = "";
  const _reGoal = u.goalType || "fat_loss";
  if (bmiGate >= 30 && _reGoal === "muscle_gain") {
    u.goalType = "fat_loss";
    goalRealityNote = `${_reFirst ? _reFirst + ", one" : "One"} honest thing before we start: at ${actualWeight}kg a straight "bulk" would add *more* fat on top of what's already there — the opposite of what you want. We get you lean and strong *first*, then build on a clean base — you'll see and feel it far faster this way. (If you're certain you only want to focus on building, reply *change my goal to muscle gain* and I'll switch it.)\n\n---\n\n`;
    db.update(users).set({ goalType: "fat_loss" }).where(eq(users.phoneNumber, phone)).catch(() => {});
    db.insert(escalations).values({ userId: u.id, reason: "overweight_bulk_request", triggerMessage: `BMI ${bmiGate.toFixed(1)} requested muscle_gain — steered to fat_loss at onboarding`, priority: "medium", slaDeadline: escalationSLA("medium") }).catch(() => {});
  } else if (bmiGate >= 27.5 && _reGoal === "muscle_gain") {
    u.goalType = "recomposition";
    goalRealityNote = `${_reFirst ? _reFirst + ", quick" : "Quick"} note before we start: at your weight the smartest play isn't a straight bulk — it's *recomposition*: build muscle while the extra fat comes off at the same time. Your body has the fuel to do both, and that's what I've set you up for. (Want a pure building focus instead? Reply *change my goal to muscle gain*.)\n\n---\n\n`;
    db.update(users).set({ goalType: "recomposition" }).where(eq(users.phoneNumber, phone)).catch(() => {});
  } else if (bmiGate >= 27 && _reGoal === "recomposition" && /(advanced|experienced|intermediate)/i.test(_reExp)) {
    u.goalType = "fat_loss";
    goalRealityNote = `${_reFirst ? _reFirst + ", real" : "Real"} talk before we start: recomp works best for beginners. Someone who's trained a while *and* is carrying some extra fat gets further, faster with a focused *cut* — lean out first, then build with a clean base and real shape. That's the plan I've set. (If you'd rather run recomp, reply *change my goal to recomposition*.)\n\n---\n\n`;
    db.update(users).set({ goalType: "fat_loss" }).where(eq(users.phoneNumber, phone)).catch(() => {});
  }

  const defaultGoal = u.goalType || "fat_loss";

  const trainingDays = u.trainingDaysPerWeek || ((isYouth || isElderly) ? 3 : 4);

  // Use the experience just ANSWERED (the exp arg), not u.trainingExperience — the
  // in-memory row was loaded before this turn's update, so it's still null here and
  // an advanced client's targets were silently computed as a beginner's
  // (caught by onboarding-e2e Flow C, 2026-07-14).
  const experience = exp || u.trainingExperience || "beginner";
  const { calorieTarget, proteinTarget } = calculateTargets(
    actualWeight, defaultGoal, u.lifeSituation || "office", trainingDays, gender, age, heightCm, experience
  );

  const stepsTarget = calculateStepsTarget(actualWeight, age, heightCm, experience, u.goalType || "fat_loss");

  const referralCode = await generateReferralCode(u.name);

  await db.update(users).set({
    trainingDaysPerWeek: trainingDays,
    trainingExperience: exp,
    weeklyFoodBudget: budget,
    budgetLevel,
    lifeSituation: u.lifeSituation || "office",
    workSchedule: u.workSchedule || "standard",
    calorieTarget,
    proteinTarget,
    stepsTarget,
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    programmeStartDate: new Date(),
    // betaBypassUntil is null until first onboarding completes. Using it as the "already
    // onboarded" signal is safer than subscriptionStatus (which defaults to "inactive")
    // and closes the trial-restart exploit. PAY-TO-START by default (no free window):
    // status stays inactive so the paywall hits right after the Day-1 taste; set
    // TRIAL_DAYS>0 to reinstate a free trial. (2026-07-14, founder: "I hate trials".)
    ...(!u.betaBypassUntil ? (TRIALS_ENABLED ? {
      subscriptionStatus: "trial",
      betaBypassUntil: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
    } : {
      subscriptionStatus: "inactive",
      betaBypassUntil: new Date(), // non-null → "onboarded"; closes the restart exploit
    }) : {}),
    onboardingState: "COMPLETE",
    ...(referralCode && !u.referralCode ? { referralCode } : {}),
  }).where(eq(users.phoneNumber, phone));

  const goalLabel: Record<string, string> = {
    fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Recomposition",
  };
  const mode = u.trainingMode || "home";
  const gymName = u.gymName;
  const modeLabel = mode === "walk_only" ? "Walking + bodyweight" : mode === "gym_dumbbell" ? "Dumbbell gym" : mode === "gym" ? (gymName || "Gym") : "Home training";

  const isPostpartum = u.lifeSituation === "postpartum_breastfeeding";
  const ageNote = isPostpartum
    ? `\n\n_Postpartum note: Your calorie target is set higher than a standard fat loss plan — breastfeeding burns 300–500 kcal/day and cutting too hard reduces milk supply. Aim for 0.5kg/week max. Pelvic floor exercises before any running or heavy lifting. Cleared for gentle training from 6 weeks — get doctor sign-off first._`
    : isYouth
    ? `\n\n_Note for under-18s: Your programme is designed to be safe and fun. No heavy maximal lifts — we focus on movement, form, and building healthy habits for life._`
    : isElderly
      ? `\n\n_Your programme is joint-friendly with lower-impact alternatives. We focus on mobility, strength maintenance, and keeping you active and independent. Always listen to your body._`
      : "";

  const stepsLabel = stepsTarget.toLocaleString();

  const updatedUser = { ...u, trainingMode: mode, programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1, stepsTarget, age: u.age || 30, primaryFocusArea: u.primaryFocusArea };
  // The user is already marked COMPLETE above — programme generation must never be
  // allowed to throw here, or the welcome (their first impression) is lost entirely.
  let firstWorkout: string;
  try {
    firstWorkout = getKamlifeProgramme(updatedUser, true);
  } catch (e) {
    console.error("[ONBOARDING] getKamlifeProgramme failed in completeOnboarding — using fallback:", e);
    firstWorkout = `Your Day 1 workout is ready — just say *workout* and I'll send it straight through.`;
  }

  const weightDisplay = u.currentWeight != null ? `\n*Weight:* ${actualWeight}kg` : "";
  const heightDisplay = u.heightCm != null ? ` · ${heightCm}cm` : "";
  const bmiDisplay = u.bmi ? ` · BMI ${u.bmi}` : "";

  const refCodeLine = referralCode ? `\n\n🎁 *Your referral code: ${referralCode}* — share it. When a friend joins with it, *you get a free month.* They join at the normal R199, with the same 7-day money-back guarantee — zero risk.` : "";

  // Goal-specific hook line — personal, not generic
  const goalHook: Record<string, string> = {
    fat_loss: `The weight does not come off in the gym — it comes off in the kitchen and on your feet. I have set your targets so you lose fat without starving.`,
    muscle_gain: `Muscle is built with consistency, not intensity. Progressive overload every session and enough protein — that is the whole secret. I have set your numbers.`,
    recomposition: `Recomp takes longer but the results last. We build muscle and lose fat at the same time. Protein stays high, training stays consistent, steps stay non-negotiable.`,
  };

  const trainingHook = mode === "walk_only"
    ? `No gym needed. Walking and bodyweight — done right, it changes your body.`
    : mode === "home"
      ? `Home training is underrated. The best results I have seen came from people with no gym and no excuses.`
      : `${gymName || "The gym"} is your tool. How you use it decides everything.`;

  const name = u.name || "there";
  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const cleanPhoneOnb = u.phoneNumber.replace(/^whatsapp:/, "");
  const payLinkOnb = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhoneOnb)}` : appUrl;

  const goalCalExplainer: Record<string, string> = {
    fat_loss: `*What ${calorieTarget} kcal means:* A banana is ~100 kcal. A plate of pap with stew is ~550 kcal. A Viennie on white bread is ~350 kcal. Your body burns ~1,200–1,500 kcal just to breathe and run your organs — before you move a single step. Eat at your target and you lose fat without starving.\n\n*What ${proteinTarget}g protein means:* 1 egg = ~6g. 1 tin of pilchards = ~25g. 100g chicken breast = ~31g. Two eggs and a tin of pilchards gets you 37g — a third of your daily target. Hit this number and hunger drops, muscle stays.`,
    muscle_gain: `*What ${calorieTarget} kcal means:* This is a small surplus above what you burn — enough to build muscle without unnecessary fat gain. A plate of pap with chicken is ~600 kcal. Three eggs is ~210 kcal. Don't undershoot this target — you can't build with an empty tank.\n\n*What ${proteinTarget}g protein means:* This is the actual driver of muscle growth — more important than what exercises you do. 1 egg = ~6g. 100g chicken = ~31g. 1 tin of tuna = ~26g. Spread it across 3–4 meals and hit the number daily.`,
    recomposition: `*What ${calorieTarget} kcal means:* This is your maintenance level — we build muscle and lose fat simultaneously. A banana is ~100 kcal. A plate of pap with chicken is ~600 kcal. The key is consistency — day-to-day variation is fine, weekly average is what counts.\n\n*What ${proteinTarget}g protein means:* Protein is the whole mechanism here. It repairs muscle after training and keeps you full so you don't overeat. 1 egg = ~6g. 100g chicken = ~31g. Amasi (250ml) = ~9g. Hit this number and the recomp happens.`,
  };
  const calExplainer = goalCalExplainer[defaultGoal] || goalCalExplainer.fat_loss;

  // Echo their dream back (personalisation) + Kam's commitment framing — "it's mental
  // more than physical, commit to the habits, you can relax" (2026-07-12 screenshots).
  const dreamText = (u.dreamGoal || "").trim();
  const dreamEcho = dreamText
    ? `You told me your dream: *"${dreamText.length > 90 ? dreamText.slice(0, 90).trim() + "…" : dreamText}"* — I've got it, and I'll hold you to it.\n\n`
    : "";
  const commitLine = `Here's the deal: this is more *mental* than physical. Commit to the *habits*, trust the process, and you can relax — I carry the rest. 🧘\n\n`;
  // 30-day expectation reset (2026-07-13 retention P0): they bought transformation, but
  // no body changes in 14 days — and when it doesn't, THE PRODUCT failed them (in their
  // story) and they quit. Reset the contract on day one: month one is about not quitting.
  const expectationReset = `*The next 30 days, honestly:* you won't look like a new person yet — nobody does, and anyone who promises that is lying to you. What WILL happen: you'll prove to yourself you can show up for 30 days straight. That's the only goal this month. The body follows — it always does.\n\n`;

  const msg1 = `${name}, your programme is built — and it stays *alive*. Your numbers adjust every week as your body changes; this isn't a plan you download once, it's a coach that keeps up with you.\n\n${dreamEcho}${expectationReset}${commitLine}${goalHook[defaultGoal] || goalHook.fat_loss}\n\n*Your targets:*\n• ${calorieTarget} kcal/day · ${proteinTarget}g protein\n• ${stepsLabel} steps/day — non-negotiable\n• ${trainingDays} training sessions/week\n\n${trainingHook}${ageNote}${refCodeLine}`;
  const msg1b = `${calExplainer}\n\nLog your first meal and I will show you exactly where it lands. Type what you ate — e.g. *2 eggs and pap* — and Coach K does the maths.`;

  const msg2 = `*Day 1 is ready.*\n\n${firstWorkout}`;
  const msg3 = `Your personalised shopping list and weekly meal plan are ready.\n\nPay to unlock them — and Day 2 drops the moment you finish today's session.\n\n*R199/month — cancel anytime:*\n${payLinkOnb}\n\n_R6.63/day. Less than a coffee. *7-day money-back guarantee* — if you're not happy in your first week, full refund, no questions. POPIA protected._`;
  // ACTIVATION MOMENT — the calm, clear expectation-setter (what's required, don't
  // panic, what to expect, at your own pace), then ONE tiny first action to hook the
  // habit in the first five minutes.
  const activationBrief = buildActivationBrief(u.name?.split(" ")[0]);
  const msg4 = `${activationBrief}\n\n📸 *Right now, take one photo of your next meal or snack and send it.* That single act is your first win — and the whole habit in one move.\n\n_I keep it simple and plain — no confusing numbers. Love the detail? Just say *"show me the numbers"* anytime._`;
  return `${underweightNote}${goalRealityNote}${msg1}\n\n---\n\n${msg1b}\n\n---\n\n${msg2}\n\n---\n\n${msg3}\n\n---\n\n${msg4}`;
}

// ============================================================
// ONBOARDING FLOW — 3-QUESTION FAST TRACK
// POPIA → Name → Goal → Gym or Home → Immediate programme
// Everything else collected progressively through coaching
// ============================================================

// ═══════════════════════════════════════════════════════════════════════════════
// BULK INTAKE — extraction and the FSM jump (2026-08-03)
//
// Detection, the hallucination brake and the summary are pure and unit-tested in
// onboarding-intake.ts. What lives here is the part that cannot be pure: the model
// call, the write, and deciding which question the client still has to answer.
//
// Deviation from the 2026-07-07 spec, stated deliberately: the spec asked for a
// YES-to-confirm round trip before committing. This writes first and SHOWS what it
// captured instead. Two reasons. A tired client pasting thirteen facts at 9pm should
// not then have to pass a quiz on them; and every one of these fields is already
// correctable in plain language ("change my goal to muscle gain", "I'm 92kg") through
// the normalizer, which did not exist when the spec was written. Nothing is silent —
// the client reads back exactly what was stored, in the same message.
//
// POPIA is untouched: WELCOME is only reachable after explicit consent. The underage
// gate is re-applied below on the extracted age, so a blob cannot walk around it.
// ═══════════════════════════════════════════════════════════════════════════════

const BULK_SYSTEM = `You extract a South African fitness client's intake details from one message they pasted.
Return JSON only, with any of these keys you can find, and NO others:
name, gender ("male"|"female"), age, weightKg, heightCm, goalType ("fat_loss"|"muscle_gain"), targetWeightKg, medicalConditions, injuries, gymName, homeEquipment, trainingExperience, foodDislikes, notes.
RULES: omit a key entirely rather than guessing it. Never calculate a value they did not state. Copy free text in their own words. "tone up"/"slim"/"lose"/"cut" = fat_loss; "build"/"bulk"/"gain muscle" = muscle_gain. If they name a weight range to reach, targetWeightKg is the HIGHER number. Name is one or two words only.`;

async function extractBulkIntake(text: string): Promise<BulkIntake | null> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY });
    // gpt-4o, not mini: this fires at most once per client, on the first impression,
    // and a mis-parsed intake is paid for in every reply that follows it.
    const resp = await client.chat.completions.create({
      model: "gpt-4o", temperature: 0, max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: BULK_SYSTEM },
        { role: "user", content: text.slice(0, 1500) },
      ],
    });
    const raw = JSON.parse(resp.choices[0]?.message?.content || "{}");
    return applyIntakeBrake(raw as BulkIntake, text);
  } catch (e) {
    console.warn("[BULK_INTAKE] extraction failed, falling back to the normal flow:", (e as Error)?.message || e);
    return null;
  }
}

/**
 * The states a client still has to walk, in FSM order, each with the test for
 * "did the blob already answer this?" and the question to ask if it did not.
 *
 * This table is the jump. It is declared rather than derived so that adding a state
 * to the FSM without deciding what a blob does about it is a visible omission here,
 * not a client silently skipping a question.
 */
const BULK_RESUME: Array<{ state: string; missing: (u: any) => boolean; ask: (u: any) => string }> = [
  { state: "ASK_GENDER", missing: u => !u.gender, ask: () => `Male or female?` },
  { state: "ASK_AGE_NEW", missing: u => !u.age, ask: () => `How old are you?` },
  { state: "ASK_WEIGHT_HEIGHT", missing: u => !u.currentWeight || !u.heightCm, ask: u => u.currentWeight && !u.heightCm ? `And your height?\n\nExample: *1.72m* or *172cm*` : `What's your weight and height?\n\nExample: *78kg, 1.72m*` },
  { state: "ASK_GOAL", missing: u => !u.goalType, ask: () => `Main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both` },
  { state: "ASK_MEDICAL", missing: u => u.medicalConditions == null, ask: () => MEDICAL_QUESTION },
  { state: "ASK_INJURIES", missing: u => u.injuries == null, ask: () => `Any injuries or joints I should train around? Reply *none* if not.` },
  { state: "ASK_EQUIPMENT", missing: u => !u.gymName && !u.homeEquipment, ask: () => `Where will you train — a gym, or at home?` },
  { state: "ASK_EXPERIENCE", missing: u => !u.trainingExperience, ask: () => `How much training have you done before — beginner, some experience, or advanced?` },
];

async function commitBulkIntake(user: any, bulk: BulkIntake, source: string, phone: string): Promise<string> {
  // UNDERAGE GATE, re-applied. A blob must not be a way around the age check.
  if (typeof bulk.age === "number" && bulk.age < 14) {
    await db.update(users).set({ onboardingState: "BLOCKED_UNDERAGE" }).where(eq(users.phoneNumber, phone));
    return `Coach K is for ages 14 and up. Chat to a parent or guardian about getting started together.`;
  }
  const set: Record<string, unknown> = {};
  if (bulk.name) set.name = bulk.name;
  if (bulk.gender) set.gender = bulk.gender;
  if (bulk.age) set.age = bulk.age;
  if (bulk.weightKg) set.currentWeight = String(bulk.weightKg);
  if (bulk.heightCm) set.heightCm = bulk.heightCm;
  if (bulk.goalType) set.goalType = bulk.goalType;
  if (bulk.targetWeightKg) set.targetWeightKg = String(bulk.targetWeightKg);
  if (bulk.medicalConditions) set.medicalConditions = bulk.medicalConditions;
  if (bulk.injuries) set.injuries = bulk.injuries;
  if (bulk.gymName) set.gymName = bulk.gymName;
  if (bulk.homeEquipment) set.homeEquipment = bulk.homeEquipment;
  if (bulk.trainingExperience) set.trainingExperience = bulk.trainingExperience;
  if (bulk.foodDislikes) set.foodDislikes = bulk.foodDislikes;
  if (bulk.weightKg && bulk.heightCm) {
    const hM = bulk.heightCm / 100;
    set.bmi = String(Math.round((bulk.weightKg / (hM * hM)) * 10) / 10);
  }

  const merged = { ...user, ...set, currentWeight: set.currentWeight ?? user.currentWeight };
  const next = BULK_RESUME.find(r => r.missing(merged));
  set.onboardingState = next ? next.state : "ASK_MEDICAL";
  await db.update(users).set(set).where(eq(users.phoneNumber, phone));

  // A dislike is a preference that has to outlive onboarding — every meal suggestion
  // from here on must respect it, so it goes to durable memory, not just a column.
  if (bulk.foodDislikes) {
    try {
      const { storeMemory } = await import("./memory");
      await storeMemory(phone, `Does not eat / dislikes: ${bulk.foodDislikes}`, "preference");
    } catch { /* memory is best-effort; the column still holds it */ }
  }

  const who = bulk.name ? ` ${bulk.name}` : "";
  const captured = describeIntake(bulk);
  const question = next ? next.ask(merged) : MEDICAL_QUESTION;
  console.log(`[BULK_INTAKE] ${phone.slice(-4)} — ${Object.keys(set).length - 1} fields from one message, resuming at ${set.onboardingState}`);
  return `Sharp${who} 👌 I got all of that — you don't have to type it again.\n\n${captured}\n\nAnything wrong there, just tell me and I'll fix it.\n\n---\n\n${question}`;
}

export async function handleOnboarding(user: any, message: string, phone: string): Promise<string> {
  const state = user.onboardingState || "START";
  const msg = message.trim();

  // Warn-only state validation (#17/#41): surfaces an unknown state instead of
  // a silent no-response. Does not block — the flow proceeds exactly as before.
  if (!ONBOARDING_STATES.has(state)) {
    console.error(`[ONBOARDING] Unknown state "${state}" for ${phone.slice(-4)} — falling through. This is a bug; add the state to ONBOARDING_STATES or fix the transition.`);
  }

  // ---- BLOCKED states — hard exits ----
  if (state === "BLOCKED_UNDERAGE") {
    return `Coach K is for ages 14 and up. When you're ready, message again and we'll build your programme.`;
  }

  // ---- PRE_ONBOARD — 1-2 conversational exchanges before formal questionnaire ----
  // People come in talking about cellulite, weekends-only training, referrals, real life.
  // Engage with that first. Max 2 exchanges, then naturally hand off to signup.
  if (state === "PRE_ONBOARD") {
    const isReady = /^(yes|yebo|ja|sure|ok|okay|let.?s go|ready|start|sign|register|get me started|i.?m ready|go ahead|do it|yes coach|yes please)[\s!.]*$/i.test(msg.trim());
    if (isReady) {
      await db.update(users).set({ onboardingState: "ASK_POPIA" }).where(eq(users.phoneNumber, phone));
      return `Before I build your programme, I need your consent to store and process your personal information under POPIA (South Africa's data protection law).\n\n*What I store:* your name, phone number, fitness goal, food logs, workouts, and steps. If you share health info (weight, medical conditions), that is stored as special personal information and used only to make your coaching safer.\n\n*Your rights:* reply *delete my data* at any time to permanently erase everything. Full policy: kamlifecoach.co.za/privacy\n\n*Never sold. Never shared for marketing.*\n\nReply *yes* to give consent and continue.`;
    }
    // Another question / more context — answer briefly and re-invite
    const continuationCtx = `You are Coach K — a direct, warm South African fitness coach on WhatsApp. A potential new client is asking questions before signing up. Reply in 1-2 sentences only. Be specific and helpful. End EVERY response on a new line with exactly: "Reply *yes* when you're ready to build your programme."

Banned: "I understand", "I hear you", "journey", "wellness", "reach out", "feel free", "awesome"
DON'T MAKE THEM THINK: lead with the OUTCOME they want in plain words ("lose weight eating your own food", "a coach that checks in every day"), never product-speak like "programme", "accountability", "guidance". Say what they GET.
SA voice — direct, short, practical. No fluff. No price mentions.`;
    const preReply = await askCoachK(message, user, continuationCtx);
    return preReply;
  }

  // ---- START — if they sent a real message, engage it before pitching ----
  if (state === "START") {
    const isSimpleStart = /^(yes|yebo|ja|sure|ok|okay|hi|hey|hello|howzit|hola|sawubona|eita|sup|yo|let.?s go|start|begin|go|send|register|join|sign|i want|get me)[\s!.]*$/i.test(msg.trim());

    if (!isSimpleStart && msg.length > 8) {
      // Real message — engage with their situation first
      await db.update(users).set({ onboardingState: "PRE_ONBOARD" }).where(eq(users.phoneNumber, phone));
      const intakeCtx = `You are Coach K — a direct, warm South African fitness and nutrition coach running KamLife Coach on WhatsApp.

A new potential client has just messaged you for the FIRST TIME. Reply in exactly 2-3 short sentences:
1. Acknowledge their specific situation or concern by name (cellulite, weight, no-gym, weekend training, referral — whatever they said)
2. Give them one piece of genuine, specific hope based on real fitness principles
3. Ask ONE follow-up question that will help you understand their situation better

Then on a NEW LINE add: "Reply *yes* when you're ready and I'll build your personalised programme."

Rules: Short sentences. No lists. No bullet points. SA voice — warm, direct, no corporate speak.
DON'T MAKE THEM THINK: name the OUTCOME plainly (get fit eating the food they already eat, a coach in their pocket), never jargon like "programme" or "accountability".
Banned words: "I understand", "I hear you", "journey", "wellness", "reach out", "feel free", "awesome", "amazing", "fantastic"
Do NOT mention price. Do NOT mention R199. Just be a helpful coach.
If they mention a referral (e.g. "from Donda"), acknowledge it warmly — one word is enough.`;
      const intakeReply = await askCoachK(message, user, intakeCtx);
      return intakeReply;
    }

    // Simple greeting or "yes" → standard pitch
    await db.update(users).set({ onboardingState: "ASK_POPIA" }).where(eq(users.phoneNumber, phone));
    // Meta-parity consent gate (2026-07-22): age 18+, AI disclosure, a human-coach check-in path,
    // POPIA + data deletion, and Terms/Privacy links — mirrors the pattern the SA gov health bot
    // used to pass Meta. Tapping "Yes, I agree" (or typing yes/agree) consents; "No thanks" deletes.
    return replyWithButtons(
      `I'm Coach K. I help you lose weight and get fit using the food you already eat — right here on WhatsApp. No gym. No app. No expensive diet.\n\nJust tell me what you ate — "pap and chicken" — and I'll log it. I check in every day so you actually stick to it.\n\nR199/month — R6.63 a day, less than a coffee. Cancel anytime.\n\n*Before we start:*\n✅ You're 18 or older.\n✅ I'm an AI coach, not a doctor — for any medical condition, follow your doctor.\n🤝 A real coach may check in on you if a message suggests you need extra support.\n🔒 Your info is stored under POPIA — only for your coaching, never sold. Reply *delete my data* anytime.\nTerms: kamlifecoach.co.za/terms · Privacy: kamlifecoach.co.za/privacy\n\nTap *Yes, I agree* and I'll build your plan.`,
      ["Yes, I agree", "No thanks"],
    );
  }

  // ---- ASK_POPIA ----
  if (state === "ASK_POPIA") {
    const lower = msg.toLowerCase(); // phones auto-capitalise "Yes" — match case-insensitively
    const consentWords = ["yes", "agree", "consent", "ok", "okay", "yebo", "ja", "sure", "accept", "i agree", "i consent", "yes coach", "i do"];
    const isConsent = consentWords.some(k => {
      if (lower === k) return true;
      if (k.includes(" ")) return lower.includes(k); // multi-word phrases
      return new RegExp(`\\b${k}\\b`).test(lower);   // single-word: whole-word only
    });
    if (isConsent) {
      await db.update(users).set({ popiConsent: true, popiConsentAt: new Date(), onboardingState: "WELCOME" }).where(eq(users.phoneNumber, phone));
      return `Sharp. What's your name?`;
    }
    const isRefusal = /\b(no|nope|refuse|disagree|don.?t|not|never|nah|nay)\b/i.test(msg) || msg.trim().toLowerCase() === "no";
    if (isRefusal) {
      // POPIA requires we delete data when consent is refused
      await db.delete(users).where(eq(users.phoneNumber, phone));
      return `Understood. Without consent I cannot store your data or coach you. If you change your mind, message me again and we can start fresh.`;
    }
    return `I need your agreement before I can coach you. Your data is used only for your coaching — never sold. Reply *yes* to continue.`;
  }

  // ---- WELCOME — name, OR the whole intake in one paste ----
  if (state === "WELCOME") {
    // BULK INTAKE: this is the exact point the production failure happened — the client
    // pastes thirteen facts and the FSM files the lot under "name". Detection is free and
    // deterministic; only a message that already looks like a blob ever costs a model call.
    if (process.env.BULK_INTAKE !== "off" && looksLikeBulkIntake(msg)) {
      const bulk = await extractBulkIntake(msg);
      if (bulk && Object.keys(bulk).length >= 3) return await commitBulkIntake(user, bulk, msg, phone);
      // Nothing usable → fall through to the ordinary name question. Nothing is lost.
    }
    const name = parseFirstName(msg);
    if (!name) return `Almost — just your first name. What do people call you? 🙂`;
    await db.update(users).set({ name, onboardingState: "ASK_GENDER" }).where(eq(users.phoneNumber, phone));
    return `Sharp ${name}. Male or female?`;
  }

  // ---- ASK_GENDER ----
  if (state === "ASK_GENDER") {
    const lower = msg.toLowerCase().trim();
    const isMale = lower === "male" || lower === "m" || lower === "1" || lower === "guy" || lower === "man" || lower === "bro" || lower === "indoda";
    const isFemale = lower === "female" || lower === "f" || lower === "2" || lower === "woman" || lower === "lady" || lower === "girl" || lower === "sis" || lower === "intombi";
    if (!isMale && !isFemale) {
      // No dead-end: decliners / non-binary / "why?" advance with a neutral default; anyone else gets a re-ask naming the escape — no infinite loop.
      const declines = lower.includes("🤷") || /\b(prefer not|rather not|don.?t want|not say|none|neither|non.?binary|nonbinary|other|why|does it matter|doesn.?t matter|skip|pass)\b/i.test(lower);
      if (declines) {
        await db.update(users).set({ gender: "male", onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
        return `No problem — I'll fine-tune your targets from your weight and your logs.\n\nHow old are you?`;
      }
      return `Just so I set your targets right — reply *male* or *female*. (Or say *skip* and I'll work it out from your logs.)`;
    }
    const gender = isMale ? "male" : "female";
    if (isFemale) {
      await db.update(users).set({ gender, onboardingState: "ASK_FEMALE_FOCUS" }).where(eq(users.phoneNumber, phone));
      return `Got it. What's your main training focus?\n\n1️⃣ *Full body* — tone and strengthen everything\n2️⃣ *Glutes & legs* — build and sculpt the lower body`;
    }
    await db.update(users).set({ gender, onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
    return `How old are you?`;
  }

  // ---- ASK_FEMALE_FOCUS ----
  if (state === "ASK_FEMALE_FOCUS") {
    const lower = msg.toLowerCase().trim();
    const isGlutes = msg.includes("2") || lower.includes("glute") || lower.includes("bum") || lower.includes("butt") || lower.includes("leg") || lower.includes("lower") || lower.includes("booty");
    const focusArea = isGlutes ? "glutes_legs" : null;
    await db.update(users).set({
      ...(focusArea ? { primaryFocusArea: focusArea } : { primaryFocusArea: null }),
      onboardingState: "ASK_POSTPARTUM",
    }).where(eq(users.phoneNumber, phone));
    return `One more — are you currently pregnant, recently gave birth, or breastfeeding?\n\n1️⃣ Yes — postpartum or breastfeeding\n2️⃣ No — continue`;
  }

  // ---- ASK_POSTPARTUM ----
  if (state === "ASK_POSTPARTUM") {
    const lower = msg.toLowerCase().trim();
    const isPostpartum = msg.includes("1") || lower.includes("yes") || lower.includes("breastfeed") || lower.includes("postpartum") || lower.includes("gave birth") || lower.includes("nursing") || lower.includes("new mom") || lower.includes("new mum") || lower.includes("baby");
    if (isPostpartum) {
      await db.update(users).set({ lifeSituation: "postpartum_breastfeeding", onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
      return `Understood — your plan will be adjusted. While breastfeeding your body needs more calories, not fewer. We will lose the weight slowly and safely so your milk supply stays strong.\n\nHow old are you?`;
    }
    await db.update(users).set({ onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
    return `How old are you?`;
  }

  // ---- ASK_AGE_NEW — age drives workout safety, intensity, and tone ----
  if (state === "ASK_AGE_NEW") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 110) {
      return `Just your age — for example: 28`;
    }
    if (age < 14) {
      await db.update(users).set({ onboardingState: "BLOCKED_UNDERAGE" }).where(eq(users.phoneNumber, phone));
      return `Coach K is designed for ages 14 and up. Chat to a parent or guardian about getting started together.`;
    }
    const isElderly = age >= 60;
    const isYouth = age < 18;
    await db.update(users).set({
      age,
      elderlyClient: isElderly,
      onboardingState: "ASK_WEIGHT_HEIGHT",
    }).where(eq(users.phoneNumber, phone));

    // Age-appropriate response
    if (isYouth) {
      return `${age} — sharp, young legend. 💪 What's your weight and height?\n\nExample: *78kg, 1.72m*`;
    }
    if (isElderly) {
      return `${age} — respect. I'll keep your programme joint-friendly and safe.\n\nWhat's your weight and height?\n\nExample: *78kg, 1.72m*`;
    }
    return `Got it.\n\nWhat's your weight and height?\n\nExample: *78kg, 1.72m*`;
  }

  // ---- ASK_EMAIL — optional, backup contact ----
  // ---- ASK_GOAL ----
  if (state === "ASK_GOAL") {
    // Goal detection is pure + tested in goal-profiles.ts. Health-led goals (general /
    // health_condition) are now reachable at signup so a gogo or someone managing their
    // sugar is never funnelled into a fat-loss deficit (2026-07-21 spine surgery).
    if (!looksLikeGoalAnswer(msg)) {
      return `What's your main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both\n4️⃣ Just get healthier & feel good`;
    }
    const goal = classifyGoalFromText(msg);

    // If weight already captured (e.g., from ASK_WEIGHT_HEIGHT flow), skip the duplicate re-ask and set protein target now.
    const hasWeight = !!user.currentWeight;
    if (hasWeight) {
      const w = parseFloat(user.currentWeight!);
      const { proteinTarget: goalProt } = calculateTargets(w, goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
      await db.update(users).set({
        goalType: goal,
        proteinTarget: goalProt,
        onboardingState: "ASK_MEDICAL",
      }).where(eq(users.phoneNumber, phone));
      const goalLabel = goal === "muscle_gain" ? "Build muscle"
        : goal === "recomposition" ? "Lose fat and build muscle"
        : goal === "general" ? "Get healthier & feel good"
        : goal === "health_condition" ? "Healthier living"
        : "Lose fat";
      const healthLed = goal === "general" || goal === "health_condition";
      const confirmLead = healthLed
        ? `Love that — *${goalLabel}*. No scales, no calorie stress. We build steady energy, good food, and movement — at your pace.${goal === "health_condition" ? ` I'll coach your food, movement, and daily habits — and for anything about your condition, keep following your doctor.` : ""}`
        : `Goal locked in: *${goalLabel}*.`;
      return `${confirmLead}\n\n${MEDICAL_QUESTION}`;
    }

    await db.update(users).set({ goalType: goal, onboardingState: "ASK_WEIGHT_HEIGHT_FAST" }).where(eq(users.phoneNumber, phone));
    return `Before I set your targets: what's your current weight and height?\n\nExample: *78kg, 1.72m*\n\nIf you don't know, reply *skip*.`;
  }

  // ---- ASK_WEIGHT_HEIGHT_FAST — keep fast flow but avoid generic targets ----
  if (state === "ASK_WEIGHT_HEIGHT_FAST") {
    const lower = msg.toLowerCase().trim();
    const isSkip = lower === "skip" || lower === "not sure" || lower === "dont know" || lower === "don't know" || lower === "unknown";

    if (isSkip) {
      const fallbackWeight = user.gender === "female" ? 65 : 75;
      const { proteinTarget: skipProt } = calculateTargets(fallbackWeight, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, 170, user.trainingExperience || "beginner");
      await db.update(users).set({
        currentWeight: fallbackWeight.toString(),
        heightCm: null,
        bmi: null,
        proteinTarget: skipProt,
        onboardingState: "ASK_MEDICAL",
      }).where(eq(users.phoneNumber, phone));
      return `No stress. I will start with baseline targets and adjust once you log weight.\n\n${MEDICAL_QUESTION}`;
    }

    const weightMatch = msg.match(/(\d+(?:\.\d+)?)\s*kg/i);
    if (!weightMatch) {
      return `I need weight in kg to personalise targets.\n\nExample: *78kg, 1.72m* (or reply *skip*)`;
    }

    const weight = parseFloat(weightMatch[1]);
    if (weight < 30 || weight > 350) {
      return `That weight looks off. Please send it like: *78kg, 1.72m*`;
    }

    const heightMMatch = msg.match(/(\d+\.\d+)\s*m(?!g)/i);
    const heightCmMatch = msg.match(/(\d{3})\s*cm/i);
    let heightCmVal: number | null = null;
    let bmiVal: string | null = null;

    if (heightMMatch) {
      const heightM = parseFloat(heightMMatch[1]);
      if (heightM >= 1.2 && heightM <= 2.4) {
        heightCmVal = Math.round(heightM * 100);
      }
    } else if (heightCmMatch) {
      const parsedCm = parseInt(heightCmMatch[1], 10);
      if (parsedCm >= 120 && parsedCm <= 240) {
        heightCmVal = parsedCm;
      }
    }

    if (heightCmVal) {
      const hM = heightCmVal / 100;
      const bmi = Math.round((weight / (hM * hM)) * 10) / 10;
      bmiVal = bmi.toString();
    }

    const { proteinTarget: weightProt } = calculateTargets(weight, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, heightCmVal || 170, user.trainingExperience || "beginner");
    await db.update(users).set({
      currentWeight: weight.toString(),
      heightCm: heightCmVal,
      bmi: bmiVal,
      proteinTarget: weightProt,
      onboardingState: "ASK_MEDICAL",
    }).where(eq(users.phoneNumber, phone));

    return `Perfect — targets will be based on ${weight}kg${heightCmVal ? ` and ${heightCmVal}cm` : ""}.\n\n${MEDICAL_QUESTION}`;
  }

  // ---- ASK_BODY_PHOTOS — day-zero physique read; the PHOTOS arrive via routes.ts
  // (this text handler covers skip and stray text while the state is open) ----
  // ---- ASK_GOAL_CONFIRM — the photo read recommended a DIFFERENT phase; they decide ----
  if (state === "ASK_GOAL_CONFIRM") {
    const gcLower = msg.toLowerCase();
    const recMatch = (user.profileNotes || "").match(/\bgoalrec:(\w+)\b/i);
    const recommended = recMatch ? recMatch[1] : null;
    const cleanedNotes = (user.profileNotes || "").replace(/\s*\bgoalrec:\w+\b/gi, "").trim() || null;
    const takeRec = /^1\b/.test(msg.trim()) || /\b(yes|yebo|go with|your read|recommendation|switch|do that|sounds right|trust you)\b/.test(gcLower);
    const keepOwn = !takeRec && (/^2\b/.test(msg.trim()) || /\b(keep|stay|mine|original|no thanks|my choice)\b/.test(gcLower));
    if (!takeRec && !keepOwn) {
      return `Quick one so we build the right plan:\n\n1️⃣ Go with my read (recommended)\n2️⃣ Keep your original choice`;
    }
    const newGoal = takeRec && recommended ? recommended : (user.goalType || "fat_loss");
    const wConf = parseFloat(user.currentWeight || "0") || (user.gender === "female" ? 65 : 75);
    const { proteinTarget: confProt } = calculateTargets(wConf, newGoal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
    await db.update(users).set({ goalType: newGoal, proteinTarget: confProt, profileNotes: cleanedNotes, onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone));
    const gcLabel = newGoal === "muscle_gain" ? "Build muscle" : newGoal === "recomposition" ? "Lose fat and build muscle" : "Lose fat";
    const gcLine = takeRec && recommended
      ? `Good call — *${gcLabel}* it is. That's the plan your body asked for.`
      : `Understood — *${gcLabel}* stays. Your goal, your call, and I'll coach it properly either way.`;
    return `${gcLine}\n\n${MEDICAL_QUESTION}`;
  }

  // ---- ASK_EQUIPMENT — route by training location ----
  if (state === "ASK_EQUIPMENT") {
    const lower = msg.toLowerCase();

    // Walk-based plan — by choice (busy, no gym) or by medical limitation. Both are walk_only;
    // we infer which from the medical/injury data captured earlier in onboarding, so lifestyle
    // walkers get optional bodyweight tone-ups while medical walkers stay pure-walking-safe.
    if (/\b(just\s+walk(ing)?|only\s+walk(ing)?|walk(ing)?\s+only|want\s+to\s+walk|prefer\s+to\s+walk|rather\s+walk|walk\s+and\s+eat|no\s+gym.*walk|walk.*no\s+gym|doctor.*walk|injury.*walk|heart.*walk)\b/i.test(lower) || lower.trim() === "walking" || lower.trim() === "walk") {
      const hasInjury = !!(user.injuries && user.injuries.trim() && user.injuries.toLowerCase() !== "none");
      const isMedicalWalk = user.doctorClearanceRequired === true || /\bheart\b/i.test(user.medicalConditions || "") || hasInjury
        || /\b(doctor|injury|injured|medical|heart|prescribed|told\s+to)\b/i.test(lower);
      const baseNotes = (user.profileNotes || "").replace(/\bwalk:\w+\b/g, "").trim();
      const flag = isMedicalWalk ? "walk:medical" : "walk:lifestyle";
      await db.update(users).set({ trainingMode: "walk_only", gymName: null, profileNotes: baseNotes ? `${baseNotes} ${flag}` : flag, }).where(eq(users.phoneNumber, phone));
      const walkMsg = isMedicalWalk
        ? `Noted — walking only, kept gentle and safe. Your protein protects your muscle.`
        : `Walking + eating right is a real plan — busy people lose fat exactly this way. I'll add two optional 10-min tone-ups a week so the weight you lose is fat, not muscle.`;
      return `${walkMsg}\n\n---\n\n${await completeOnboarding(phone, { ...user, trainingMode: "walk_only", homeEquipment: user.homeEquipment }, DEFERRED_BUDGET, DEFERRED_BUDGET_LEVEL, DEFERRED_EXPERIENCE)}`;
    }

    // "No equipment" quick path — bodyweight only, skip sub-question
    if (/no equipment|bodyweight only|nothing|no gear/i.test(lower)) {
      await db.update(users).set({ trainingMode: "home", homeEquipment: "bodyweight_only", gymName: null }).where(eq(users.phoneNumber, phone));
      return `Bodyweight programme — no equipment needed.\n\n---\n\n${await completeOnboarding(phone, { ...user, trainingMode: "home", homeEquipment: "bodyweight_only" }, DEFERRED_BUDGET, DEFERRED_BUDGET_LEVEL, DEFERRED_EXPERIENCE)}`;
    }

    // Home training → ask what equipment they have
    if (/\bhome\b/i.test(lower) || /at home|home training|home workout/i.test(lower)) {
      await db.update(users).set({ gymName: null, onboardingState: "ASK_HOME_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
      return `What do you have at home?[BUTTONS:Dumbbells|Resistance bands|Bodyweight only|Mix (both)]`;
    }

    // Gym → ask if full gym or dumbbells only
    if (/\bgym\b/i.test(lower) || /virgin|planet fitness|curves|fitness/i.test(lower)) {
      let gymName: string | null = null;
      if (lower.includes("virgin")) gymName = "Virgin Active";
      else if (lower.includes("planet")) gymName = "Planet Fitness";
      else if (lower.includes("curves")) gymName = "Curves";
      else gymName = "Gym";
      await db.update(users).set({ gymName, onboardingState: "ASK_GYM_SETUP" }).where(eq(users.phoneNumber, phone));
      return `What does your gym have?[BUTTONS:Full gym (machines)|Dumbbells only]`;
    }

    // Unrecognised — re-ask
    return `How do you want to train?[BUTTONS:Gym|Home|No equipment|Just walking]`;
  }

  // ---- ASK_HOME_EQUIPMENT — capture home kit ----
  if (state === "ASK_HOME_EQUIPMENT") {
    const lower = msg.toLowerCase();
    let mode = "home";
    let homeEquipment = "bodyweight_only";

    if ((/dumbbell|dumbbells|weights|weight set|adjustable|db/i.test(lower)) && (/band|resistance/i.test(lower) || /mix|both/i.test(lower))) {
      mode = "gym_dumbbell"; homeEquipment = "mix";
    } else if (/dumbbell|dumbbells|weights|weight set|adjustable|db/i.test(lower)) {
      mode = "gym_dumbbell"; homeEquipment = "dumbbells";
    } else if (/band|resistance band/i.test(lower)) {
      mode = "home"; homeEquipment = "bands";
    } else if (/mix|both/i.test(lower)) {
      mode = "gym_dumbbell"; homeEquipment = "mix";
    }
    // default: bodyweight_only, mode=home

    await db.update(users).set({ trainingMode: mode, homeEquipment, gymName: null }).where(eq(users.phoneNumber, phone));

    const equipLabel = homeEquipment === "dumbbells" ? "Dumbbell" : homeEquipment === "bands" ? "Resistance band" : homeEquipment === "mix" ? "Dumbbell + band" : "Bodyweight";
    return `${equipLabel} programme locked in.\n\n---\n\n${await completeOnboarding(phone, { ...user, trainingMode: mode, homeEquipment: homeEquipment }, DEFERRED_BUDGET, DEFERRED_BUDGET_LEVEL, DEFERRED_EXPERIENCE)}`;
  }

  // ---- ASK_GYM_SETUP — full gym vs dumbbells only ----
  if (state === "ASK_GYM_SETUP") {
    const lower = msg.toLowerCase();
    const mode = /dumbbell|dumbbells only|db only|no machine|basic/i.test(lower) ? "gym_dumbbell" : "gym";

    await db.update(users).set({ trainingMode: mode }).where(eq(users.phoneNumber, phone));

    return `${await completeOnboarding(phone, { ...user, trainingMode: mode, homeEquipment: user.homeEquipment }, DEFERRED_BUDGET, DEFERRED_BUDGET_LEVEL, DEFERRED_EXPERIENCE)}`;
  }

  // ---- ASK_BUDGET — grocery budget tier ----
  // Fast-track path: routes to ASK_EXPERIENCE (experience not yet captured)
  // Legacy path: experience was captured before budget → complete directly
  if (state === "ASK_BUDGET") {
    const lower = msg.toLowerCase();
    let budget = "100_300";
    let budgetLevel = "medium";
    if (msg.includes("1") || lower.includes("under") || lower.includes("1500") || lower.includes("1,500") || lower.includes("budget") || lower.includes("tight")) {
      budget = "under_100"; budgetLevel = "low";
    } else if (msg.includes("2") || lower.includes("3000") || lower.includes("3,000") || lower.includes("medium")) {
      budget = "100_300"; budgetLevel = "medium";
    } else if (msg.includes("3") || lower.includes("5000") || lower.includes("5,000")) {
      budget = "300_600"; budgetLevel = "high";
    } else if (msg.includes("4") || lower.includes("over") || lower.includes("premium") || lower.includes("no limit")) {
      budget = "over_600"; budgetLevel = "premium";
    }

    if (user.trainingExperience) {
      // Legacy path: experience already captured, complete now
      return completeOnboarding(phone, user, budget, budgetLevel, user.trainingExperience);
    }

    // Fast-track path: ask experience before completing
    await db.update(users).set({
      weeklyFoodBudget: budget,
      budgetLevel,
      onboardingState: "ASK_EXPERIENCE",
    }).where(eq(users.phoneNumber, phone));

    return `Last one — training experience?\n\n1️⃣ Beginner — just starting out\n2️⃣ Some experience — been active before\n3️⃣ Intermediate — 1-2 years consistent\n4️⃣ Advanced — 2+ years serious lifting`;
  }

  // ---- LEGACY STATES — kept for existing users mid-onboarding ----
  // These handle clients who started onboarding before the 3-question rewrite

  // Legacy ASK_AGE — route into the new 3-question flow so stranded users converge.
  if (state === "ASK_WEIGHT_HEIGHT") {
    const lowerMsg = msg.toLowerCase().trim();
    const isFemale = user.gender === "female";

    // ── HEIGHT ESTIMATE PATH — user already gave weight, now picking height estimate ──
    // Triggered when they have weight saved but no height, and send short/average/tall/1/2/3
    if (user.currentWeight && !user.heightCm) {
      const shortH = isFemale ? 155 : 163;
      const avgH   = isFemale ? 163 : 172;
      const tallH  = isFemale ? 172 : 181;
      let estimatedCm = 0;
      if (/^\s*1\s*$/.test(msg) || /\b(short|shorter|petite|small)\b/i.test(lowerMsg)) estimatedCm = shortH;
      else if (/^\s*2\s*$/.test(msg) || /\b(average|avg|medium|normal|middle)\b/i.test(lowerMsg)) estimatedCm = avgH;
      else if (/^\s*3\s*$/.test(msg) || /\b(tall|taller|big|large|above)\b/i.test(lowerMsg)) estimatedCm = tallH;

      if (estimatedCm > 0) {
        const savedWeight = parseFloat(user.currentWeight);
        const hM = estimatedCm / 100;
        const bmi = Math.round((savedWeight / (hM * hM)) * 10) / 10;
        await db.update(users).set({
          heightCm: estimatedCm,
          bmi: bmi.toString(),
          onboardingState: "ASK_GOAL",
        }).where(eq(users.phoneNumber, phone));
        return `Using ~${estimatedCm}cm as an estimate — I'll adjust if you measure later.\n\nMain goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
      }
    }

    // ── "I DON'T KNOW MY HEIGHT" detection ──
    const heightUnknown = /\b(don.?t know|dont know|no idea|not sure|unknown|skip|idk|have no idea|can.?t remember|cannot remember|never measured)\b/i.test(lowerMsg)
      || (lowerMsg.includes("height") && /\b(no|not|don.?t|unsure)\b/i.test(lowerMsg));

    // ── Parse weight from message — prefer the kg-marked number so "172cm 78kg"
    // never reads 172 as the weight. And once weight is SAVED, an unmarked reply is
    // height-only (the estimate prompt says "type *1.72m* or *172cm*" — the old code
    // read "1.72m" as weight 1.72 and rejected it, and "172cm" as weight 172kg). ──
    const weightKgMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs)\b/i);
    const heightOnlyReply = !weightKgMatch && !!user.currentWeight;
    const weightMatch = weightKgMatch || (heightOnlyReply ? null : msg.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs)?/i));
    if (!weightMatch && !heightUnknown && !heightOnlyReply) return `Your weight and height. Example: *78kg, 1.72m*`;

    // If they said "don't know height" without giving weight yet, use saved weight or ask weight first
    if (heightUnknown && !weightMatch && !user.currentWeight) {
      return `No problem on height — I'll estimate it. What's your weight? Example: *78kg*`;
    }

    const weight = weightMatch ? parseFloat(weightMatch[1]) : parseFloat(user.currentWeight || "70");
    if (weight < 30 || weight > 300) return `That doesn't look right. Example: *78kg, 1.72m*`;

    // Parse height — multiple formats: 1.72m, 172cm, 5'8 — from the message WITHOUT
    // the weight portion. CAPTURE BUG (caught by onboarding-e2e, 2026-07-14): the old
    // ft-in regex matched ANY two adjacent digits, so "68kg" alone read as 6'8" and
    // silently stored height 203cm; "100kg" alone read as height 100cm. Garbage
    // height → garbage BMI → the Bonolo class of wrong targets, at the capture end.
    const msgSansWeight = weightMatch ? msg.replace(weightMatch[0], " ") : msg;
    const heightMMatch = msgSansWeight.match(/(\d+\.\d+)\s*m(?!g|i)/i);
    const heightCmMatch = msgSansWeight.match(/(\d{3})\s*(?:cm)?/i);
    const heightFtMatch = msgSansWeight.match(/(\d)\s*(?:['’`]|ft)\s*(\d{1,2})/i);
    let heightM = 0; let heightCmVal = 0;

    if (heightMMatch) {
      heightM = parseFloat(heightMMatch[1]);
      heightCmVal = Math.round(heightM * 100);
    } else if (heightCmMatch) {
      heightCmVal = parseInt(heightCmMatch[1]);
      heightM = heightCmVal / 100;
    } else if (heightFtMatch) {
      const ft = parseInt(heightFtMatch[1]);
      const inches = parseInt(heightFtMatch[2]);
      heightCmVal = Math.round((ft * 30.48) + (inches * 2.54));
      heightM = heightCmVal / 100;
    }

    // No height provided OR "don't know" — save weight and offer estimate options
    if (heightCmVal < 100 || heightCmVal > 230) {
      await db.update(users).set({ currentWeight: weight.toString() }).where(eq(users.phoneNumber, phone));
      const shortLabel = isFemale ? "Short (under 160cm)" : "Short (under 165cm)";
      const avgLabel   = isFemale ? "Average (163cm)"     : "Average (172cm)";
      const tallLabel  = isFemale ? "Tall (172cm+)"       : "Tall (181cm+)";
      return `Got it — ${weight}kg.\n\nWhat's your height? If you're not sure, pick the closest:\n\n1️⃣ ${shortLabel}\n2️⃣ ${avgLabel}\n3️⃣ ${tallLabel}\n\nOr type it: *1.72m* or *172cm*`;
    }

    const bmi = Math.round((weight / (heightM * heightM)) * 10) / 10;
    await db.update(users).set({
      currentWeight: weight.toString(),
      heightCm: heightCmVal,
      bmi: bmi.toString(),
      onboardingState: "ASK_GOAL",
    }).where(eq(users.phoneNumber, phone));
    return `${weight}kg, ${heightCmVal}cm — got it. Main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
  }

  if (state === "ASK_MEDICAL") {
    const lower = msg.toLowerCase();
    const isNone = lower.includes("none") || lower.includes("nothing") || msg.includes("6") || msg.includes("8");
    const conditions: string[] = [];
    if (msg.includes("1") || lower.includes("diab")) conditions.push("diabetes");
    if (msg.includes("2") || lower.includes("blood pressure") || lower.includes("hypert")) conditions.push("hypertension");
    if (msg.includes("3") || lower.includes("heart")) conditions.push("heart_condition");
    if (msg.includes("4") || lower.includes("hiv") || lower.includes("arv")) conditions.push("hiv_arvs");
    if (msg.includes("5") || lower.includes("pcos")) conditions.push("pcos");
    const hasDiabetes = conditions.includes("diabetes");
    const hasHeart = conditions.includes("heart_condition");
    const hasHIV = conditions.includes("hiv_arvs");
    const hasHighRiskCondition = hasHeart || hasDiabetes || hasHIV;
    await db.update(users).set({
      medicalConditions: conditions.length > 0 ? conditions.join(",") : "none",
      nutritionProtocol: hasDiabetes ? "LOW_GI" : null,
      mealTimingStrict: hasDiabetes,
      doctorClearanceRequired: hasHeart,
      onboardingState: "ASK_INJURIES",
    }).where(eq(users.phoneNumber, phone));

    // For heart, diabetes, and HIV/ARV users — explicit medical liability disclaimer
    // before proceeding. Coach K adjusts their programme but is not a substitute for
    // their treating doctor or dietitian.
    if (hasHighRiskCondition) {
      const conditionNames = conditions
        .filter(c => ["heart_condition", "diabetes", "hiv_arvs"].includes(c))
        .map(c => c === "heart_condition" ? "heart condition" : c === "hiv_arvs" ? "HIV/ARVs" : "diabetes")
        .join(" and ");
      return `Got it — ${conditionNames} noted.\n\n⚠️ *Medical note:* Coach K will adjust your programme and nutrition for your condition, but is not a substitute for your doctor or dietitian. Please make sure your doctor knows you are starting a new exercise and eating plan.\n\nCoach K will never tell you to stop or change your medication. If any recommendation conflicts with what your doctor told you — follow your doctor.\n\nAny injuries? Bad knees, back, shoulder? Or say None.`;
    }

    return `Any injuries? Bad knees, back, shoulder? Or say None.`;
  }

  if (state === "ASK_INJURIES") {
    const lower = msg.toLowerCase().trim();
    const isClearNone = lower === "none" || lower === "no" || lower === "n/a" || lower === "nil" || lower === "nope" || lower === "nothing";
    const injuries = isClearNone ? "" : msg;
    await db.update(users).set({ injuries, onboardingState: "ASK_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
    return `How do you want to train?[BUTTONS:Gym|Home|No equipment|Just walking]`;
  }

  // ---- ASK_FOODS — foods loved / hated (2026-07-12). Stored raw and light-split into
  // likes/dislikes; the grocery list uses dislikes so it never suggests a hated food. ----
  // ---- ASK_VISION — 3-month dream + biggest struggle in their words (2026-07-12). The
  // motivation anchor + how to coach them; fed to the brain so every reply knows their why.
  if (state === "ASK_EXPERIENCE") {
    const lower = msg.toLowerCase();
    let exp = "beginner";
    if (msg.includes("3") || lower.includes("intermediate")) exp = "intermediate";
    else if (msg.includes("4") || lower.includes("advanced")) exp = "advanced";

    await db.update(users).set({ trainingExperience: exp }).where(eq(users.phoneNumber, phone));

    if (user.weeklyFoodBudget) {
      // Fast-track path: budget was captured in ASK_BUDGET, complete now
      return completeOnboarding(phone, user, user.weeklyFoodBudget, user.budgetLevel || "medium", exp);
    }

    // Legacy path: budget not yet captured
    await db.update(users).set({ onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
    return `What's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
  }
  // Duplicate ASK_BUDGET handler removed — it was dead code shadowed by main handler at line ~606.

  // ---- ASK_WORK_SCHEDULE → COMPLETE ----
  return await getMenuText(user);
}

// ============================================================
// HELPER FUNCTIONS (used internally by getMenuText)
// ============================================================

function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

function getDayType(dowOverride?: number): "push" | "pull" | "legs" | "core" | "rest" {
  // Fixed weekly schedule: Mon=push, Tue=pull, Wed=legs, Thu=core, Fri=push, Sat=pull, Sun=rest
  const dow = dowOverride !== undefined ? dowOverride : new Date().getDay();
  const map: Array<"push" | "pull" | "legs" | "core" | "rest"> =
    ["rest", "push", "pull", "legs", "core", "push", "pull"];
  return map[dow];
}
