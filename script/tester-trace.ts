// TESTER TRACE (CTO, 7 Oct): ordinary tester messages through the real front door, real Postgres, model offline.
// Run: DATABASE_URL=… npx tsx script/tester-trace.ts. Deterministic routing and writes are real; model-only turns show the offline stub.
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
const STUB = process.env.TRACE_MODEL === "stub"; // #592: the new coach's reading, stubbed at the network edge
if (STUB) process.env.OFFLINE_AI = "0";
const calls = STUB ? (await import("./trace-model-stub")).modelCalls : { n: 0 };
const OUT = console.log.bind(console);
let LOG: string[] = [];
console.log = console.warn = console.error = (...a: any[]) => { LOG.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
await import("./sast-noon-clock");
const { pool } = await import("../server/db");
const { handleMessage } = await import("../server/routes");

async function freshUser(over: Record<string, any> = {}) {
  const phone = `whatsapp:+2799${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const D = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  const cols: Record<string, any> = {
    phone_number: phone, name: "Thandi", onboarding_state: "COMPLETE", subscription_status: "active",
    popi_consent: true, popi_consent_at: new Date(), goal_type: "fat_loss",
    calorie_target: 1800, protein_target: 120, steps_target: 8000, current_weight: "88",
    height_cm: 165, gender: "female", age: 34, training_mode: "home", training_days_per_week: 3,
    last_active_at: new Date(), created_at: D(10), programme_start_date: D(10), programme_phase: 1, programme_week: 2, programme_day_in_week: 3, ...over,
  };
  const k = Object.keys(cols);
  const r = await pool.query(`INSERT INTO users (${k.join(",")}) VALUES (${k.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, k.map(x => cols[x]));
  return { id: r.rows[0].id as string, phone };
}
const q = async (sql: string, p: any[]) => (await pool.query(sql, p)).rows;
async function say(u: { id: string; phone: string }, msg: string) {
  LOG = []; calls.n = 0;
  const mealsBefore = (await q(`SELECT count(*)::int n FROM meal_logs WHERE user_id=$1`, [u.id]))[0].n;
  const factsBefore = (await q(`SELECT count(*)::int n FROM client_facts WHERE user_id=$1`, [u.id]).catch(() => [{ n: -1 }]))[0].n;
  const sid = `SMtrace${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const reply = String(await handleMessage(u.phone, msg, undefined, undefined, [], sid).catch((e: any) => `__THREW__ ${e?.message}`) ?? "");
  if (STUB) { // as the WhatsApp door does: the message is stored, then the record learns from the coach's own read
    await (await import("../server/core/client-record")).recordInbound({ phone: u.phone, rawText: msg, sourceMessageId: sid }).catch(() => {});
    await (await import("../server/core/coach")).learnFromLiveRead(u.phone, sid).catch(() => 0);
  }
  await new Promise(r => setTimeout(r, 400));
  const newMeals = await q(`SELECT meal_label, kcal_int, protein_int, items FROM meal_logs WHERE user_id=$1 ORDER BY logged_at DESC LIMIT GREATEST(0, (SELECT count(*) FROM meal_logs WHERE user_id=$1) - $2)`, [u.id, mealsBefore]);
  const facts = (await q(`SELECT count(*)::int n FROM client_facts WHERE user_id=$1`, [u.id]).catch(() => [{ n: -1 }]))[0].n;
  const led = (await q(`SELECT mutations FROM turn_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.id]))[0];
  const src = LOG.filter(l => /replySource|\[TURN\]|\[CORE|WAVE|reply path|owner|\[ROUTE|engine/i.test(l)).slice(-4).map(l => l.slice(0, 160));
  OUT(`\n▶ "${msg}"`);
  OUT(`  reply: ${reply.replace(/\n+/g, " ⏎ ").slice(0, 400)}`);
  OUT(`  meals written: ${newMeals.length ? newMeals.map((m: any) => `${m.meal_label}: ${(m.items || []).map((i: any) => i?.name).join(", ")} (${m.kcal_int} kcal)`).join(" | ") : "NONE"}`);
  if (STUB) OUT(`  model calls: ${calls.n}`);
  OUT(`  facts: ${factsBefore} → ${facts}; mutations: ${JSON.stringify(led?.mutations ?? null).slice(0, 220)}`);
  if (src.length) OUT(`  log: ${src.join(" ‖ ")}`);
  return reply;
}

const groups: Record<string, string[]> = {
  food: [
    "had pap and wors for lunch",
    "2 slices brown bread with peanut butter for breakfast",
    "kota from the spaza",
    "skipped breakfast, coffee only",
    "for lunch I had rice and chicken and for supper I had samp and beans",
    "I ate a vetkoek with mince",
    "had a bunny chow at work",
    "Ndidle ipapa nenyama",
    "just finished 2 pieces of KFC and a small chips",
    "no it was chicken not beef",
    "what did I eat today?",
    "I have diabetes. Had a kota for lunch",
  ],
};
const u1 = await freshUser();
OUT("════ FOOD (one client, one day) ════");
for (const m of groups.food) await say(u1, m);

OUT("\n════ MEMORY ════");
const u2 = await freshUser({ name: "Sipho", gender: "male" });
for (const m of ["I have a bad knee, it gets sore on stairs", "I work night shifts this month", "I don't eat fish"]) await say(u2, m);
const facts = await q(`SELECT kind, subject, statement FROM client_facts WHERE user_id=$1`, [u2.id]).catch(e => [{ err: String(e) }]);
OUT(`  client_facts stored: ${JSON.stringify(facts)}`);
const prof = await q(`SELECT profile_notes FROM users WHERE id=$1`, [u2.id]).catch(() => []);
OUT(`  users.profile_notes: ${JSON.stringify(prof)}`);
for (const m of ["what workout should I do today?", "what should I eat for supper tonight?", "do you remember what I told you about my knee?"]) await say(u2, m);

OUT("\n════ DOES IT DO ANYTHING ════");
const u3 = await freshUser({ name: "Lerato" });
for (const m of ["hi", "help", "I'm struggling this week", "how am I doing?", "what are my targets?", "I walked 6000 steps", "I weigh 87kg today", "I did a 30 min home workout", "remind me to drink water at 3pm", "thanks coach"]) await say(u3, m);
OUT("\n════ WORKOUTS ════");
const u4 = await freshUser({ name: "Thandi" });
for (const m of ["what's my workout today?", "Had pap and wors for lunch and did a 30 min home workout", "2"]) await say(u4, m);
await pool.end();
process.exit(0);
