/**
 * DAY TRANSCRIPT — read the product the way a client reads it.
 *
 * (2026-07-29, founder: "we need to fix this thing… I don't know what to say to you.")
 *
 * Every defect in this product has been found the same way: the founder notices something in a
 * screenshot, sends it, we fix that one thing. That is a terrible way to find bugs — it only
 * surfaces what he happens to scroll past, it costs him his morning, and it makes a handful of
 * flaws feel like a collapsing system.
 *
 * This drives a REALISTIC DAY through the real pipeline and prints every reply in full, so the
 * whole conversation can be read at once instead of one bubble at a time. It asserts nothing.
 * Its only job is to put the product in front of eyes, cheaply, without a real client paying for
 * the privilege of being the test.
 *
 * Run: npx tsx script/day-transcript.ts
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

const PHONE = "+27820000777";

// A real client: 47, fat loss, four weeks in, logs by phone between other things.
(globalThis as any).__KAMLIFE_STUB_USER = {
  id: "transcript-user", phoneNumber: PHONE, name: "Thandi Mokoena",
  onboardingState: "COMPLETE", popiConsent: true, subscriptionStatus: "active",
  goalType: "fat_loss", calorieTarget: 1750, proteinTarget: 130, stepsTarget: 8000,
  currentWeight: "88.4", heightCm: 165, age: 47, gender: "female",
  trainingMode: "gym", trainingDaysPerWeek: 3, trainingExperience: "beginner",
  programmePhase: 1, totalWorkoutsCompleted: 9,
  dreamGoal: "Fit into my jeans again and keep up with my grandkids",
  biggestStruggle: "I get home late from work and I'm too tired to cook",
  createdAt: new Date(Date.now() - 28 * 86_400_000),
  betaBypassUntil: new Date(Date.now() + 30 * 86_400_000),
  profileNotes: "",
};

// The messages a real person actually sends — messy, short, mid-task.
const DAY: string[] = [
  "morning",
  "2 slices brown bread and peanut butter",
  "what should I do today",
  "im so tired today",
  "chicken and rice for lunch",
  "how am I doing",
  "can I have a coke",
  "today's workout",
  "did 8000 steps",
  "pap and chicken stew for dinner",
  "today's progress",
  "I don't think this is working for me",
];

const BAR = "═".repeat(78);

for (const [i, msg] of DAY.entries()) {
  let reply: string;
  try {
    reply = await handleMessage(PHONE, msg);
  } catch (e: any) {
    reply = `*** THREW: ${e?.message || e} ***`;
  }
  // Strip the media marker to a readable placeholder — the URL is noise when reading for tone.
  const shown = (reply || "(EMPTY REPLY)").replace(/\s*\[MEDIA:[^\]]+\]/g, "\n[card image]");
  console.log(`\n${BAR}\n[${String(i + 1).padStart(2, "0")}] CLIENT: ${msg}\n${"─".repeat(78)}\n${shown}`);
}

console.log(`\n${BAR}\nEnd of day. Read it as the client, not as the author.\n`);
