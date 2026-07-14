/**
 * ONBOARDING E2E — box two of the stabilization contract.
 *
 * Drives a complete scripted signup conversation through the REAL handleMessage
 * pipeline (real FSM, real parsers, real completeOnboarding) with the stateful
 * DB stub, for BOTH flows:
 *
 *   Flow A — standard male gym signup, weight+height typed directly
 *   Flow B — female home signup: glutes focus, postpartum question, height
 *            ESTIMATE path (weight without height → pick from menu), vegan,
 *            dumbbells at home
 *
 * After every turn the resulting onboardingState is asserted (a wrong
 * transition fails at the exact step), and at COMPLETE every captured field is
 * asserted against what was typed — plus the stored calorie/protein/steps
 * targets are recomputed from the SAME formula completeOnboarding uses. This
 * is the net for the Bonolo class of bug: profile data missing/wrong at
 * computation time producing dangerous targets.
 *
 * Offline by design (KAMLIFE_DB_STUB=1, no OpenAI key needed — the scripted
 * answers only touch deterministic FSM states).
 *
 * Run: npm run test:onboarding
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

const { handleMessage } = await import("../server/routes");
const { calculateTargets, calculateStepsTarget } = await import("../server/targets");

type Turn = {
  send: string;
  /** onboardingState expected AFTER this message is handled */
  expectState: string;
  /** optional patterns the reply must contain */
  expectReply?: RegExp[];
};

type Flow = {
  name: string;
  phone: string;
  turns: Turn[];
  /** field assertions against the stub user once COMPLETE */
  final: Record<string, any>;
  /** the exact calculateTargets/calculateStepsTarget inputs completeOnboarding must have used */
  targetInputs: { weight: number; goal: string; situation: string; days: number; gender: string; age: number; heightCm: number; exp: string };
};

function freshUser(phone: string) {
  return {
    id: "e2e-" + phone.slice(-4),
    phoneNumber: phone,
    name: null,
    onboardingState: "START",
    popiConsent: false,
    subscriptionStatus: "inactive",
    profileNotes: "",
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
}

const FLOW_A: Flow = {
  name: "Flow A — male, gym, weight+height typed",
  phone: "whatsapp:+27000000101",
  turns: [
    { send: "hi", expectState: "ASK_POPIA", expectReply: [/POPIA|consent|Reply \*yes\*/i] },
    { send: "yes", expectState: "WELCOME", expectReply: [/name/i] },
    { send: "Thabo", expectState: "ASK_GENDER", expectReply: [/male or female/i] },
    { send: "male", expectState: "ASK_AGE_NEW", expectReply: [/old/i] },
    { send: "30", expectState: "ASK_EMAIL", expectReply: [/email/i] },
    { send: "skip", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/weight and height/i] },
    { send: "83kg, 1.75m", expectState: "ASK_GOAL", expectReply: [/83kg, 175cm/, /goal/i] },
    { send: "1", expectState: "ASK_MEDICAL", expectReply: [/Goal locked in.*Lose fat/i, /medical/i] },
    { send: "6", expectState: "ASK_INJURIES", expectReply: [/injuries/i] },
    { send: "none", expectState: "ASK_DIETARY", expectReply: [/dietary/i] },
    { send: "1", expectState: "ASK_FOODS", expectReply: [/foods you \*love\*/i] },
    { send: "Love pap, chicken and eggs — can't stand broccoli", expectState: "ASK_VISION", expectReply: [/dream/i] },
    { send: "Lose my belly and keep my muscle. I struggle with snacking at night.", expectState: "ASK_EQUIPMENT", expectReply: [/how do you want to train/i] },
    { send: "gym", expectState: "ASK_GYM_SETUP", expectReply: [/what does your gym have/i] },
    { send: "Full gym (machines)", expectState: "ASK_BUDGET", expectReply: [/budget/i] },
    { send: "2", expectState: "ASK_EXPERIENCE", expectReply: [/experience/i] },
    { send: "1", expectState: "COMPLETE", expectReply: [/programme is built/i, /The next 30 days, honestly/i, /kcal\/day/i, /steps\/day/i] },
  ],
  final: {
    name: "Thabo", gender: "male", age: 30, currentWeight: "83", heightCm: 175, bmi: "27.1",
    goalType: "fat_loss", medicalConditions: "none", injuries: "",
    trainingMode: "gym", weeklyFoodBudget: "100_300", budgetLevel: "medium",
    trainingExperience: "beginner", subscriptionStatus: "inactive",
    programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1,
  },
  targetInputs: { weight: 83, goal: "fat_loss", situation: "office", days: 4, gender: "male", age: 30, heightCm: 175, exp: "beginner" },
};

const FLOW_B: Flow = {
  name: "Flow B — female, home dumbbells, height-estimate path, vegan",
  phone: "whatsapp:+27000000102",
  turns: [
    { send: "hello", expectState: "ASK_POPIA" },
    { send: "I agree", expectState: "WELCOME" },
    { send: "Naledi", expectState: "ASK_GENDER" },
    { send: "female", expectState: "ASK_FEMALE_FOCUS", expectReply: [/training focus/i] },
    { send: "2", expectState: "ASK_POSTPARTUM", expectReply: [/pregnant|postpartum|breastfeeding/i] },
    { send: "2", expectState: "ASK_AGE_NEW" },
    { send: "27", expectState: "ASK_EMAIL" },
    { send: "naledi@example.com", expectState: "ASK_WEIGHT_HEIGHT" },
    // weight only — must SAVE the weight and offer the height-estimate menu, not loop
    { send: "68kg", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/68kg/, /height/i, /Average/i] },
    { send: "2", expectState: "ASK_GOAL", expectReply: [/163cm/] },
    { send: "3", expectState: "ASK_MEDICAL", expectReply: [/Lose fat and build muscle/i] },
    { send: "5", expectState: "ASK_INJURIES" },
    { send: "bad knees", expectState: "ASK_DIETARY" },
    { send: "4", expectState: "ASK_FOODS" },
    { send: "skip", expectState: "ASK_VISION" },
    { send: "Fit into my old jeans again. I struggle with consistency on weekends.", expectState: "ASK_EQUIPMENT" },
    { send: "home", expectState: "ASK_HOME_EQUIPMENT", expectReply: [/what do you have at home/i] },
    { send: "Dumbbells", expectState: "ASK_BUDGET", expectReply: [/Dumbbell programme locked in/i] },
    { send: "1", expectState: "ASK_EXPERIENCE" },
    { send: "2", expectState: "COMPLETE", expectReply: [/programme is built/i, /The next 30 days, honestly/i] },
  ],
  final: {
    name: "Naledi", gender: "female", age: 27, currentWeight: "68", heightCm: 163,
    goalType: "recomposition", medicalConditions: "pcos", injuries: "bad knees",
    primaryFocusArea: "glutes_legs",
    trainingMode: "gym_dumbbell", homeEquipment: "dumbbells",
    weeklyFoodBudget: "under_100", budgetLevel: "low",
    trainingExperience: "beginner", subscriptionStatus: "inactive",
  },
  targetInputs: { weight: 68, goal: "recomposition", situation: "office", days: 4, gender: "female", age: 27, heightCm: 163, exp: "beginner" },
};

const FLOW_C: Flow = {
  name: "Flow C — walk-only, weight typed alone then height typed (capture-bug regression)",
  phone: "whatsapp:+27000000103",
  turns: [
    { send: "hi", expectState: "ASK_POPIA" },
    { send: "yes", expectState: "WELCOME" },
    { send: "Sipho", expectState: "ASK_GENDER" },
    { send: "male", expectState: "ASK_AGE_NEW" },
    { send: "45", expectState: "ASK_EMAIL" },
    { send: "skip", expectState: "ASK_WEIGHT_HEIGHT" },
    // CAPTURE BUG (found by this suite, 2026-07-14): "100kg" alone used to store
    // height 100cm ("68kg" alone stored 6'8"=203cm via the loose ft-in regex).
    // Must save the weight and offer the height menu instead.
    { send: "100kg", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/100kg/, /height/i] },
    // CAPTURE BUG 2: the menu says "Or type it: *1.72m*" — typing that used to be
    // read as weight 1.72 and rejected ("172cm" as weight 172kg). Must be height.
    { send: "1.72m", expectState: "ASK_GOAL", expectReply: [/100kg, 172cm/] },
    { send: "2", expectState: "ASK_MEDICAL", expectReply: [/Build muscle/i] },
    { send: "2", expectState: "ASK_INJURIES" },
    { send: "none", expectState: "ASK_DIETARY" },
    { send: "2", expectState: "ASK_FOODS" },
    { send: "skip", expectState: "ASK_VISION" },
    { send: "Get stronger without a gym. I struggle with time.", expectState: "ASK_EQUIPMENT" },
    { send: "Just walking", expectState: "ASK_BUDGET", expectReply: [/walking/i] },
    { send: "4", expectState: "ASK_EXPERIENCE" },
    { send: "4", expectState: "COMPLETE" },
  ],
  final: {
    name: "Sipho", gender: "male", age: 45, currentWeight: "100", heightCm: 172, bmi: "33.8",
    goalType: "muscle_gain", medicalConditions: "hypertension",
    trainingMode: "walk_only", weeklyFoodBudget: "over_600", budgetLevel: "premium",
    trainingExperience: "advanced", subscriptionStatus: "inactive",
  },
  targetInputs: { weight: 100, goal: "muscle_gain", situation: "office", days: 4, gender: "male", age: 45, heightCm: 172, exp: "advanced" },
};

let failures = 0;
function fail(flow: string, what: string): void {
  failures++;
  console.error(`✗ ${flow} — ${what}`);
}

async function runFlow(flow: Flow): Promise<void> {
  (globalThis as any).__KAMLIFE_STUB_USER = freshUser(flow.phone);
  const stub = () => (globalThis as any).__KAMLIFE_STUB_USER;

  for (const [i, t] of flow.turns.entries()) {
    let reply = "";
    try {
      reply = await handleMessage(flow.phone, t.send);
    } catch (e: any) {
      fail(flow.name, `turn ${i + 1} (${JSON.stringify(t.send)}) THREW: ${String(e?.message || e).slice(0, 200)}`);
      return;
    }
    if (!reply || !reply.trim()) {
      fail(flow.name, `turn ${i + 1} (${JSON.stringify(t.send)}) got an EMPTY reply — silent onboarding death`);
      return;
    }
    const gotState = stub().onboardingState;
    if (gotState !== t.expectState) {
      fail(flow.name, `turn ${i + 1} (${JSON.stringify(t.send)}): state ${gotState}, expected ${t.expectState}\n    reply: ${JSON.stringify(reply.slice(0, 160))}`);
      return;
    }
    for (const re of t.expectReply || []) {
      if (!re.test(reply)) fail(flow.name, `turn ${i + 1} (${JSON.stringify(t.send)}): reply missing ${re}\n    reply: ${JSON.stringify(reply.slice(0, 200))}`);
    }
  }

  // ── Field capture assertions ──
  const u = stub();
  for (const [k, want] of Object.entries(flow.final)) {
    const got = u[k];
    if (got !== want) fail(flow.name, `field ${k}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  // Free-text intake must have landed as non-empty strings
  if (flow === FLOW_A) {
    if (!u.foodDislikes || !/broccoli/i.test(u.foodDislikes)) fail(flow.name, `foodDislikes should mention broccoli, got ${JSON.stringify(u.foodDislikes)}`);
    if (!u.foodLikes) fail(flow.name, `foodLikes should be captured, got ${JSON.stringify(u.foodLikes)}`);
    if (!u.dreamGoal) fail(flow.name, `dreamGoal should be captured`);
    if (!u.biggestStruggle) fail(flow.name, `biggestStruggle should be captured`);
  }
  if (flow === FLOW_B) {
    if (!/diet:vegan/.test(u.profileNotes || "")) fail(flow.name, `profileNotes should carry diet:vegan, got ${JSON.stringify(u.profileNotes)}`);
  }
  if (flow === FLOW_C) {
    if (!/diet:halal/.test(u.profileNotes || "")) fail(flow.name, `profileNotes should carry diet:halal, got ${JSON.stringify(u.profileNotes)}`);
    if (!/walk:lifestyle/.test(u.profileNotes || "")) fail(flow.name, `profileNotes should carry walk:lifestyle, got ${JSON.stringify(u.profileNotes)}`);
  }
  // betaBypassUntil is set (non-null) to mark "onboarded" and close the restart
  // exploit — even under pay-to-start (where it's set to now, i.e. no free window).
  if (!u.betaBypassUntil) fail(flow.name, `betaBypassUntil should be set (marks onboarded)`);

  // ── Target formula assertions — the Bonolo net at the CAPTURE end ──
  const ti = flow.targetInputs;
  const expected = calculateTargets(ti.weight, ti.goal, ti.situation, ti.days, ti.gender, ti.age, ti.heightCm, ti.exp);
  if (u.calorieTarget !== expected.calorieTarget) {
    fail(flow.name, `calorieTarget: stored ${u.calorieTarget}, formula says ${expected.calorieTarget} for this exact profile`);
  }
  if (u.proteinTarget !== expected.proteinTarget) {
    fail(flow.name, `proteinTarget: stored ${u.proteinTarget}, formula says ${expected.proteinTarget}`);
  }
  const expectedSteps = calculateStepsTarget(ti.weight, ti.age, ti.heightCm, ti.exp, ti.goal);
  if (u.stepsTarget !== expectedSteps) {
    fail(flow.name, `stepsTarget: stored ${u.stepsTarget}, formula says ${expectedSteps}`);
  }
  console.log(`✓ ${flow.name} — ${flow.turns.length} turns, all fields + targets verified (${u.calorieTarget} kcal / ${u.proteinTarget}g / ${u.stepsTarget} steps)`);
}

await runFlow(FLOW_A);
await runFlow(FLOW_B);
await runFlow(FLOW_C);

if (failures > 0) {
  console.error(`\nonboarding-e2e: FAILED (${failures} assertion${failures !== 1 ? "s" : ""})`);
  process.exit(1);
}
console.log(`\nonboarding-e2e: both flows signed up end-to-end with verified data capture and formula-exact targets`);
process.exit(0);
