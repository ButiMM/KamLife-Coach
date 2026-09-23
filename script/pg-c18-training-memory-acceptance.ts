/** C18: saved equipment, experience, injury and diet reach the delivered programme command. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-training-memory-acceptance: SKIPPED — real PostgreSQL required");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const RealDate = Date;
const fixed = RealDate.UTC(2026, 8, 18, 8, 0); // 10:00 SAST
class FrozenDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length ? args : [fixed]) as [any]); }
  static now() { return fixed; }
}
(globalThis as any).Date = FrozenDate;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};
const { db, pool } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { getKamlifeProgramme } = await import("../server/programme");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const ids: string[] = [];
async function turn(label: "home" | "gym") {
  const home = label === "home";
  const phone = `whatsapp:+2791900${home ? "0281" : "0282"}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: home ? "Nandi Home" : "Sipho Gym",
    onboardingState: "COMPLETE", subscriptionStatus: "active", popiConsent: true,
    popiConsentAt: new RealDate(fixed - 20 * 86_400_000), goalType: "fat_loss",
    currentWeight: "84", heightCm: 170, age: 32, gender: home ? "female" : "male",
    trainingMode: label, trainingExperience: home ? "beginner" : "intermediate",
    injuries: home ? "knee" : "none", dietaryRestrictions: home ? "vegan" : null,
    trainingDaysPerWeek: 3, programmeWeek: 1, programmeDayInWeek: 1,
    calorieTarget: 2000, proteinTarget: 130, stepsTarget: 8000,
  } as any).returning();
  ids.push(u.id);
  chk(u.trainingMode === label && u.injuries === (home ? "knee" : "none")
      && u.trainingExperience === (home ? "beginner" : "intermediate"),
    `${label}: durable onboarding constraints exist before the turn`,
    JSON.stringify({ mode: u.trainingMode, experience: u.trainingExperience, injury: u.injuries }));
  const canonical = getKamlifeProgramme(u);
  _resetOutboundDedupe();
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await processTextAsync(phone, "my programme", null, null, [], handleMessage as any, `sid-c18-training-${label}`);
  const { rows } = await pool.query<{ body: string }>(
    "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone]);
  return { canonical, body: rows.map(r => r.body).join("\n"), user: u };
}

REAL("\npg-c18-training-memory-acceptance — saved constraints → programme owner → post-send body\n");
const home = await turn("home");
const gym = await turn("gym");
const unsafeExercise = /^\d+\.\s+\*?(?:Squat|Reverse Lunge)\b/im;
const animal = /\b(?:eggs|chicken|pilchards)\b/i;
chk(/Skipped \(injury\)/i.test(home.canonical) && !unsafeExercise.test(home.canonical)
    && !animal.test(home.canonical),
  "the canonical home programme filters knee-loaded moves and incompatible food", home.canonical.slice(0, 250));
chk(home.body.length > 0 && /Skipped \(injury\)/i.test(home.body)
    && !unsafeExercise.test(home.body) && !animal.test(home.body),
  "the filtered home instruction survives the final transport body", home.body.slice(0, 350));
chk(home.canonical !== gym.canonical && home.body !== gym.body,
  "the home beginner and unrestricted gym client receive materially different sessions");
chk(!/Note on your knee injury/i.test(home.body),
  "the verifier does not contradict a session whose knee moves were skipped", home.body.slice(-300));

REAL(`\npg-c18-training-memory-acceptance: ${failed ? `${failed} FAILED` : "GREEN"}\n`);
for (const id of ids) await pool.query("DELETE FROM users WHERE id = $1", [id]);
await pool.end();
(globalThis as any).Date = RealDate;
process.exit(failed ? 1 : 0);
