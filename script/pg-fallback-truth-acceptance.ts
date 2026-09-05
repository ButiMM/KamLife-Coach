/**
 * REAL-POSTGRESQL ACCEPTANCE — the fallback reads canonical truth, not a second fact stack (#179).
 *
 * Two readers used to answer the same questions about one client. The canonical snapshot applied
 * the P1 provenance gate to steps and read training from workout_logs; buildPatternSummary, which
 * builds the GPT fallback's context, selected step_logs unfiltered and inferred training from chat
 * wording. On identical seeded state they disagreed:
 *
 *   canonical   "Steps TODAY: none logged yet. No other verified client-reported step logs."
 *   fallback    "Steps: avg 14,000/day (3/3 days hit 8,500 target)."
 *
 *   workout_logs: 0 rows          canonical claims no session
 *                                 fallback  "1 training session logged this week."
 *
 * The outbound floor can refuse a forbidden sentence. It cannot undo a decision that was steered
 * by evidence the product had already decided it could not vouch for.
 *
 * WHY THIS NEEDS A REAL DATABASE: the whole question is which ROWS each reader sees. Provenance,
 * resolved_day and the workout ledger are columns; a fixture that answers every query the same way
 * cannot tell two readers apart, which is exactly how the divergence survived.
 *
 * BOTH DIRECTIONS ARE GRADED. Agreeing on "nothing" is trivially achievable by making the fallback
 * blind, so every silence check below is paired with a case where the evidence IS trustworthy and
 * both readers must report the same numbers.
 *
 * Requires DATABASE_URL. Skips loudly without one.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-fallback-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { buildPatternSummary } = await import("../server/gpt");
const { buildClientSnapshot } = await import("../server/brain/client-snapshot");
const { invalidatePatternCache } = await import("../server/cache");
const { sastToday } = await import("../server/utils");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
/** The sentence each reader devotes to one subject — compared, never dumped wholesale. */
const line = (s: unknown, re: RegExp) =>
  (String(s).split(/(?<=\.)\s+|\n/).find(l => re.test(l)) || "(no line)").trim();

async function seedClient(): Promise<any> {
  const phone = `whatsapp:+2792${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const r = await pool.query(
    `INSERT INTO users (phone_number,name,onboarding_state,subscription_status,popi_consent,popi_consent_at,
       goal_type,calorie_target,protein_target,steps_target,current_weight,height_cm,gender,age,training_mode,
       training_days_per_week,total_workouts_completed,last_active_at,created_at,programme_start_date,programme_week)
     VALUES ($1,'Kam','COMPLETE','active',true,now(),'fat_loss',2800,195,8500,'84.5',178,'male',35,'gym',3,24,now(),
       now() - interval '60 days', now() - interval '60 days', 3) RETURNING *`, [phone]);
  const u = r.rows[0];
  return {
    ...u, id: u.id, phoneNumber: phone, name: u.name, goalType: u.goal_type,
    proteinTarget: u.protein_target, stepsTarget: u.steps_target, calorieTarget: u.calorie_target,
    currentWeight: u.current_weight, programmeWeek: u.programme_week,
    waterLastResetDate: null, todayWater: 0, doNotMention: null,
  };
}
const bothViews = async (u: any) => {
  invalidatePatternCache(u.id);
  return { snap: String(await buildClientSnapshot(u as any)), pat: String(await buildPatternSummary(u as any)) };
};
const addStep = (uid: string, daysAgo: number, steps: number, provenance: string) => pool.query(
  `INSERT INTO step_logs (user_id, logged_at, steps, provenance, resolved_day)
   VALUES ($1, now() - ($2||' days')::interval, $3, $4,
     to_char((now() - ($2||' days')::interval) AT TIME ZONE 'Africa/Johannesburg','YYYY-MM-DD'))`,
  [uid, String(daysAgo), steps, provenance]);

// ── §1 UNTRUSTED STEP EVIDENCE MUST NOT REACH EITHER READER ─────────────────────────────────
//
// These are precisely the rows #184's throwing trigger left behind: real counts, written, and
// never marked client-reported because the chat write that would have vouched for them failed.
REAL("\n§1 unverified step rows — the #184 residue");
const a = await seedClient();
for (const d of [1, 2, 3]) await addStep(a.id, d, 14000, "unverified");
const viewA = await bothViews(a);
chk(/no other verified client-reported step logs|Steps TODAY: none/i.test(viewA.snap),
  "canonical refuses unverified rows", line(viewA.snap, /step/i));
chk(/No step data logged this week/i.test(viewA.pat),
  "the fallback refuses them too", line(viewA.pat, /^Steps:|No step data/i));
chk(!/14,?000/.test(viewA.pat), "no untrusted figure reaches the fallback's context", line(viewA.pat, /^Steps:/i));

// ── §2 …AND THE CONTROL: TRUSTED EVIDENCE MUST REACH BOTH, WITH THE SAME NUMBERS ────────────
//
// Without this, §1 is satisfied by a fallback that simply stopped reading steps at all.
REAL("\n§2 client-reported step rows — the control that makes §1 mean something");
const b = await seedClient();
for (const d of [1, 2, 3]) await addStep(b.id, d, 12000, "client_report");
const viewB = await bothViews(b);
chk(/12,000/.test(viewB.pat), "the fallback DOES report trusted steps", line(viewB.pat, /^Steps:/i));
chk(/12,000/.test(viewB.snap), "…and so does canonical", line(viewB.snap, /step/i));
chk(/3 logged day/i.test(viewB.snap) && /3\/3 days/.test(viewB.pat),
  "both count the same three days", `${line(viewB.snap, /step/i)} || ${line(viewB.pat, /^Steps:/i)}`);

// TWO READINGS ON ONE DAY ARE ONE DAY. resolved_day is what "resolved" means, and a later smaller
// number is a device re-read rather than a second walk.
REAL("\n§2b two readings on one SAST day");
const c = await seedClient();
await addStep(c.id, 1, 9000, "client_report");
await addStep(c.id, 1, 11000, "client_report");
const viewC = await bothViews(c);
chk(/11,000/.test(viewC.pat) && !/9,000/.test(viewC.pat),
  "the day carries its highest reading, once", line(viewC.pat, /^Steps:/i));
chk(/1\/1 days|1 logged day/i.test(viewC.pat + viewC.snap), "and counts as one day, not two",
  `${line(viewC.snap, /step/i)} || ${line(viewC.pat, /^Steps:/i)}`);

// ── §3 TRAINING IS THE WORKOUT LEDGER, NOT THE CHAT LOG ─────────────────────────────────────
//
// An intent tag records how a message was ROUTED. A handler that tagged the turn and then declined
// to write leaves the tag behind either way, so counting tags invents sessions that never happened.
REAL("\n§3 training evidence");
const d = await seedClient();
await pool.query(
  `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
   VALUES ($1,'done','ok','WORKOUT_LOG', now() - interval '1 days')`, [d.id]);
const viewD = await bothViews(d);
const trained = (await pool.query(`SELECT count(*)::int n FROM workout_logs WHERE user_id=$1`, [d.id])).rows[0].n;
chk(trained === 0, "durable truth: this client has never trained", String(trained));
chk(/No training sessions logged this week/i.test(viewD.pat),
  "chat wording alone invents no session in the fallback", line(viewD.pat, /training session/i));

REAL("\n§3b …and the control: a real session must still be seen");
const e = await seedClient();
await pool.query(
  `INSERT INTO workout_logs (user_id, logged_at) VALUES ($1, now() - interval '1 days'), ($1, now() - interval '3 days')`,
  [e.id]);
const viewE = await bothViews(e);
chk(/2 training sessions logged this week/i.test(viewE.pat),
  "the fallback reports sessions the ledger actually holds", line(viewE.pat, /training session/i));

// ── §4 WEIGHT TRUTH AND ITS DISCLOSURE ──────────────────────────────────────────────────────
//
// Already shared through getWeightTruth before this change. Graded so it stays shared: a boundary
// the client set must silence the figure on BOTH sides, not just the one anybody remembered.
REAL("\n§4 weight truth and do-not-mention");
const f = await seedClient();
await pool.query(
  `INSERT INTO weight_logs (user_id, logged_at, weight) VALUES ($1, now() - interval '2 days','84.5'), ($1, now() - interval '1 days','83.1')`,
  [f.id]);
// THE TELL IS users.current_weight, WHICH IS STALE ON PURPOSE HERE. It says 84.5; the logs say
// 83.1 then 82.0. A reader wired to the column reports no movement; a reader wired to the owner
// reports the drop. So this grades that the fallback's line MOVES with the ledger, which is the
// property the issue names — not that it prints a particular figure, since it renders the truth
// as a trend rather than a number.
const viewF = await bothViews(f);
const firstWeightLine = line(viewF.pat, /kg|weight/i);
chk(/down|1\.4/i.test(firstWeightLine), "the fallback's weight line is derived from the weigh-in ledger",
  firstWeightLine);
await pool.query(`INSERT INTO weight_logs (user_id, logged_at, weight) VALUES ($1, now(), '82.0')`, [f.id]);
const viewF2 = await bothViews(f);
const secondWeightLine = line(viewF2.pat, /kg|weight/i);
chk(secondWeightLine !== firstWeightLine, "a new weigh-in moves it, so it is not reading users.current_weight",
  `${firstWeightLine}  →  ${secondWeightLine}`);
chk(!/84\.5/.test(viewF2.pat), "the stale profile column never reaches the fallback's context", secondWeightLine);
chk(/82(\.0)?/.test(viewF2.snap) || /2\.5/.test(viewF2.snap), "…and canonical sees the same new reading",
  line(viewF2.snap, /kg|weight/i));
await pool.query(`UPDATE users SET do_not_mention = 'weight' WHERE id = $1`, [f.id]);
const viewFq = await bothViews({ ...f, doNotMention: "weight" });
chk(!/\d+(\.\d+)?\s*kg/.test(viewFq.pat), "a do-not-mention boundary withholds the figure from the fallback",
  line(viewFq.pat, /kg|weight/i));
chk(!/\d+(\.\d+)?\s*kg/.test(viewFq.snap), "…and from canonical", line(viewFq.snap, /kg|weight/i));

// ── §5 A CORRECTION IN CANONICAL STATE REACHES THE FALLBACK ON THE NEXT TURN ────────────────
//
// The pattern summary is cached per client for an hour, which is correct for cost and wrong for a
// turn that just changed the facts. This grades the property the client experiences: after their
// correction lands, the next eligible turn must not still be reasoning from the old number.
REAL("\n§5 a correction reaches the fallback on the next eligible turn");
const g = await seedClient();
await addStep(g.id, 1, 4000, "client_report");
const before = await bothViews(g);
chk(/4,000/.test(before.pat), "the fallback starts from the logged figure", line(before.pat, /^Steps:/i));
await pool.query(`UPDATE step_logs SET steps = 11000 WHERE user_id = $1`, [g.id]);
const after = await bothViews(g);
chk(/11,000/.test(after.pat) && !/4,000/.test(after.pat),
  "the corrected figure is what the next turn reasons from", line(after.pat, /^Steps:/i));
chk(/11,000/.test(after.snap), "…and canonical agrees on the correction", line(after.snap, /step/i));

// ── §6 THE DEGRADED-MODEL FALLBACK IS STILL THERE ───────────────────────────────────────────
//
// The point of this issue is that the fallback must read better facts, NOT that it should stop
// existing. It still builds a context, from one client, with no model call of its own.
REAL("\n§6 the fallback still works");
chk(viewB.pat.trim().length > 80, "the fallback still produces a real context block",
  `${viewB.pat.length} chars`);
chk(/PATTERN CONTEXT/i.test(viewB.pat), "…in its own shape");
const otherDay = (await pool.query(
  `SELECT resolved_day FROM step_logs WHERE user_id = $1 ORDER BY resolved_day LIMIT 1`, [b.id])).rows[0]?.resolved_day;
chk(!!otherDay && otherDay !== sastToday(), "the seeded days really are past days, not today",
  String(otherDay));

REAL(`\npg-fallback-truth-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
