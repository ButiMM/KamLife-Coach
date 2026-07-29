/**
 * REPLY QUALITY GATE — the build fails before a client sees it.
 *
 * (2026-07-29, founder: "we literally ran into the same problem twice in one night. You fixed it.
 * We ran into it again. You fixed it. We ran into it again.")
 *
 * He is right, and the reason is structural. The defect scanner in server/audit/reply-defects.ts
 * only ever ran against PRODUCTION history — which means every defect it can catch has already
 * been read by a paying client, and usually screenshotted by the founder at 2am. Fixing them one
 * call site at a time is not a process, it is a treadmill.
 *
 * This runs the SAME detectors against replies the product generates right now, before anything
 * ships. A defect found here costs nothing. The same defect found in production costs a client.
 *
 * It is not a unit test with hand-written expectations — those only ever check the case someone
 * thought of. It drives real messages through the real pipeline and asks one question of every
 * reply that comes back: would the auditor flag this?
 *
 * Run: npx tsx script/reply-quality-gate.ts   (wired into `npm test`)
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.APP_URL = process.env.APP_URL || "kamlifecoach.co.za";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

const { handleMessage } = await import("../server/routes");
const { scanReply } = await import("../server/audit/reply-defects");

const PHONE = "+27820000888";

function client(over: Record<string, unknown> = {}) {
  return {
    id: "gate-user", phoneNumber: PHONE, name: "Thandi Mokoena",
    onboardingState: "COMPLETE", popiConsent: true, subscriptionStatus: "active",
    goalType: "fat_loss", calorieTarget: 1750, proteinTarget: 130, stepsTarget: 8000,
    currentWeight: "88.4", heightCm: 165, age: 47, gender: "female",
    trainingMode: "gym", trainingDaysPerWeek: 3, trainingExperience: "beginner",
    programmePhase: 1, totalWorkoutsCompleted: 9,
    dreamGoal: "Fit into my jeans again and keep up with my grandkids",
    biggestStruggle: "I get home late from work and I'm too tired to cook",
    createdAt: new Date(Date.now() - 28 * 86_400_000),
    betaBypassUntil: new Date(Date.now() + 30 * 86_400_000),
    profileNotes: "", ...over,
  };
}

/** The messages real people send, across the goals the product supports. */
const CASES: Array<{ user: Record<string, unknown>; msgs: string[] }> = [
  {
    user: {},
    msgs: [
      "morning", "2 slices brown bread and peanut butter", "chicken and rice for lunch",
      "pap and chicken stew for dinner", "today's progress", "how am I doing",
      "what should I do today", "did 8000 steps", "today's workout",
    ],
  },
  {
    user: { goalType: "muscle_gain", calorieTarget: 2860, proteinTarget: 185, profileNotes: "numbers:full" },
    msgs: ["beef mince and bacon", "today's progress", "what should I do today", "morning"],
  },
  {
    user: { goalType: "general", calorieTarget: 0, proteinTarget: 0, name: "Gogo Nomsa" },
    msgs: ["I had pap and morogo", "how am I doing", "morning"],
  },
];

let checked = 0;
const failures: string[] = [];

for (const c of CASES) {
  (globalThis as any).__KAMLIFE_STUB_USER = client(c.user);
  for (const msg of c.msgs) {
    let out = "";
    try {
      out = await handleMessage(PHONE, msg);
    } catch (e: any) {
      failures.push(`  ✗ "${msg}" THREW: ${String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    checked++;
    if (!out.trim()) { failures.push(`  ✗ "${msg}" → EMPTY REPLY`); continue; }

    for (const d of scanReply({ messageIn: msg, messageOut: out })) {
      // The coverage counter is information, not a defect — it fires when the coach correctly
      // says it could not price something.
      if (d.code === "food-not-in-database") continue;
      failures.push(`  ✗ [${d.code}] on "${msg}"\n      ${d.detail}\n      reply: ${out.replace(/\n/g, " ").slice(0, 150)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`reply quality gate: FAILED — ${failures.length} defect(s) in ${checked} generated replies:\n`);
  console.error(failures.join("\n\n"));
  console.error("\nThese are the same detectors that scan production. Fix them here, where it is free.");
  process.exit(1);
}

console.log(`reply quality gate: ${checked} generated replies, zero defects ✓`);
