/**
 * REAL-POSTGRESQL ACCEPTANCE — the #158 targeted-correction contract (#164).
 *
 * The deterministic stub ignores ORDER BY and does not reflect UPDATEs into reads, so it cannot
 * say which row a correction lands on. That is not a reason to infer the answer: this drives the
 * real handleMessage pipeline against a real PostgreSQL database with the project's own schema,
 * and reads the rows back with SQL. The database is authoritative here, not the logs.
 *
 * Requires DATABASE_URL. Skips loudly without one — a green that ran nothing is the failure mode
 * this whole file exists to avoid.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-correction-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off"; process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { eq } = await import("drizzle-orm");

const PHONE = "whatsapp:+27000000164";
await pool.query(`DELETE FROM users WHERE phone_number = $1`, [PHONE]);
const [u] = await db.insert(schema.users).values({
  phoneNumber: PHONE, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
  popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
  calorieTarget: 2800, proteinTarget: 195, stepsTarget: 8500, currentWeight: "84.5",
  heightCm: 178, gender: "male", age: 35, trainingMode: "gym", trainingDaysPerWeek: 3,
  totalWorkoutsCompleted: 24, lastActiveAt: new Date(), createdAt: new Date(Date.now() - 35*86400000),
  programmeStartDate: new Date(Date.now() - 35*86400000),
} as any).returning();

const rows = async () => (await pool.query(
  `SELECT id, logged_at, meal_label, kcal_int, protein_int, items, source_message_id, corrected, raw_message
     FROM meal_logs WHERE user_id = $1 ORDER BY logged_at ASC`, [u.id])).rows;
const names = (r: any) => (Array.isArray(r.items) ? r.items : []).map((i: any) => i.name);
const show = (label: string, rs: any[]) => {
  REAL(`\n--- ${label}`);
  for (const r of rs) REAL(`  ${new Date(r.logged_at).toDateString().slice(0,10)} id=${String(r.id).slice(0,8)} ${r.kcal_int}kcal/${r.protein_int}p label=${r.meal_label} grp=${String(r.source_message_id||"").slice(0,6)} corrected=${r.corrected} items=${JSON.stringify(names(r))}`);
};
const snap = (r: any) => JSON.stringify({ id: r.id, at: new Date(r.logged_at).toISOString(), label: r.meal_label,
  kcal: r.kcal_int, prot: r.protein_int, items: r.items, grp: r.source_message_id, corrected: r.corrected, raw: r.raw_message });

const say = async (m: string) => String(await handleMessage(PHONE, m).catch((e: any) => `THREW ${e?.message}`) ?? "");

const r1 = await say("Monday I had eggs and toast. Tuesday I had rice and chicken. Wednesday I had pap and livers.");
REAL(`REPLY-1 (${r1.split("\n\n---\n\n").length} WA msg) ${JSON.stringify(r1.slice(0,180))}`);
const before = await rows(); show("BEFORE", before);
const beforeSnap = new Map(before.map((r: any) => [new Date(r.logged_at).toDateString(), snap(r)]));

const r2 = await say("Tuesday wasn't rice, it was pap.");
REAL(`\nREPLY-2 (${r2.split("\n\n---\n\n").length} WA msg) ${JSON.stringify(r2.slice(0,180))}`);
const after = await rows(); show("AFTER", after);

REAL("\n=== VERDICT ===");
const day = (rs: any[], d: string) => rs.filter((r: any) => new Date(r.logged_at).toDateString().startsWith(d));
let failed = 0;
const chk = (ok: boolean, msg: string) => { if (!ok) failed++; REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); };
chk(before.length === 3, `three rows before (${before.length})`);
chk(after.length === 3, `no duplicate row after correction (${after.length})`);
for (const d of ["Mon", "Wed"]) {
  const b = beforeSnap.get(day(before, d)[0] ? new Date(day(before,d)[0].logged_at).toDateString() : "");
  const a = day(after, d)[0];
  chk(!!a && snap(a) === b, `${d} is byte-identical to its pre-correction snapshot`);
}
const tueB = day(before, "Tue")[0], tueA = day(after, "Tue")[0];
chk(!!tueA && tueB && tueA.id === tueB.id, `the SAME Tuesday row was updated (not replaced)`);
chk(!!tueA && !names(tueA).some((n: string) => /rice/i.test(n)), `Tuesday no longer contains the denied rice`);
chk(!!tueA && names(tueA).some((n: string) => /pap/i.test(n)), `Tuesday now contains pap`);
const today = after.filter((r: any) => new Date(r.logged_at).toDateString() === new Date().toDateString());
chk(today.length === 0, `today was not mutated or created (${today.length} rows)`);
chk(!!tueA && String(tueA.source_message_id||"") === String(tueB?.source_message_id||""), `Tuesday's event lineage preserved`);
chk(r2.split("\n\n---\n\n").length === 1, `one final client reply`);

// ── §4 ISOLATION / OVER-FIRE ────────────────────────────────────────────────────────────────
// A non-correction sentence carrying "wasn't" must not touch the ledger (#159's contract).
const beforeNoise = JSON.stringify(await rows());
await say("it wasn't that bad honestly");
chk(JSON.stringify(await rows()) === beforeNoise, `a non-correction "wasn't" sentence mutated nothing`);

// The same food on an adjacent day must not let the newest chronological row win. Wednesday
// also holds pap; correcting MONDAY's toast must move Monday, not Wednesday.
const monBefore = day(await rows(), "Mon")[0];
const wedBefore = snap(day(await rows(), "Wed")[0]);
await say("Monday wasn't toast, it was rice.");
const afterAdj = await rows();
const monAfter = day(afterAdj, "Mon")[0], wedAfter = day(afterAdj, "Wed")[0];
chk(afterAdj.length === 3, `adjacent-day correction added no row (${afterAdj.length})`);
chk(!!monAfter && monAfter.id === monBefore.id && monAfter.corrected === true, `Monday's own row was the one updated`);
chk(snap(wedAfter) === wedBefore, `Wednesday, which shares a food name, is untouched`);
show("AFTER ADJACENT-DAY CORRECTION", afterAdj);

REAL(`\npg-correction-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
