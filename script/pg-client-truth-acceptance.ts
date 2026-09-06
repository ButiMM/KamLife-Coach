/**
 * REAL-POSTGRESQL ACCEPTANCE — canonical client truth.
 *
 * The contract depends on row locks, transaction ordering, unique source IDs and conditional
 * upserts. The deterministic DB stub cannot prove any of those, so this suite runs only in the
 * ephemeral PostgreSQL CI service after committed migrations have been applied.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-client-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}

process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { and, eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { recordClientFacts } = await import("../server/memory");
const { seedUnderstanding } = await import("../server/understanding/seed");
const { loadUnderstanding, saveUnderstanding } = await import("../server/understanding/store");

let failed = 0;
const check = (ok: unknown, description: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${description}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = `whatsapp:+2796${String(Math.floor(Math.random() * 900000) + 100000)}`;
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone,
  name: "Truth Client",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active",
  popiConsent: true,
  popiConsentAt: new Date(),
  goalType: "fat_loss",
  calorieTarget: 2200,
  proteinTarget: 140,
  stepsTarget: 8000,
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  createdAt: new Date(),
  lastActiveAt: new Date(),
} as any).returning();

const readUser = async () => (await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1))[0];
const readCommits = async () => db.select().from(schema.clientTruthCommits)
  .where(eq(schema.clientTruthCommits.userId, user.id))
  .orderBy(schema.clientTruthCommits.revision);

REAL("\n=== CANONICAL CLIENT TRUTH ===");

// §1 THE REAL FRONT DOOR: current-turn evidence must commit before any handler owns the turn.
const frontDoorReply = await handleMessage(
  phone,
  "my knee has been killing me since Saturday and I had chicken and pap",
  undefined, undefined, undefined,
  "SM-TRUTH-FRONT",
);
let current = await readUser();
check(current.injuries === "knee", "raw mixed-intent input committed the injury through the real front door", String(current.injuries));
check(Number(current.truthRevision) === 1, "the first accepted turn advanced revision exactly once", String(current.truthRevision));
check(String(frontDoorReply || "").trim().length > 0, "the same turn still produced a client reply");

// §2 TWO STALE CALLERS: both begin with the same row, but the lock/re-read must preserve both.
const stale = { ...current };
await Promise.all([
  recordClientFacts(stale, "I hurt my shoulder yesterday", "SM-TRUTH-A"),
  recordClientFacts(stale, "I injured my ankle yesterday", "SM-TRUTH-B"),
]);
current = await readUser();
const injurySet = new Set(String(current.injuries || "").split(",").map((s: string) => s.trim()));
check(["knee", "shoulder", "ankle"].every(x => injurySet.has(x)),
  "concurrent fact commits preserve every injury", String(current.injuries));
check(Number(current.truthRevision) === 3, "two concurrent changes receive distinct ordered revisions", String(current.truthRevision));

// §3 SOURCE IDEMPOTENCY: retrying the exact provider message cannot mutate or append evidence.
const beforeRetry = JSON.stringify(await readCommits());
await recordClientFacts(stale, "I injured my back yesterday", "SM-TRUTH-A");
current = await readUser();
check(!String(current.injuries || "").includes("back"), "a reused provider source ID is applied once");
check(JSON.stringify(await readCommits()) === beforeRetry, "a provider retry adds no second evidence commit");

// §4 BOUNDARIES ARE INDEPENDENT: a later boundary cannot silently revoke the earlier one.
await recordClientFacts(current, "please don't mention my weight", "SM-TRUTH-C");
current = await readUser();
await recordClientFacts(current, "please don't mention my ex", "SM-TRUTH-D");
current = await readUser();
check(/weight/i.test(current.doNotMention || "") && /\bex\b/i.test(current.doNotMention || ""),
  "two prohibited topics remain active together", String(current.doNotMention));

const commits = await readCommits();
check(commits.length === 5, "one append-only evidence commit exists per effective source mutation", String(commits.length));
check(commits.map(c => c.revision).join(",") === "1,2,3,4,5", "fact revisions have no duplicates or gaps",
  commits.map(c => c.revision).join(","));
check((commits[1].operations as any[])[0]?.previousValue != null,
  "evidence retains the previous projection value for correction lineage");

// §5 FACTUAL CONTEXT PRECEDENCE + STALE DERIVED-WRITE REJECTION.
await pool.query(`UPDATE users SET dietary_restrictions = 'vegan', truth_revision = 6 WHERE id = $1`, [user.id]);
current = await readUser();
const canonicalSeed = seedUnderstanding(current);
const newer = structuredClone(canonicalSeed);
newer.profile.lifeStory = "newer narrative";
newer.profile.keyFacts = ["model invented: eats everything"];
await saveUnderstanding(user.id, newer, 6);

const older = structuredClone(canonicalSeed);
older.profile.lifeStory = "stale narrative";
older.profile.keyFacts = ["stale model fact"];
await saveUnderstanding(user.id, older, 5);

const loaded = await loadUnderstanding(user.id, seedUnderstanding(current));
const [stored] = await db.select().from(schema.clientUnderstanding)
  .where(and(eq(schema.clientUnderstanding.userId, user.id), eq(schema.clientUnderstanding.sourceRevision, 6)));
check(loaded.profile.keyFacts.includes("dietary restriction: vegan"),
  "canonical structured restriction outranks persisted model keyFacts", JSON.stringify(loaded.profile.keyFacts));
check(!loaded.profile.keyFacts.some(x => /invented|stale model/.test(x)), "stored narrative contributes no factual slots");
check(stored?.profile && (stored.profile as any).lifeStory === "newer narrative",
  "a slow revision-5 save cannot overwrite revision-6 understanding", JSON.stringify(stored?.profile));

// §6 ONE BUBBLE, TWO SPEECH ACTS — AND THE FACT THE CLIENT TAKES BACK (#128/1).
//
// Graded on the durable column and on the line the coach is actually given, through the real front
// door, because that is where both defects lived: a constraint stated alongside a question never
// reached the column at all, and a retraction reached it as a BAN. The stub cannot say either —
// only a real row can be read back after the turn.
REAL("\n=== A CONSTRAINT, A QUESTION, AND A RETRACTION ===");
const { factsLine } = await import("../server/memory");

const phone2 = `whatsapp:+2797${String(Math.floor(Math.random() * 900000) + 100000)}`;
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone2]);
const [client2] = await db.insert(schema.users).values({
  phoneNumber: phone2, name: "Constraint Client", onboardingState: "COMPLETE",
  subscriptionStatus: "active", popiConsent: true, popiConsentAt: new Date(),
  goalType: "fat_loss", calorieTarget: 2200, proteinTarget: 140, stepsTarget: 8000,
  trainingMode: "gym", trainingDaysPerWeek: 3, createdAt: new Date(), lastActiveAt: new Date(),
} as any).returning();
const read2 = async () => (await db.select().from(schema.users).where(eq(schema.users.id, client2.id)).limit(1))[0];

await handleMessage(phone2, "I'm vegan now, what should I eat?", undefined, undefined, undefined, "SM-VEG-1");
let c2 = await read2();
check(/vegan/i.test(String(c2.dietaryRestrictions || "")),
  "a constraint stated in the same bubble as the question is committed", String(c2.dietaryRestrictions));
const bannedLine = await factsLine(phone2);
check(/Does not eat[^\n]*vegan/i.test(bannedLine),
  "…and the coach is told about it on the very next read", bannedLine.replace(/\n/g, " | "));

await handleMessage(phone2, "I'm not vegan anymore", undefined, undefined, undefined, "SM-VEG-2");
c2 = await read2();
check(c2.dietaryRestrictions == null,
  "the retraction clears the column instead of appending to it", String(c2.dietaryRestrictions));
const afterLine = await factsLine(phone2);
check(!/Does not eat/i.test(afterLine),
  "…and the coach stops being told this person cannot eat meat", afterLine.replace(/\n/g, " | "));
check(Number(c2.truthRevision) === 2, "both turns are ordered evidence", String(c2.truthRevision));

// NEGATIVE CONTROL, on the same door: describing a plate is not withdrawing an allergy.
await pool.query(`UPDATE users SET dietary_restrictions = 'allergic to fish' WHERE id = $1`, [client2.id]);
await handleMessage(phone2, "I had chicken, not fish", undefined, undefined, undefined, "SM-VEG-3");
c2 = await read2();
check(String(c2.dietaryRestrictions || "") === "allergic to fish",
  "a bare 'not fish' in a food log leaves the real allergy standing", String(c2.dietaryRestrictions));

await pool.query("DELETE FROM users WHERE id = $1", [client2.id]);
await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
REAL(`\npg-client-truth-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
