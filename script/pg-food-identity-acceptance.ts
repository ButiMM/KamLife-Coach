/**
 * REAL-POSTGRESQL ACCEPTANCE — food identity and stated portion (#206).
 *
 * THE RULE THIS ENFORCES. A client's plate must arrive intact: the food they named, the portion
 * they stated, no dish they did not eat, and no name they did not say. Three defects, each traced
 * through the real front door on main@f5d0bee before anything changed:
 *
 *   "Dinner is rice / Mince / Mixed veggies"    (founder, live, 7 Sep 13:39 SAST)
 *     scanner and store were RIGHT — Mixed frozen vegetables, 150g — and the client read
 *     "Got it — Rice, mince and Mixed. 👌". "Mixed" is not a food.
 *
 *   "I had pap and a beef stew"     logged Pap en vleis AND Beef stew: 1 180 kcal, 102g protein
 *                                   for a plate of pap and stew.
 *   "I had toast and a butter chicken curry"
 *                                   logged Toast with butter AND Butter chicken — butter the
 *                                   client never had, priced into their day.
 *   "I had half a gatsby"           stored Gatsby (half) correctly and answered "Got it —
 *                                   Gatsby", dropping the one detail they bothered to state.
 *
 * WHY POSTGRESQL. Identity and portion are what get WRITTEN. A matcher unit test cannot show that
 * the row reaching meal_logs carries the right food at the right grams, nor that the day's totals
 * follow from it — and the invented-combo defects were visible only as kcal in the ledger.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The combo did not fire" is trivially satisfied by a
 * scanner that stopped recognising combined dishes at all, which is the opposite defect: a client
 * who says "pap en vleis" means one dish and must get one.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-food-identity-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { handleMessage } = await import("../server/routes");
const { getDayLedger } = await import("../server/day-ledger");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];

async function client() {
  const phone = `whatsapp:+2786${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "88.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 8, createdAt: D(40), programmeStartDate: D(40),
    programmeWeek: 6, lastActiveAt: new Date(), ...{},
  } as any).returning();
  ids.push(u.id);
  return { id: u.id, phone };
}

/** One turn through the real front door, with what it stored and what the day became. */
async function plate(text: string) {
  const c = await client();
  const reply = String(await handleMessage(
    c.phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const rows = (await pool.query(
    `SELECT items FROM meal_logs WHERE user_id = $1 ORDER BY logged_at`, [c.id])).rows;
  const items = rows.flatMap((r: any) => Array.isArray(r.items) ? r.items : []);
  const ledger = await getDayLedger(c.id, { user: { id: c.id } });
  return { reply, items, names: items.map((i: any) => String(i.name)), ledger };
}

REAL("\n=== THE PLATE THE CLIENT NAMED IS THE PLATE WE KEEP ===");

// ── THE FOUNDER'S LIVE FAILURE ──────────────────────────────────────────────────────────────
{
  const p = await plate("Dinner is rice / Mince / Mixed veggies");
  chk(p.names.some(n => /veg/i.test(n)), "the vegetables survive as a food at all",
    JSON.stringify(p.names));
  // "Mixed" alone is not a food. This is the exact string the founder read.
  chk(!/\band Mixed\.\s*👌|\bMixed\b(?!\s*(?:veg|frozen))/i.test(p.reply),
    "`Mixed veggies` is not truncated to `Mixed` in the acknowledgement",
    JSON.stringify(p.reply.slice(0, 160)));
  chk(/mixed veg/i.test(p.reply), "…the client reads their own words back",
    JSON.stringify(p.reply.slice(0, 160)));
  chk(p.names.length === 3, "…and all three foods are stored", JSON.stringify(p.names));
}

// ── INVENTED COMBINED IDENTITIES ────────────────────────────────────────────────────────────
{
  const p = await plate("I had pap and a beef stew");
  chk(!p.names.some(n => /vleis/i.test(n)), "`pap and a beef stew` does not invent `Pap en vleis`",
    JSON.stringify(p.names));
  chk(p.names.some(n => /pap/i.test(n)) && p.names.some(n => /beef stew/i.test(n)),
    "…it is pap AND beef stew, both kept", JSON.stringify(p.names));
  chk(p.ledger.kcal < 900, "…and the day is not inflated by a dish they never ate",
    `${p.ledger.kcal} kcal`);

  const t = await plate("I had toast and a butter chicken curry");
  chk(!p.names.some(n => /toast with butter/i.test(n)) && !t.names.some(n => /toast with butter/i.test(n)),
    "`toast and a butter chicken curry` does not invent `Toast with butter`",
    JSON.stringify(t.names));
  chk(t.names.some(n => /^toast$/i.test(n)) && t.names.some(n => /butter chicken/i.test(n)),
    "…it is plain toast AND the curry", JSON.stringify(t.names));
}

// ── THE STATED PORTION SURVIVES ─────────────────────────────────────────────────────────────
{
  for (const said of ["I had half a gatsby", "I had half gatsby"]) {
    const p = await plate(said);
    chk(p.names.some(n => /gatsby/i.test(n) && /half/i.test(n)),
      `\`${said}\` keeps the HALF Gatsby identity`, JSON.stringify(p.names));
    chk(p.items.some((i: any) => Number(i.grams) === 350),
      "…at the half portion, not the full one", JSON.stringify(p.items.map((i: any) => i.grams)));
    chk(/half/i.test(p.reply), "…and the acknowledgement still says half",
      JSON.stringify(p.reply.slice(0, 120)));
  }
  const full = await plate("I had a full gatsby");
  chk(full.items.some((i: any) => Number(i.grams) === 700),
    "a full Gatsby is deterministic and twice the half",
    JSON.stringify(full.items.map((i: any) => `${i.name}@${i.grams}`)));
  const kota = await plate("I had half a kota");
  chk(kota.names.some(n => /kota/i.test(n)) && kota.items.some((i: any) => Number(i.grams) === 150),
    "a half Kota is deterministic and keeps the stated half",
    JSON.stringify(kota.items.map((i: any) => `${i.name}@${i.grams}`)));
}

// ── TWO FOODS STAY TWO FOODS, IN EITHER ORDER ───────────────────────────────────────────────
{
  for (const said of ["I had rice and chicken livers", "I had chicken livers and rice"]) {
    const p = await plate(said);
    chk(p.names.some(n => /^rice$/i.test(n)) && p.names.some(n => /chicken livers/i.test(n)),
      `\`${said}\` stays two separate foods`, JSON.stringify(p.names));
    chk(!p.names.some(n => /chicken and rice|chicken and pap/i.test(n)),
      "…with no phantom combo built from their words", JSON.stringify(p.names));
  }
}

REAL("\n=== CONTROLS — USEFUL RECOGNITION IS NOT DISABLED ===");

// The collisions above were closed by REGISTERING two combined dishes, not by weakening the
// matcher. So the dishes themselves must still resolve, as one dish, with their own numbers.
{
  const one = await plate("I had pap en vleis");
  chk(one.names.length === 1 && /vleis/i.test(one.names[0]),
    "CONTROL: `pap en vleis` is still ONE combined dish", JSON.stringify(one.names));
  chk(one.ledger.kcal > 600, "CONTROL: …priced as the whole plate", `${one.ledger.kcal} kcal`);

  const toast = await plate("I had buttered toast");
  chk(toast.names.some(n => /butter/i.test(n)),
    "CONTROL: a client who really ate buttered toast still gets it", JSON.stringify(toast.names));

  const kota = await plate("I had a kota");
  chk(kota.names.some(n => /kota/i.test(n)) && kota.items.some((i: any) => Number(i.grams) === 300),
    "CONTROL: a bare alias still resolves, at the full portion",
    JSON.stringify(kota.items.map((i: any) => `${i.name}@${i.grams}`)));

  const combo = await plate("I had chicken and rice");
  chk(combo.names.length === 1 && /chicken and rice/i.test(combo.names[0]),
    "CONTROL: a legitimate joined dish is still one dish", JSON.stringify(combo.names));

  // AND THE SCANNER'S OWN VOCABULARY STILL DOES NOT REACH THE CLIENT (voice rule 18). The label
  // is an intersection with what they typed; #206 changed the NAME it is given, not that rule.
  const bare = await plate("I had chicken");
  chk(!/thigh|breast/i.test(bare.reply),
    "CONTROL: a client who said `chicken` is not told they ate a thigh",
    JSON.stringify(bare.reply.slice(0, 120)));
}

REAL(`\n${failed === 0 ? "pg-food-identity-acceptance: GREEN — all checks passed" : `pg-food-identity-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs", "turn_ledger"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);
