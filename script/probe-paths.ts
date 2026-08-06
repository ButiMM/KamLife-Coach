// PRODUCTION FLAGS (2026-08-06). Probing with ENGINE_LIVE unset over-reports: ~20 advice
// handlers stand down when the engine is live, and the engine IS live for every client. A wall
// that still appears with this on is a wall production can actually ship, which is the only
// list worth working from.
process.env.ENGINE_LIVE = process.env.ENGINE_LIVE || "on";
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";

const NOW = Date.now();
const BASE_USER = {
  id: "test-user-gauntlet", phoneNumber: "whatsapp:+27000000009", name: "Kam",
  onboardingState: "COMPLETE", subscriptionStatus: "active", popiConsent: true,
  popiConsentAt: new Date(NOW - 30 * 86_400_000), trialEndsAt: new Date(NOW + 30 * 86_400_000),
  subscriptionExpiresAt: new Date(NOW + 30 * 86_400_000), goalType: "fat_loss",
  calorieTarget: 1800, proteinTarget: 130, stepsTarget: 6000, currentWeight: "83",
  targetWeightKg: null, trainingMode: "gym", trainingDaysPerWeek: 3, trainingExperience: "beginner",
  programmePhase: 1, programmeWeek: 3, programmeDayInWeek: 2, weeklyFoodBudget: "100_300",
  lifeSituation: "office", gender: "male", age: 30, heightCm: 175, injuries: "none",
  medicalConditions: "none", awaitingInputType: null, todayCalories: 0, todayCaloriesDate: null,
  todaySteps: 0, todayWater: 0, workoutStreak: 2, totalWorkoutsCompleted: 8, buddyId: null,
  preferredLanguage: "en", profileNotes: "", homeEquipment: "none", gymName: null,
  lastActiveAt: new Date(NOW - 3_600_000), createdAt: new Date(NOW - 30 * 86_400_000),
};

const PROBES: Array<[string, string]> = [
  ["workout done", "I trained this morning"],
  ["workout done bare", "done"],
  ["lift log", "bench 80kg 3x10"],
  ["todays workout", "today's workout"],
  ["tomorrows session", "tomorrow's session"],
  ["my progress", "my progress"],
  ["progress cmd", "progress"],
  ["stats", "stats"],
  ["steps", "I did 5000 steps"],
  ["water", "2 glasses of water"],
  ["weight", "I weigh 82.5kg"],
  ["meal log", "I had pap and chicken"],
  ["sleep", "I slept 5 hours"],
  ["menu", "menu"],
  ["help", "help"],
  ["motivation", "I feel like giving up"],
  ["skip workout", "I dont want to train today"],
  ["rest day", "rest day"],
  ["my targets", "my targets"],
  ["change goal", "change my goal to muscle gain"],
  ["what to eat", "what should I eat for lunch"],
  ["water advice", "how much water should I drink"],
  ["injury", "my knee is sore"],
  ["sick", "I am sick"],
  ["streak", "streak"],
  ["referral", "referral"],
  ["billing", "how do I pay"],
  ["cancel", "how do I cancel"],
  ["train at home", "I train at home now"],
  ["mood", "I am stressed"],
  ["alcohol", "can I drink alcohol"],
  ["belly fat", "how do I lose belly fat"],
  ["plateau", "I am not losing weight"],
  ["supplements", "should I take creatine"],
  ["equipment", "what equipment do I need"],
  ["form", "how do I squat properly"],
  ["reminders", "remind me to drink water"],
  ["undo meal", "delete my last meal"],
  ["swap", "they didnt have chicken at the shop"],
  ["version", "version"],
];

function countSentences(text: string): number {
  const t = (text || "").trim();
  if (!t) return 0;
  return t.split(/\n+/).flatMap(l => l.split(/(?<=[.!?…])\s+/)).map(s => s.trim())
    .filter(s => s.replace(/[^\p{L}\p{N}]/gu, "").length > 0).length;
}

async function main() {
  const { handleMessage } = await import("../server/routes");
  const rows: Array<[string, number, number, string]> = [];
  const verbose = process.argv.includes("-v");
  for (const [name, msg] of PROBES) {
    (globalThis as any).__KAMLIFE_STUB_USER = { ...BASE_USER };
    let reply = "";
    try { reply = await handleMessage(BASE_USER.phoneNumber, msg); }
    catch (e: any) { reply = `THREW: ${e?.message}`; }
    const flags: string[] = [];
    if (countSentences(reply) > 3) flags.push("WALL");
    if (/\[BUTTONS:/i.test(reply)) flags.push("MENU");
    if (/^[ \t]*[•▸●○*-]\s+/m.test(reply)) flags.push("BULLETS");
    if (/\n\n---\n\n/.test(reply)) flags.push("MULTI");
    if (/THREW:/.test(reply)) flags.push("THREW");
    rows.push([name, reply.length, countSentences(reply), flags.join(",")]);
    if (verbose) {
      console.log(`\n=== ${name} | "${msg}" | ${reply.length}ch | ${countSentences(reply)}sent | ${flags.join(",") || "ok"}`);
      console.log(reply.slice(0, 600));
    }
  }
  console.log("\n──── SUMMARY (worst first) ────");
  for (const [name, len, sent, flags] of rows.sort((a, b) => b[2] - a[2])) {
    console.log(`${flags ? "🔴" : "  "} ${name.padEnd(20)} ${String(len).padStart(5)}ch ${String(sent).padStart(3)}sent  ${flags}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
