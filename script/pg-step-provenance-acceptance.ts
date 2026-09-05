/**
 * REAL-POSTGRESQL ACCEPTANCE — the step-provenance bridge (#184).
 *
 * The provenance owner is a DATABASE function. No amount of TypeScript testing can say whether
 * `kamlife_parse_step_report` compiles its regular expressions, because the regular expressions
 * are compiled by PostgreSQL, at call time, inside a trigger the application never awaits. That
 * is exactly how the defect stayed invisible: the step row was written, the client got a normal
 * reply, and only the database log carried
 *
 *     ERROR: invalid regular expression: parentheses () not balanced
 *
 * while every client-stated step count silently stayed 'unverified' — and canonical state
 * deliberately filters untrusted step evidence, so the client could state their steps and be
 * coached later as though they had never said anything.
 *
 * So this drives the real front door against a real database and reads provenance back with SQL,
 * and it grades the function directly for the forms a trigger can only reach one at a time.
 *
 * Requires DATABASE_URL. Skips loudly without one.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-step-provenance-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off"; process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool } = await import("../server/db");
const { handleMessage } = await import("../server/routes");
const { sastDayKey } = await import("../server/sast");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

async function freshUser(): Promise<{ id: string; phone: string }> {
  const phone = `whatsapp:+2797${String(Math.floor(Math.random() * 900000) + 100000)}`;
  await pool.query(`DELETE FROM users WHERE phone_number = $1`, [phone]);
  const r = await pool.query(
    `INSERT INTO users (phone_number,name,onboarding_state,subscription_status,popi_consent,popi_consent_at,
       goal_type,calorie_target,protein_target,steps_target,current_weight,height_cm,gender,age,training_mode,
       training_days_per_week,total_workouts_completed,last_active_at,created_at,programme_start_date)
     VALUES ($1,'Kam','COMPLETE','active',true,now(),'fat_loss',2800,195,8500,'84.5',178,'male',35,'gym',3,24,now(),
       now() - interval '35 days', now() - interval '35 days') RETURNING id`, [phone]);
  return { id: r.rows[0].id, phone };
}

const stepRows = async (uid: string) => (await pool.query(
  `SELECT id, steps, provenance, resolved_day, logged_at FROM step_logs WHERE user_id = $1 ORDER BY logged_at`, [uid])).rows;
const chatRows = async (uid: string) => (await pool.query(
  `SELECT intent, message_in FROM chat_history WHERE user_id = $1 ORDER BY created_at`, [uid])).rows;
const parse = async (raw: string): Promise<number | null | string> => {
  try {
    const r = await pool.query(`SELECT public.kamlife_parse_step_report($1) AS n`, [raw]);
    return r.rows[0].n === null ? null : Number(r.rows[0].n);
  } catch (e: any) { return `THREW: ${e?.message}`; }
};

// ── §1 THE PARSER ITSELF, EVERY FORM, COMPILED BY POSTGRESQL ────────────────────────────────
//
// Graded here rather than only through the trigger because a trigger reaches one branch per
// message, and all three branches were dead: the screenshot pattern threw, and the other two
// carried `\b`, which in PostgreSQL's regular expressions means BACKSPACE rather than a word
// boundary — so they matched nothing and said so silently. Fixing only the throw would have left
// two thirds of the owner broken and every control still green.
REAL("\n§1 kamlife_parse_step_report — the forms it must read");
chk(await parse("[Step Screenshot: 12,345]") === 12345, "screenshot receipt → 12345", String(await parse("[Step Screenshot: 12,345]")));
chk(await parse("I did 8000 steps") === 8000, "plain numeric → 8000", String(await parse("I did 8000 steps")));
chk(await parse("12,000 steps today") === 12000, "comma form → 12000", String(await parse("12,000 steps today")));
chk(await parse("walked 12k steps") === 12000, "k form → 12000", String(await parse("walked 12k steps")));
chk(await parse("ten thousand steps") === 10000, "word form → 10000", String(await parse("ten thousand steps")));
chk(await parse("twelve and a half thousand steps") === 12500, "word form with a half → 12500", String(await parse("twelve and a half thousand steps")));

REAL("\n§1b …and the forms it must NOT read");
chk(await parse("I paid R8000 for the gym") === null, "a price is not a step count", String(await parse("I paid R8000 for the gym")));
chk(await parse("I had 200g rice") === null, "a food quantity is not a step count", String(await parse("I had 200g rice")));
chk(await parse("I weighed 83.9 this morning") === null, "a weight is not a step count", String(await parse("I weighed 83.9 this morning")));
chk(await parse("50 steps") === null, "an implausibly small count is refused", String(await parse("50 steps")));
chk(await parse("500000 steps") === null, "an implausibly large count is refused", String(await parse("500000 steps")));
chk(await parse("") === null, "empty input returns null rather than throwing", String(await parse("")));

// ── §2 THROUGH THE REAL FRONT DOOR ──────────────────────────────────────────────────────────
REAL("\n§2 handleMessage → step row, chat row, trusted provenance");
const today = sastDayKey(new Date());

const u1 = await freshUser();
const r1 = String(await handleMessage(u1.phone, "I did 8000 steps").catch((e: any) => `THREW ${e?.message}`) ?? "");
const s1 = await stepRows(u1.id);
const c1 = await chatRows(u1.id);
REAL(`  reply: ${JSON.stringify(r1.slice(0, 90))}`);
chk(!r1.startsWith("THREW") && r1.trim().length > 0, "the client got a reply", r1.slice(0, 120));
chk(s1.length === 1 && Number(s1[0].steps) === 8000, `exactly one step row holding 8000 (${JSON.stringify(s1.map(r => r.steps))})`);
chk(c1.length > 0, `the chat-history write SURVIVED the trigger (${c1.length} rows)`);
chk(!!s1[0] && s1[0].provenance === "client_report",
  `the row is marked client_report`, `provenance=${s1[0]?.provenance}`);
chk(!!s1[0] && s1[0].resolved_day === today,
  `on the exact SAST day`, `resolved_day=${s1[0]?.resolved_day} vs ${today}`);

// WORD FORM, end to end — the branch that never matched even before the throw.
const u2 = await freshUser();
await handleMessage(u2.phone, "twelve and a half thousand steps").catch(() => "");
const s2 = await stepRows(u2.id);
chk(s2.length === 1 && Number(s2[0].steps) === 12500, `word form logged 12500 (${JSON.stringify(s2.map(r => r.steps))})`);
chk(!!s2[0] && s2[0].provenance === "client_report", `and is trusted`, `provenance=${s2[0]?.provenance}`);

// SCREENSHOT RECEIPT — the form the media handler emits, graded at the parser because the
// media path needs an image the front door cannot be handed here.
chk(await parse("[Step Screenshot: 9,412]") === 9412, "screenshot receipt form still supported", String(await parse("[Step Screenshot: 9,412]")));

// ── §3 OVER-FIRE AND ISOLATION ──────────────────────────────────────────────────────────────
REAL("\n§3 nothing else is marked, and nobody else is touched");
const bystander = await freshUser();
await pool.query(`INSERT INTO step_logs (user_id, logged_at, steps) VALUES ($1, now() - interval '1 day', 7100)`, [bystander.id]);
const byBefore = JSON.stringify(await stepRows(bystander.id));

const u3 = await freshUser();
await handleMessage(u3.phone, "I paid R8000 for the gym this month").catch(() => "");
chk((await stepRows(u3.id)).length === 0, `a price with the same number wrote no step row`);

const u4 = await freshUser();
await handleMessage(u4.phone, "I did 8000 steps").catch(() => "");
chk((await stepRows(u4.id)).length === 1, `a second client's report writes only their own row`);
chk(JSON.stringify(await stepRows(bystander.id)) === byBefore, `the bystander's step rows are byte-identical`);
chk((await stepRows(u1.id)).length === 1 && (await stepRows(u1.id))[0].id === s1[0].id,
  `the first client's row was neither duplicated nor replaced`);

// ── §4 RED ON REVERT, ON THE REAL DATABASE ──────────────────────────────────────────────────
//
// Not a description of the old bug — the old function, restored into this database, asked the
// same question, and put back. If this section ever passes silently the repair is unproven.
REAL("\n§4 red on revert — the pre-#184 function definition, restored");
const FAULTY = `
CREATE OR REPLACE FUNCTION public.kamlife_parse_step_report(raw text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE m text[];
BEGIN
  m := regexp_match(COALESCE(raw, ''), '\\\\[Step Screenshot:\\s*([0-9,]+)\\\\]', 'i');
  IF m IS NOT NULL THEN RETURN regexp_replace(m[1], '[^0-9]', '', 'g')::integer; END IF;
  RETURN NULL;
END; $fn$;`;
const fixedDef = (await pool.query(
  `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'kamlife_parse_step_report'`)).rows[0].def;
await pool.query(FAULTY);
const brokenResult = await parse("I did 8000 steps");
chk(typeof brokenResult === "string" && /parentheses \(\) not balanced/.test(brokenResult),
  `the faulty definition throws the ORIGINAL error`, String(brokenResult));
const u5 = await freshUser();
await handleMessage(u5.phone, "I did 8000 steps").catch(() => "");
const s5 = await stepRows(u5.id);
chk(s5.length === 1 && s5[0].provenance !== "client_report",
  `and with it restored, a stated count is NOT trusted`, `provenance=${s5[0]?.provenance}`);
await pool.query(fixedDef);
chk(await parse("I did 8000 steps") === 8000, `the repaired definition is back in place`);

REAL(`\npg-step-provenance-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
