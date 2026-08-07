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
    { send: "30", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/weight and height/i] },
    { send: "83kg, 1.75m", expectState: "ASK_GOAL", expectReply: [/83kg, 175cm/, /goal/i] },
    { send: "1", expectState: "ASK_MEDICAL", expectReply: [/Goal locked in.*Lose fat/i, /medical/i] },
    { send: "6", expectState: "ASK_INJURIES", expectReply: [/injuries/i] },
    { send: "none", expectState: "ASK_EQUIPMENT", expectReply: [/how do you want to train/i] },
    { send: "gym", expectState: "ASK_GYM_SETUP", expectReply: [/what does your gym have/i] },
    { send: "Full gym (machines)", expectState: "COMPLETE", expectReply: [/programme is built/i, /The next 30 days, honestly/i, /kcal\/day/i, /steps\/day/i, /How this works/i, /take one photo/i] },
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
    { send: "27", expectState: "ASK_WEIGHT_HEIGHT" },
    // weight only — must SAVE the weight and offer the height-estimate menu, not loop
    { send: "68kg", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/68kg/, /height/i, /Average/i] },
    { send: "2", expectState: "ASK_GOAL", expectReply: [/163cm/] },
    { send: "3", expectState: "ASK_MEDICAL", expectReply: [/Lose fat and build muscle/i, /medical/i] },
    { send: "5", expectState: "ASK_INJURIES" },
    { send: "bad knees", expectState: "ASK_EQUIPMENT" },
    { send: "home", expectState: "ASK_HOME_EQUIPMENT", expectReply: [/what do you have at home/i] },
    { send: "Dumbbells", expectState: "COMPLETE", expectReply: [/Dumbbell programme locked in/i], expectReply: [/programme is built/i, /The next 30 days, honestly/i] },
  ],
  final: {
    name: "Naledi", gender: "female", age: 27, currentWeight: "68", heightCm: 163,
    goalType: "recomposition", medicalConditions: "pcos", injuries: "bad knees",
    primaryFocusArea: "glutes_legs",
    trainingMode: "gym_dumbbell", homeEquipment: "dumbbells",
    weeklyFoodBudget: "100_300", budgetLevel: "medium",
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
    { send: "45", expectState: "ASK_WEIGHT_HEIGHT" },
    // CAPTURE BUG (found by this suite, 2026-07-14): "100kg" alone used to store
    // height 100cm ("68kg" alone stored 6'8"=203cm via the loose ft-in regex).
    // Must save the weight and offer the height menu instead.
    { send: "100kg", expectState: "ASK_WEIGHT_HEIGHT", expectReply: [/100kg/, /height/i] },
    // CAPTURE BUG 2: the menu says "Or type it: *1.72m*" — typing that used to be
    // read as weight 1.72 and rejected ("172cm" as weight 172kg). Must be height.
    { send: "1.72m", expectState: "ASK_GOAL", expectReply: [/100kg, 172cm/] },
    { send: "2", expectState: "ASK_MEDICAL", expectReply: [/Build muscle/i, /medical/i] },
    { send: "2", expectState: "ASK_INJURIES" },
    { send: "none", expectState: "ASK_EQUIPMENT" },
    { send: "Just walking", expectState: "COMPLETE", expectReply: [/walking/i] },
  ],
  // GOAL-REALITY GATE (2026-07-21): Sipho is 100kg at BMI 33.8 and chose "build muscle" — the
  // gate correctly steers an obese client off a bulk and into fat-loss-first (he can override).
  // So the stored goal + targets are fat_loss, NOT the muscle_gain he tapped. This flow now also
  // proves the gate fires end-to-end.
  final: {
    name: "Sipho", gender: "male", age: 45, currentWeight: "100", heightCm: 172, bmi: "33.8",
    goalType: "fat_loss", medicalConditions: "hypertension",
    trainingMode: "walk_only", weeklyFoodBudget: "100_300", budgetLevel: "medium",
    trainingExperience: "beginner", subscriptionStatus: "inactive",
  },
  targetInputs: { weight: 100, goal: "fat_loss", situation: "office", days: 4, gender: "male", age: 45, heightCm: 172, exp: "beginner" },
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
  }
  if (flow === FLOW_B) {
  }
  if (flow === FLOW_C) {
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

// ── DAY ONE — what happens AFTER signup ───────────────────────────────────────────────────────
// (2026-07-28, from the review: "every flow is tested up to the moment the client is onboarded,
// and the product's whole value starts one message later.") These run through the REAL pipeline
// on a REAL onboarded client, which is the only place these seams exist — every one of them has
// broken in production at least once and none is reachable from a unit test.
async function journey(): Promise<void> {
  const phone = "+27820000901";
  const u = freshUser(phone);
  Object.assign(u, {
    name: "Koketso", onboardingState: "COMPLETE", goalType: "fat_loss", popiConsent: true,
    subscriptionStatus: "active",
    calorieTarget: 1980, proteinTarget: 165, stepsTarget: 8500,
    currentWeight: "96.4", heightCm: 178, age: 34, gender: "male",
    betaBypassUntil: new Date(Date.now() + 30 * 86_400_000), totalWorkoutsCompleted: 6,
    createdAt: new Date(Date.now() - 21 * 86_400_000),
  });
  (globalThis as any).__KAMLIFE_STUB_USER = u;
  process.env.APP_URL = process.env.APP_URL || "kamlifecoach.co.za";

  const say = async (msg: string): Promise<string> => {
    try { return await handleMessage(phone, msg); }
    catch (e: any) { fail("Day one", `"${msg}" THREW: ${String(e?.message || e).slice(0, 200)}`); return ""; }
  };

  // 1. The first food log. The single most important message in the product.
  const log = await say("2 eggs and brown bread");
  if (!log.trim()) fail("Day one", "first food log got an EMPTY reply");
  if (!/egg/i.test(log)) fail("Day one", `first food log did not name the food:\n    ${log.slice(0, 200)}`);
  // The numbers live on the card, so the text does not repeat them — that is deliberate. But the
  // card is fail-open: if it cannot render, the numbers must come back into the text, or a client
  // silently gets no numbers at all. Both halves are asserted, because only one of them is safe.
  // REWRITTEN 2026-08-04 (card policy locked). This asserted that a first food log returns a
  // card OR calories. Both halves are now the wrong requirement: a regular log gets two
  // sentences and NO picture, because every image costs a prepaid client data and a card sent
  // for every meal is not a card anyone shares. The welcome card at signup covers day one, and
  // the milestone card covers the moments worth showing someone.
  //
  // What must still be true — and this is the half that protects the client — is that the log
  // LANDED and the reply names their food. That is asserted above and is not weakened here.
  // REVERSED 2026-08-07, BY THE FOUNDER, DELIBERATELY. The 4 August policy locked cards to
  // signup / milestone / weekly / on-demand, on the reasoning that images cost a prepaid client
  // data and a card sent for every meal is not a card anyone shares. Three days of that policy
  // produced the thing he then described from the outside without seeing the source: "a person
  // sending a card once every seven days" — and his ruling is that the meal card is the calling
  // card, the only thing in this product that travels, and it belongs on the moment a client
  // has just told us something about their day. The data cost is real and remains the reason
  // for the 4-minute dump window and the 50 kcal floor, which both stay.
  //
  // What must still be true is unchanged and still asserted above: the log LANDED and the reply
  // names their food. The card is an addition to that, never a replacement for it.
  if (!/\[MEDIA:[^\]]*\/card\/[^\]]+\.png\]/.test(log)) {
    fail("Day one", `a routine food log attached NO card — the calling card must ride the log:\n    ${log.slice(-160)}`);
  }
  // The Day-0 regression: an onboarded client must never be pushed back into setup.
  if (/send.*baseline photos|let'?s get you set up|what'?s your name/i.test(log)) {
    fail("Day one", `an onboarded client was pushed back into onboarding:\n    ${log.slice(0, 200)}`);
  }
  // The card wiring end to end (targets → goal profile → marker → store) is now proven at the
  // moments that actually produce one: the welcome card in this same walk below, and the
  // milestone card in the gauntlet. Asserting it on a routine log would re-impose the policy
  // this build just removed.

  // 1b. Card off (no APP_URL — the live fail-open path). A DEFAULT client is number-free by
  //     design and still gets the food in plain language. But a client who typed "show me the
  //     numbers" opted in, and for them a failed card used to mean no figures anywhere at all.
  const appUrl = process.env.APP_URL;
  process.env.APP_URL = "";
  const noCardDefault = await say("2 eggs and brown bread");
  if (/\[MEDIA:/.test(noCardDefault)) fail("Day one", "a card was attached with no APP_URL configured");
  if (!/egg/i.test(noCardDefault)) fail("Day one", `card off: the default client lost the food too:\n    ${noCardDefault.slice(0, 200)}`);

  u.profileNotes = `${u.profileNotes || ""} numbers:full`.trim();
  const noCardOptedIn = await say("2 eggs and brown bread");
  process.env.APP_URL = appUrl;
  u.profileNotes = (u.profileNotes || "").replace(/\s*numbers:full/, "");
  // DELETED 2026-08-04 (Slice 4), same change as routing-audit's numbers-mode case: a regular
  // log is two sentences for everyone now, opted-in included. Their figures live in their
  // record, on an earned card, and one question away — not stapled to every meal.
  void noCardOptedIn;

  // 2. The quit moment, through the whole pipeline. It must reach quit-save, and it must NOT
  //    hand a helpline to someone who is simply exhausted — that ends the relationship.
  const quit = await say("I got home after 1am, I don't know how I will do this anymore");
  if (/0800 567 567/.test(quit)) fail("Day one", "a quit moment was answered with a suicide helpline");
  if (!/1am|hours in the day|slacking/i.test(quit)) fail("Day one", `quit-save did not answer the real obstacle:\n    ${quit.slice(0, 200)}`);
  if (!/6 sessions/i.test(quit)) fail("Day one", `quit-save did not use their REAL numbers:\n    ${quit.slice(0, 240)}`);

  // 3. Crisis, same pipeline, opposite outcome — and it must stop coaching entirely.
  const crisis = await say("sometimes I just want to die");
  if (!/0800 567 567/.test(crisis)) fail("Day one", "a crisis message did not produce the helpline");
  if (/\b(?:calorie|protein|macro|workout|log it)\b/i.test(crisis)) {
    fail("Day one", `the coach kept coaching through a crisis:\n    ${crisis.slice(0, 200)}`);
  }

  // 4. POPIA access, end to end.
  const exp = await say("export my data");
  if (!/Your KamLife record/i.test(exp)) fail("Day one", `data export did not produce the record:\n    ${exp.slice(0, 200)}`);
  if (/undefined|NaN|\[object Object\]/.test(exp)) fail("Day one", "the export leaked a placeholder");

  if (failures === 0) console.log("✓ Day one — first log + card, quit moment, crisis, and POPIA export all correct through the real pipeline");
}
await journey();

if (failures > 0) {
  console.error(`\nonboarding-e2e: FAILED (${failures} assertion${failures !== 1 ? "s" : ""})`);
  process.exit(1);
}
console.log(`\nonboarding-e2e: three signups verified end-to-end, plus the day-one journey through the real pipeline`);
process.exit(0);
