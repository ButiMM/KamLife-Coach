/**
 * REAL-POSTGRESQL ACCEPTANCE — "delete my data" deletes the client (#269).
 *
 * WHAT WAS BROKEN (AUDIT.md P1, deletion): the confirmed DELETE cleared a hand-kept list of tables
 * and then UPDATED the users row (phone renamed to "[deleted-<id>]"), so the foreign-key cascades
 * never fired. Every table added since the list was written kept the client: the turn ledger with
 * their raw messages, client_understanding, daily_constraints, gpt_costs, quality_signals with the
 * message text, the shadow replies — and on the users row itself the model-written life story,
 * dream goal, food likes, email and targets. The client was told "All your data has been
 * permanently deleted."
 *
 * Graded on the database itself — every table that holds a user_id or the phone, read from the
 * catalogue at run time so a table added later is graded too — and on the post-transport body.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-popia-deletion-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "false";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
delete process.env.PAYFAST_MERCHANT_ID; // no live PayFast from a test: the cancel reports unconfirmed
delete process.env.PAYFAST_PASSPHRASE;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
let sidN = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM269${++sidN}`);
  await new Promise(r => setTimeout(r, 1500));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(n: number) {
  const phone = `whatsapp:+2782000269${n}`;
  // Earlier runs (including one against main, which renames the row instead of deleting it).
  const old = await pool.query("SELECT id FROM users WHERE phone_number = $1 OR email = $2", [phone, `thandi${n}@example.com`]);
  await pool.query("DELETE FROM quality_signals WHERE message_in LIKE '%Thandi-269-marker%'");
  for (const r of old.rows) await pool.query("DELETE FROM users WHERE id = $1", [r.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await pool.query("DELETE FROM payment_events WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Thandi${n} Delete`, email: `thandi${n}@example.com`, onboardingState: "COMPLETE",
    popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", paymentReference: `KL-269-${n}`,
    goalType: "fat_loss", gender: "female", age: 34, heightCm: 165, currentWeight: "78", calorieTarget: 1700, proteinTarget: 120,
    trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office", trainingExperience: "beginner",
    dreamGoal: "fit into my wedding dress", lifeContext: "divorced last year, two kids, night shifts at the hospital",
    foodLikes: "pap, amasi", medicalConditions: "type 2 diabetes",
  } as any).returning();
  return u as any;
}
// Everything in the catalogue that can point at a client: a user_id column, or a phone column.
const USER_TABLES = (await pool.query<{ t: string }>(
  `SELECT DISTINCT table_name t FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'user_id' AND table_name <> 'users'`)).rows.map(r => r.t);
const PHONE_COLS = (await pool.query<{ t: string; c: string }>(
  `SELECT table_name t, column_name c FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'users' AND data_type IN ('text','character varying')
      AND column_name IN ('phone','phone_number','target_phone')`)).rows;
// The one expressly documented exception: payment records, kept because tax law requires them.
const RETAINED = new Set(["payment_events"]);

async function leftovers(uid: string, phone: string, beforeShadowId: number): Promise<string[]> {
  const out: string[] = [];
  const u = await pool.query("SELECT 1 FROM users WHERE id = $1 OR phone_number = $2 OR phone_number = $3", [uid, phone, `[deleted-${uid}]`]);
  if (u.rowCount) out.push(`users×${u.rowCount}`);
  for (const t of USER_TABLES) {
    if (RETAINED.has(t)) continue;
    const r = await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE user_id::text = $1`, [uid]);
    if (r.rows[0].n) out.push(`${t}×${r.rows[0].n}`);
  }
  for (const { t, c } of PHONE_COLS) {
    if (RETAINED.has(t)) continue;
    // The final reply is itself captured into shadow_replies by the test transport, after the
    // deletion; only what existed before the confirming turn is graded there.
    const extra = t === "shadow_replies" ? ` AND id <= ${beforeShadowId}` : "";
    const r = await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE ${c} = $1${extra}`, [phone]);
    if (r.rows[0].n) out.push(`${t}.${c}×${r.rows[0].n}`);
  }
  // quality_signals keeps only the last four digits of a phone, and the message text.
  const q = await pool.query("SELECT COUNT(*)::int n FROM quality_signals WHERE message_in LIKE '%Thandi-269-marker%'");
  if (q.rows[0].n) out.push(`quality_signals(message text)×${q.rows[0].n}`);
  return out;
}

REAL("\npg-popia-deletion-acceptance — \"delete my data\" deletes the client (#269)\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. A CLIENT WITH A REAL HISTORY CONFIRMS DELETION");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const u = await client(1);
const other = await client(2);
await say(u.phoneNumber, "I had pap and chicken for lunch");
await say(u.phoneNumber, "I'm not training today, my knee is sore");
await say(other.phoneNumber, "I had oats for breakfast");
await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1, '78.2', now())", [u.id]);
await pool.query(`INSERT INTO quality_signals (user_id, phone_last4, kind, message_in, message_out)
  VALUES ($1, '2691', 'test', 'Thandi-269-marker: my ex took the kids', 'ok')`, [u.id]);
await pool.query("DELETE FROM media_jobs WHERE source_message_id = 'SM269media'");
await pool.query("INSERT INTO media_jobs (source_message_id, phone_number, user_id, media_type, status) VALUES ('SM269media', $1, $2, 'image', 'done')", [u.phoneNumber, u.id]);
await pool.query("INSERT INTO admin_events (action, target_phone, reason) VALUES ('test_event', $1, 'seeded')", [u.phoneNumber]);
await pool.query(`INSERT INTO payment_events (provider, provider_payment_id, phone, amount_gross, payment_status, raw_body)
  VALUES ('payfast', 'pf-269-1', $1, '299.00', 'COMPLETE', $2)`, [u.phoneNumber, JSON.stringify({ token: "tok-269" })]);
const before = await leftovers(u.id, u.phoneNumber, await lastShadowId());
REAL(`        before: ${before.join(", ")}`);

const prompt = await say(u.phoneNumber, "delete my data");
REAL(`        prompt: ${JSON.stringify(prompt.slice(0, 300))}`);
const s0 = await lastShadowId();
const body = await say(u.phoneNumber, "DELETE");
const after = await leftovers(u.id, u.phoneNumber, s0);
REAL(`        after:  ${after.join(", ") || "(nothing)"}`);
REAL(`        final body: ${JSON.stringify(body.slice(0, 400))}`);

chk(before.length > 5, "the seed really spread the client across the database", before.join(", "));
chk(after.length === 0, "nothing that points at the client survives, in any table", after.join(", "));
const lc = await pool.query("SELECT COUNT(*)::int n FROM users WHERE id = $1 OR email = 'thandi1@example.com'", [u.id]);
chk(lc.rows[0].n === 0, "the life story and email are gone with the row", `rows=${lc.rows[0].n}`);
const pay = await pool.query("SELECT COUNT(*)::int n FROM payment_events WHERE phone = $1", [u.phoneNumber]);
chk(pay.rows[0].n === 1, "the payment record is kept — the one documented exception", `rows=${pay.rows[0].n}`);

// THE COPY IS TRUE. It names the exception it keeps, and it does not promise a billing outcome
// PayFast did not confirm (no PayFast credentials here, so the cancel is unconfirmed).
chk(/deleted/i.test(body) && /payment records?/i.test(body), "the confirmation says what was deleted and names what is kept", JSON.stringify(body));
chk(!/\ball your data\b/i.test(body), "…and does not claim ALL the data went while payment records stay", JSON.stringify(body));
chk(!/won'?t be charged|will not be charged/i.test(body) && /by hand|cancel/i.test(body),
  "…and says billing is being cancelled by hand, not that it is cancelled, when PayFast did not confirm", JSON.stringify(body));
chk(/payment records?/i.test(prompt) && !/\ball your data\b/i.test(prompt), "the confirmation prompt is true about the exception too", JSON.stringify(prompt));
// "by hand" is only true if someone can see it: the unconfirmed cancel is flagged in the admin
// view with the PayFast token, and without the deleted client's phone.
const flag = await pool.query("SELECT target_phone, meta->>'token' tok FROM admin_events WHERE action = 'account_deleted_subscription_cancel_unconfirmed' ORDER BY id DESC LIMIT 1");
chk(flag.rowCount === 1 && flag.rows[0].tok === "tok-269" && flag.rows[0].target_phone === null,
  "the unconfirmed cancel is flagged for a manual cancel, with the token and no phone", JSON.stringify(flag.rows[0] || null));

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. EVERYONE ELSE IS UNTOUCHED, AND THE NUMBER CAN START AGAIN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const kept = await pool.query("SELECT (SELECT COUNT(*) FROM meal_logs WHERE user_id = $1)::int meals, (SELECT COUNT(*) FROM users WHERE id = $1)::int users", [other.id]);
chk(kept.rows[0].meals >= 1 && kept.rows[0].users === 1, "CONTROL — another client's data is untouched", JSON.stringify(kept.rows[0]));
await say(u.phoneNumber, "hi");
const fresh = await pool.query("SELECT id, name, life_context, dream_goal FROM users WHERE phone_number = $1", [u.phoneNumber]);
chk(fresh.rowCount === 1 && fresh.rows[0].id !== u.id && !fresh.rows[0].life_context && !fresh.rows[0].dream_goal,
  "a new message starts a genuinely new account with none of the old story", JSON.stringify(fresh.rows[0] || null));

REAL(`\npg-popia-deletion-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
