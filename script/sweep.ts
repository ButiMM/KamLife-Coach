/**
 * SWEEP — every kind of message a real client sends, through the real pipeline, printed.
 *
 * (2026-07-29, founder: "this is a problem all around, we can't put people on this.")
 *
 * day-transcript.ts walks ONE client through ONE good day. The reply-quality-gate runs the
 * eleven known defect detectors. Neither answers the question actually being asked, which is
 * "is this thing fit to put in front of a stranger" — because the failures that frighten a
 * founder are tone, length, weirdness and non-answers, and no detector catches those.
 *
 * This is deliberately wide instead of deep: the awkward messages, the one-word replies, the
 * complaints, the money questions, the things people type at 11pm. It asserts nothing. It exists
 * so the whole surface can be READ in one pass rather than discovered one screenshot at a time.
 *
 * Run: npx tsx script/sweep.ts [filter]
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

const PHONE = "+27820000444";
(globalThis as any).__KAMLIFE_STUB_USER = {
  id: "sweep-user", phoneNumber: PHONE, name: "Thandi Mokoena",
  onboardingState: "COMPLETE", popiConsent: true, subscriptionStatus: "active",
  goalType: "fat_loss", calorieTarget: 1750, proteinTarget: 130, stepsTarget: 8000,
  currentWeight: "88.4", heightCm: 165, age: 47, gender: "female",
  trainingMode: "gym", trainingDaysPerWeek: 3, trainingExperience: "beginner",
  programmePhase: 1, totalWorkoutsCompleted: 9, profileNotes: "",
  dreamGoal: "Fit into my jeans again and keep up with my grandkids",
  biggestStruggle: "I get home late from work and I'm too tired to cook",
  createdAt: new Date(Date.now() - 28 * 86_400_000),
  betaBypassUntil: new Date(Date.now() + 30 * 86_400_000),
};

/** Grouped so a bad AREA is obvious, not just a bad message. */
const GROUPS: Array<[string, string[]]> = [
  ["ONE-WORD AND REACTIONS", ["ok", "thanks", "👍", "cool", "yes", "no", "🙏", "lol"]],
  ["CONFUSION AND NOT UNDERSTANDING", [
    "I don't understand", "what does that mean", "huh?", "what?",
    "I don't know what any of this means", "explain that again please",
  ]],
  ["TIREDNESS AND LIFE", [
    "im so tired today", "I had a long day", "work was crazy today",
    "I'm too tired to cook", "I didn't sleep", "I'm stressed",
  ]],
  ["FOOD QUESTIONS", [
    "can I have a coke", "can I eat bread", "is rice bad for me",
    "what can I eat tonight", "what should I buy at the shop", "I'm hungry",
  ]],
  ["TRAINING QUESTIONS", [
    "my knee hurts", "I can't do squats", "how many days should I train",
    "I missed my workout", "do I have to go to gym today", "I have no gym",
  ]],
  ["PROGRESS AND DOUBT", [
    "I'm not losing weight", "this isn't working", "I gained weight",
    "how long until I see results", "am I doing this right",
  ]],
  ["MONEY AND ACCOUNT", [
    "how much does this cost", "I want to cancel", "can I pause",
    "how do I pay", "is there a free trial",
  ]],
  ["VENTING AND FRUSTRATION", [
    "this is useless", "you're not listening to me", "I already told you that",
    "why do you keep repeating yourself", "I give up",
  ]],
  ["MESSY REAL TYPING", [
    "2 slice brown bred n peanut buta", "ate pap n chicken 4 dinner",
    "did 8k steps 2day", "weight is 87.2kg 2day",
  ]],
];

const BAR = "═".repeat(78);
const filter = (process.argv[2] || "").toLowerCase();

for (const [group, msgs] of GROUPS) {
  if (filter && !group.toLowerCase().includes(filter)) continue;
  console.log(`\n\n${BAR}\n${group}\n${BAR}`);
  for (const msg of msgs) {
    let reply: string;
    try {
      reply = await handleMessage(PHONE, msg);
    } catch (e: any) {
      reply = `*** THREW: ${e?.message || e} ***`;
    }
    const shown = (reply || "*** EMPTY REPLY ***").replace(/\s*\[MEDIA:[^\]]+\]/g, " [card]");
    const words = shown.split(/\s+/).filter(Boolean).length;
    console.log(`\n──────────────────────────────────────────────────────────────────────────────`);
    console.log(`CLIENT: ${msg}`);
    console.log(`COACH (${words} words):`);
    console.log(shown);
  }
}

console.log(`\n${BAR}\nRead it as the client, not the author.\n`);
process.exit(0);
