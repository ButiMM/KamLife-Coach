/**
 * REAL-POSTGRESQL ACCEPTANCE — the #175 safety-turn attribution contract.
 *
 * A fixture can observe turnUser calls, but it cannot prove the asynchronous recordTurn write,
 * its user foreign key, or its build provenance survived the real handleMessage boundary. This
 * script drives that boundary against the same committed schema production deploys.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-safety-turn-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}

process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.APP_VERSION = "issue-175-safety";
process.env.NODE_ENV = "production";
delete process.env.RAILWAY_GIT_COMMIT_SHA;
delete process.env.COACH_ALERT_PHONE;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { crisisReply } = await import("../server/crisis-reply");
const { eq, and } = await import("drizzle-orm");

const phones = {
  crisis: "whatsapp:+27000000175",
  acute: "whatsapp:+27000001175",
  life: "whatsapp:+27000004175",
  quit: "whatsapp:+27000005175",
  delete: "whatsapp:+27000002175",
  reset: "whatsapp:+27000003175",
};

for (const phone of Object.values(phones)) {
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
}

async function seed(phone: string, name: string, onboardingState = "START") {
  const [user] = await db.insert(schema.users).values({
    phoneNumber: phone,
    name,
    onboardingState,
    subscriptionStatus: "active",
    popiConsent: true,
    popiConsentAt: new Date(),
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    trainingMode: "home",
    stepsTarget: 8500,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  } as any).returning();
  return user;
}

async function ledgerRows(userId: string, inputText: string): Promise<any[]> {
  return db.select().from(schema.turnLedger).where(and(
    eq(schema.turnLedger.userId, userId),
    eq(schema.turnLedger.inputText, inputText),
  ));
}

async function awaitOneTurn(userId: string, inputText: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await ledgerRows(userId, inputText);
    if (rows.length > 0) {
      if (rows.length !== 1) throw new Error(`${JSON.stringify(inputText)} produced ${rows.length} turn rows; expected exactly one`);
      return rows[0];
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${JSON.stringify(inputText)} produced no attributable turn row`);
}

let failed = 0;
const createdIds: string[] = [];
function check(ok: unknown, description: string): void {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${description}`);
}

REAL("\n=== #175 SAFETY TURN ATTRIBUTION ===");

const crisisInput = "I want to kill myself";
const crisisResponse = await handleMessage(phones.crisis, crisisInput);
const [crisisUser] = await db.select().from(schema.users).where(eq(schema.users.phoneNumber, phones.crisis));
if (!crisisUser) throw new Error("first-contact crisis did not receive a durable identity");
createdIds.push(crisisUser.id);
const crisisTurn = await awaitOneTurn(crisisUser.id, crisisInput);
check(crisisResponse === crisisReply("friend"), "first-contact crisis response is the existing deterministic safe reply");
check(crisisTurn.userId === crisisUser.id, "crisis turn is attributable to the exact client id");
check(crisisTurn.reply === crisisResponse, "crisis ledger holds the final client reply");
check(crisisTurn.version === "issue-175-safety", "crisis turn exposes exact build provenance to Coach Health");
const crisisUsers = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneNumber, phones.crisis));
check(crisisUsers.length === 1, "first-contact crisis identity binding creates exactly one user");
const crisisTruth = await db.select().from(schema.clientTruthCommits)
  .where(eq(schema.clientTruthCommits.userId, crisisUser.id));
check(crisisTruth.length === 1 && crisisTruth[0].revision === 1,
  "first-contact crisis receives exactly one canonical truth revision before returning");
const crisisChats = await db.select({ id: schema.chatHistory.id }).from(schema.chatHistory).where(and(
  eq(schema.chatHistory.userId, crisisUser.id), eq(schema.chatHistory.intent, "CRISIS"),
));
check(crisisChats.length === 1, "crisis behavior logs exactly one crisis chat event");

const acuteUser = await seed(phones.acute, "Acute Client");
createdIds.push(acuteUser.id);
const acuteInput = "I have chest pain and cannot breathe";
const acuteResponse = await handleMessage(phones.acute, acuteInput);
const acuteTurn = await awaitOneTurn(acuteUser.id, acuteInput);
check(/10177/.test(acuteResponse) && /do not wait/i.test(acuteResponse), "acute path returns the existing emergency response without a model");
check(acuteTurn.userId === acuteUser.id && acuteTurn.reply === acuteResponse, "acute turn is recorded once for the exact client");
check(acuteTurn.version === "issue-175-safety", "acute turn is queryable by the exact build");

const lifeInput = "my grandfather passed away this morning";
const lifeResponse = await handleMessage(phones.life, lifeInput);
const [lifeUser] = await db.select().from(schema.users).where(eq(schema.users.phoneNumber, phones.life));
if (!lifeUser) throw new Error("first-contact life-context turn did not receive a durable identity");
createdIds.push(lifeUser.id);
const lifeTurn = await awaitOneTurn(lifeUser.id, lifeInput);
check(/sorry/i.test(lifeResponse), "life-context path keeps its existing comfort-first response");
check(lifeTurn.userId === lifeUser.id, "life-context early return is attributable before onboarding");

const quitUser = await seed(phones.quit, "Quit Client", "COMPLETE");
createdIds.push(quitUser.id);
const quitInput = "I want to quit";
const quitResponse = await handleMessage(phones.quit, quitInput);
const quitTurn = await awaitOneTurn(quitUser.id, quitInput);
check(!/0800 567 567/.test(quitResponse), "programme quit still uses quit-save rather than crisis policy");
check(quitTurn.userId === quitUser.id, "quit-save early return is attributable to the existing client");

const deleteUser = await seed(phones.delete, "Delete Client", "COMPLETE");
createdIds.push(deleteUser.id);
const deletePrompt = "delete my data";
const deletePromptResponse = await handleMessage(phones.delete, deletePrompt);
await awaitOneTurn(deleteUser.id, deletePrompt);
check(/Reply \*DELETE\*/.test(deletePromptResponse), "POPIA confirmation behavior is unchanged");
const deleteResponse = await handleMessage(phones.delete, "DELETE");
const deleteTurn = await awaitOneTurn(deleteUser.id, "DELETE");
check(/permanently deleted/i.test(deleteResponse), "confirmed POPIA deletion still completes");
check(deleteTurn.userId === deleteUser.id && deleteTurn.version === "issue-175-safety", "confirmed deletion retains an attributable audit turn on the pseudonymised user id");
const originalDeletePhone = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneNumber, phones.delete));
check(originalDeletePhone.length === 0, "confirmed deletion does not recreate the original phone identity");

const oldResetUser = await seed(phones.reset, "Reset Client");
createdIds.push(oldResetUser.id);
const resetResponse = await handleMessage(phones.reset, "reset");
const [newResetUser] = await db.select().from(schema.users).where(eq(schema.users.phoneNumber, phones.reset));
if (!newResetUser) throw new Error("reset did not create its existing fresh-start user");
createdIds.push(newResetUser.id);
const resetTurn = await awaitOneTurn(newResetUser.id, "reset");
check(/Fresh start/i.test(resetResponse), "reset behavior is unchanged");
check(newResetUser.id !== oldResetUser.id, "reset still replaces the old account identity");
check(resetTurn.userId === newResetUser.id, "reset audit turn follows the replacement user instead of a deleted foreign key");

for (const id of createdIds) {
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}

REAL(`\npg-safety-turn-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
