/**
 * REAL-POSTGRESQL ACCEPTANCE — one food evidence, one nutritional truth (C11).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GOVERNING CONTRACT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     Persisted canonical items are the nutritional ledger.
 *     Meal calories equal the sum of their persisted item calories.
 *
 * Every case below asserts that invariant on every row it writes, in addition to whatever else it
 * is about — because a case that checks only its own headline can leave the ledger inconsistent
 * and still pass.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED ON e53763b BEFORE A LINE OF THE REPAIR WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nine cases through the live front door and real PostgreSQL. C, E and H were re-measured on
 * 85d1b73 in a worktree and behave identically there, so none of them is a regression from the
 * C9/C10 work that landed in between — they are the product as it has been.
 *
 *   A  identical meal at lunch and dinner      same items, same 580 kcal, only the slot differs
 *   B  "same as lunch for dinner"              copies the calories, but stores slot NULL
 *   C  bare "chicken and rice", no verb        nothing logged at all
 *   D  2 vs 4 chicken breasts                  594 / 1188 — exactly linear
 *   E  "100g dry rice"                         nothing logged, and no clarification either
 *   F  black coffee                            5 kcal, logged
 *   G  "my gran's seven colours plate"         clarifies instead of guessing  (correct)
 *   H  "Actually it was two chicken breasts not one"    580 -> 877, when the truth is ~594
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIRST DIVERGENCE (H), NAMED — interpretation and calculation, not persistence
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two defects compound into one wrong number:
 *
 *   1. applyCorrection skips a removal it cannot resolve —  `if (exact === -1) continue;`  — and
 *      planCorrection puts the QUANTITY WORD "one" into `remove`, which matches no food. So the
 *      removal is dropped while the add still lands, and a correction degrades into an APPEND.
 *
 *   2. food-log-mgmt's `resolveFood` reads typicalPortionCalories straight off the scanner,
 *      bypassing adjustFoodsForSegment — the existing quantity authority — so "two chicken
 *      breasts" resolves to ONE portion.
 *
 * Persistence is faithful throughout: sum(items) === kcal_int in every row measured. The mismatch
 * is upstream of the ledger, which is why the repair belongs at those two owners and not at the
 * writer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT COVER, STATED RATHER THAN IMPLIED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The PHOTO path is not driven here: assertSafeMediaUrl requires an https allow-listed host and
 * the vision call needs the network, neither of which exists offline. Section 7 grades the claim
 * that survives without it — that the photo writer persists items and does not store a model
 * total that contradicts their sum — by reading the write site, and it says so in its own name.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-food-calorie-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

// ── THE FROZEN CLOCK ─────────────────────────────────────────────────────────────────────────
const RealDate = Date;
const SAST_DAY = [2026, 8, 16] as const;              // 16 September 2026
const TODAY = "2026-09-16";
function freezeSast(hour: number): () => void {
  const fixed = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], hour - 2, 30, 0);
  class F extends RealDate {
    constructor(...a: any[]) { super(...(a.length === 0 ? [fixed] : a) as [any]); }
    static now() { return fixed; }
  }
  (globalThis as any).Date = F;
  return () => { (globalThis as any).Date = RealDate; };
}
const dayOf = (d: Date | string): string =>
  new RealDate(new RealDate(d).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);

const phone = "whatsapp:+27820001101";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Kalo Truth", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 170, age: 33,
  gender: "male", trainingMode: "gym", proteinTarget: 150, calorieTarget: 2200,
  dailyCalorieTarget: 2200, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

type Item = { name?: string; grams?: number; kcal?: number; protein?: number; origin?: string; quantity?: number; portionSource?: string };
type Row = { kcal_int: number; protein_int: number; meal_label: string | null; source: string; items: Item[]; logged_at: Date; raw_message: string | null };

const rows = async (): Promise<Row[]> => (await pool.query<Row>(
  `SELECT kcal_int, protein_int, meal_label, source, items, logged_at, raw_message
     FROM meal_logs WHERE user_id = $1 ORDER BY logged_at, id`, [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const dayTotal = async (): Promise<number> => {
  const [r] = (await pool.query<{ today_calories: number | null }>(
    "SELECT today_calories FROM users WHERE id = $1", [user.id])).rows;
  return Number(r?.today_calories || 0);
};
const clear = async () => {
  for (const t of ["meal_logs", "chat_history", "turn_ledger"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]).catch(() => {});
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await pool.query("UPDATE users SET profile_notes = NULL, today_calories = 0, today_calories_date = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 1500));

/** One turn at a pinned SAST hour, through the real reactive front door. */
async function send(hour: number, text: string, sid: string) {
  const un = freezeSast(hour);
  try { await processTextAsync(phone, text, null, null, [], handleMessage as any, sid); await settle(); }
  finally { un(); }
}
/** A conversation: clear, then each turn in order. Returns the end state. */
async function journey(label: string, turns: Array<[number, string]>) {
  await clear();
  let i = 0;
  for (const [h, t] of turns) await send(h, t, `c11-${label}-${i++}`);
  return { rows: await rows(), bodies: await wire(), total: await dayTotal() };
}

const itemKcal = (r: Row) => (Array.isArray(r.items) ? r.items : []).reduce((s, i) => s + (Number(i.kcal) || 0), 0);
const names = (r: Row) => (Array.isArray(r.items) ? r.items : []).map(i => String(i.name || "")).sort();

/** THE GOVERNING CONTRACT, asserted on every row every case writes. */
function ledgerHolds(label: string, rs: Row[]) {
  for (const [n, r] of rs.entries()) {
    chk(itemKcal(r) === r.kcal_int,
      `${label} — row ${n + 1}: meal calories equal the sum of its persisted items`,
      `sum=${itemKcal(r)} kcal_int=${r.kcal_int} items=${JSON.stringify(r.items)}`);
  }
}

REAL("\npg-food-calorie-truth-acceptance — one food evidence, one nutritional truth\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. IDENTICAL MEAL AT LUNCH AND DINNER — only the date and slot may differ");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const j = await journey("identical", [[13, "I had chicken and rice for lunch"], [19, "I had chicken and rice for dinner"]]);
  ledgerHolds("identical", j.rows);
  chk(j.rows.length === 2, "two eating events, two rows", `got ${j.rows.length}`);
  if (j.rows.length === 2) {
    const [a, b] = j.rows;
    chk(a.kcal_int === b.kcal_int && a.protein_int === b.protein_int,
      "the same plate costs the same at lunch and at dinner",
      `lunch=${a.kcal_int}/${a.protein_int} dinner=${b.kcal_int}/${b.protein_int}`);
    chk(JSON.stringify(names(a)) === JSON.stringify(names(b)),
      "and resolves to the same canonical items",
      `${JSON.stringify(names(a))} vs ${JSON.stringify(names(b))}`);
    chk(a.meal_label === "lunch" && b.meal_label === "dinner",
      "the slot the client named is what differs", `${a.meal_label} / ${b.meal_label}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. \"SAME AS LUNCH FOR DINNER\" — an exact copy, filed where they said");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A repeat copies durable truth instead of re-estimating. It must also land in the slot the
// client named: measured on e53763b the calories copied correctly and meal_label came back NULL,
// so the day held a dinner nobody could see as a dinner.
{
  const j = await journey("repeat", [[13, "I had chicken and rice for lunch"], [19, "Same as lunch for dinner"]]);
  ledgerHolds("repeat", j.rows);
  chk(j.rows.length === 2, "the repeat is its own eating event", `got ${j.rows.length}`);
  if (j.rows.length === 2) {
    const [src, copy] = j.rows;
    chk(copy.kcal_int === src.kcal_int && copy.protein_int === src.protein_int,
      "the copy carries the source's calories exactly — not a re-estimate",
      `src=${src.kcal_int}/${src.protein_int} copy=${copy.kcal_int}/${copy.protein_int}`);
    chk(JSON.stringify(names(copy)) === JSON.stringify(names(src)),
      "and the source's items exactly", `${JSON.stringify(names(src))} vs ${JSON.stringify(names(copy))}`);
    chk(copy.meal_label === "dinner",
      "and is filed as the dinner the client said it was",
      `meal_label=${JSON.stringify(copy.meal_label)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. EQUIVALENT WORDING — the same plate, said two ways, costs the same");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Both fixtures carry an eating verb on purpose. A bare "chicken and rice" with no verb is not
// logged at all on e53763b OR on 85d1b73 — a real gap, but a separate one from this invariant,
// and asserting it here would have this case silently pass on two empty days.
{
  const j1 = await journey("wordA", [[13, "I had chicken and rice"]]);
  const j2 = await journey("wordB", [[13, "I ate rice and chicken"]]);
  ledgerHolds("wordA", j1.rows);
  ledgerHolds("wordB", j2.rows);
  chk(j1.rows.length > 0 && j2.rows.length > 0,
    "both wordings are logged — neither is silently dropped",
    `A=${j1.rows.length} B=${j2.rows.length}`);
  if (j1.rows.length > 0 && j2.rows.length > 0) {
    const a = j1.rows.reduce((s, r) => s + r.kcal_int, 0);
    const b = j2.rows.reduce((s, r) => s + r.kcal_int, 0);
    chk(a === b, "and cost the same", `A=${a} B=${b}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. QUANTITY MOVES CALORIES PREDICTABLY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const j2 = await journey("qty2", [[13, "2 chicken breasts"]]);
  const j4 = await journey("qty4", [[13, "4 chicken breasts"]]);
  ledgerHolds("qty2", j2.rows);
  ledgerHolds("qty4", j4.rows);
  const k2 = j2.rows.reduce((s, r) => s + r.kcal_int, 0);
  const k4 = j4.rows.reduce((s, r) => s + r.kcal_int, 0);
  chk(k2 > 0 && k4 > 0, "both quantities are logged", `2=${k2} 4=${k4}`);
  chk(k2 > 0 && k4 === k2 * 2, "four costs exactly twice two", `2=${k2} 4=${k4}`);
  const g2 = (j2.rows[0]?.items || []).reduce((s, i) => s + (Number(i.grams) || 0), 0);
  const g4 = (j4.rows[0]?.items || []).reduce((s, i) => s + (Number(i.grams) || 0), 0);
  chk(g2 > 0 && g4 === g2 * 2, "and the persisted grams scale with it", `2=${g2}g 4=${g4}g`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. A STATED WEIGHT IS NOT SILENTLY DROPPED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// "100g dry rice" and "100g cooked rice" are a different BASIS for the same food, and on e53763b
// neither was logged and neither drew a clarification — the client was answered with the generic
// "tell me what you ate today" about food they had just named with a weight. The contract allows
// either outcome (store the basis, or ask) and forbids the third: silence.
{
  for (const [label, text] of [["dry", "I had 100g dry rice"], ["cooked", "I had 100g cooked rice"]] as const) {
    const j = await journey(`basis-${label}`, [[13, text]]);
    ledgerHolds(`basis-${label}`, j.rows);
    const body = j.bodies.join("\n");
    const asked = /\bclearer\b|\bwhich\b|\bdry\b|\bcooked\b|\bitems\b/i.test(body);
    chk(j.rows.length > 0 || asked,
      `"${text}" is either logged or asked about — never silently dropped`,
      `rows=${j.rows.length} body=${JSON.stringify(body.slice(0, 180))}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. UNKNOWN EVIDENCE IS ASKED ABOUT, NEVER GUESSED AT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const j = await journey("unknown", [[13, "I had my gran's seven colours plate"]]);
  chk(j.rows.length === 0, "nothing is invented for food we cannot price", `rows=${j.rows.length}`);
  chk(/clearer|items|one line/i.test(j.bodies.join("\n")),
    "the client is asked instead", `body=${JSON.stringify(j.bodies.join(" | ").slice(0, 200))}`);
  chk(j.total === 0, "and the day's total is untouched", `total=${j.total}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. THE PHOTO TOTAL IS EVIDENCE, NOT A SECOND LEDGER (source-graded, and it says so)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The photo path cannot run offline — assertSafeMediaUrl needs an allow-listed https host and the
// vision call needs the network. What survives without it is the write-site claim: the photo
// writer persists ITEMS, and the meal total it stores is their sum rather than a model figure
// standing beside them. Graded on source, and named so nobody reads it as an end-to-end proof.
// The RECONCILER is graded as a pure function — that part needs no network — and the WIRING is
// graded on source, because the vision call itself cannot run offline. Both halves are named so
// neither reads as an end-to-end photo proof, which this is not.
{
  const { reconcileVisionMeal } = await import("../server/serving-units");
  const VISION = [
    "Chicken breast (180g): ~297 kcal, 56g protein",
    "Rice (200g): ~220 kcal, 5g protein",
    "TOTAL: 800 kcal | 70g protein",           // the model's own arithmetic, wrong on purpose
  ].join("\n");
  const rec = reconcileVisionMeal(VISION, 800, 70);
  const sum = rec.items.reduce((s, i) => s + i.kcal, 0);
  chk(rec.kcalInt === sum, "the reconciled meal total IS the sum of its items", `kcal=${rec.kcalInt} sum=${sum}`);
  chk(rec.kcalInt === 517, "the model's disagreeing TOTAL does not win", `kcal=${rec.kcalInt}`);
  chk(rec.items.length === 2, "and every priced item survives", `items=${rec.items.length}`);

  // The harder half: the model gives a total and NO parseable items. Storing that total with an
  // empty items array is a calorie figure with no evidence behind it — the shape the ledger exists
  // to prevent — so the total survives as one item standing for the plate.
  const bare = reconcileVisionMeal("TOTAL: 640 kcal | 41g protein", 640, 41);
  chk(bare.items.length === 1 && bare.items[0].kcal === 640 && bare.kcalInt === 640,
    "an unparseable plate still stores its number AS an item, so sum still equals total",
    JSON.stringify(bare));
  const nothing = reconcileVisionMeal("NOT_FOOD", 0, 0);
  chk(nothing.items.length === 0 && nothing.kcalInt === 0, "and nothing is written for a non-food photo");

  // A ZERO-CALORIE ITEM IS NOT AN ABSENT ITEM. The first cut of this reconciler filtered to
  // kcal > 0 before deciding, which deleted a parsed free item whenever anything else on the plate
  // had calories — a photo of eggs and black coffee kept the eggs and lost the coffee. The meal
  // total stayed right, so nothing downstream complained, and the client's record simply stopped
  // containing a thing they ate. That is this cut's own defect committed by its own repair.
  const withFree = reconcileVisionMeal([
    "Boiled eggs (2): ~140 kcal, 12g protein",
    "Black coffee: ~0 kcal, 0g protein",
    "TOTAL: 140 kcal | 12g protein",
  ].join("\n"), 140, 12);
  chk(withFree.items.length === 2, "a zero-calorie photo item survives beside a priced one",
    JSON.stringify(withFree.items.map(i => i.name)));
  chk(withFree.items.some(i => /coffee/i.test(i.name) && i.kcal === 0),
    "…and it keeps its own zero, rather than being dropped or invented up",
    JSON.stringify(withFree.items));
  chk(withFree.kcalInt === 140 && withFree.items.reduce((s, i) => s + i.kcal, 0) === 140,
    "…while the meal total is unchanged and still equals the item sum", JSON.stringify(withFree));

  const { readFileSync } = await import("node:fs");
  const media = readFileSync("server/handlers/media.ts", "utf-8");
  const live = media.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const commits = (live.match(/commitFoodLog\(\{/g) || []).length;
  const reconciled = (live.match(/reconcileVisionMeal\(/g) || []).length;
  chk(commits > 0 && reconciled >= 4,
    "WIRING (source-graded): every photo write site reconciles before it commits",
    `commitFoodLog sites=${commits} reconcileVisionMeal calls=${reconciled}`);
  chk(!/kcalInt:\s*(?:kcal|prot|extraKcal|primaryPhotoKcal)\b/.test(live),
    "and no photo write still takes its total straight from the vision figure",
    `still raw: ${JSON.stringify((live.match(/kcalInt:\s*\w+/g) || []).slice(0, 6))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n8. A CORRECTION REPLACES — IT DOES NOT ADD");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE FIRST DIVERGENCE. On e53763b: "I had chicken and rice" (580) then "Actually it was two
// chicken breasts not one" left the day at 877 kcal. The client corrected their record and the
// coach ADDED 297 kcal to it. Both the word form and the digit form are graded — planCorrection
// returned isCorrection:false for the digits, so a client who types "2" and "1" got no correction
// at all, which is the same defect wearing different clothes.
// THREE PHRASINGS, MEASURED ON e53763b BEFORE THE CONTRACT BELOW WAS WRITTEN. The contract is
// derived from what the product does, not from what the repair happens to produce:
//
//   "two chicken breasts not one"                            580 -> 877   ADDED
//   "it wasn't one chicken breast, it was two chicken…"      297 -> 297   NO-OP
//   "it wasn't rice, it was pap"                             330          correct
//
// The identity axis works; the QUANTITY axis does not exist. Both failures share one cause —
// resolveFood priced every corrected-to food as one table portion — and the append additionally
// needed an unresolvable removal to be silently skipped.
{
  // 8a — THE QUANTITY AXIS. The food is named on both sides, so the removal resolves; only the
  // price of what replaces it was wrong. One breast is 297, so two must be ~594.
  const qty = await journey("correct-qty", [[13, "I had one chicken breast"], [14, "it wasn't one chicken breast, it was two chicken breasts"]]);
  ledgerHolds("correct-qty", qty.rows);
  const qtyTotal = qty.rows.reduce((s, r) => s + r.kcal_int, 0);
  chk(qtyTotal > 500 && qtyTotal < 700,
    "a quantity correction moves the day to TWO breasts, not one and not three",
    `total=${qtyTotal} items=${JSON.stringify(qty.rows.map(names))}`);
  chk(qty.total === qtyTotal, "users.today_calories agrees with the rows",
    `user=${qty.total} rows=${qtyTotal}`);

  // 8b — THE NAMED DEFECT'S OWN SENTENCE. This is the fixture that took the day to 877. It now
  // routes to the quantity owner (§8d), so what it must never do again is GROW the day.
  const add = await journey("correct-append", [[13, "I had chicken and rice"], [14, "Actually it was two chicken breasts not one"]]);
  ledgerHolds("correct-append", add.rows);
  const addTotal = add.rows.reduce((s, r) => s + r.kcal_int, 0);
  chk(addTotal <= 580,
    "a correction never ADDS to the day — the 877 append is gone",
    `total=${addTotal} items=${JSON.stringify(add.rows.map(names))}`);
  chk(add.total === addTotal, "users.today_calories agrees with the rows",
    `user=${add.total} rows=${addTotal}`);

  // AND A NO-OP IS NOT AN ANSWER EITHER (C11 review). `addTotal <= 580` alone greened the defect's
  // own sentence doing NOTHING — and measured, that is exactly what it did. "I had chicken and
  // rice" persists as ONE combo item (`Chicken and rice`, 580 kcal, 1 plate), so the correction's
  // food matches nothing and the client was told *"I don't see chicken breasts in today's log to
  // correct"* about the plate they had just logged. A band on the total cannot catch this: 580 is
  // the UNCORRECTED day, so any band wide enough to admit the corrected answer admits the no-op.
  //
  // The contract is therefore on the outcome, not the number: the sentence must either change the
  // stored plate, or ask against what is actually held. Widening the food match to force the first
  // arm would match the combo and scale the whole plate — 1160 kcal, rice doubled with the chicken
  // — so the honest arm here is the second one, and it is graded on the delivered body.
  // THE CORRECTION TURN'S OWN BODY, not the conversation's. Graded against the join first, this
  // assertion passed on the revert — because turn one's receipt ("Got it — Chicken and rice") had
  // already said the words, so the correction reply could name nothing and still green. The
  // red-on-revert case is what found it; a vacuous assertion is worse than an absent one.
  const addBody = add.bodies[add.bodies.length - 1] || "";
  chk(addTotal !== 580 || /chicken and rice/i.test(addBody),
    "the named 877 sentence either moves the plate or names what today actually holds",
    `total=${addTotal} body=${JSON.stringify(addBody.slice(-300))}`);
  chk(!/don'?t see .* in today'?s log to correct/i.test(addBody),
    "…and the client is never told their own logged plate does not exist",
    `body=${JSON.stringify(addBody.slice(-300))}`);

  // 8b' — A REMOVAL WE GENUINELY CANNOT PLACE. The client corrects away a food that is not on the
  // plate we hold. There is no honest replacement to make, so the day must not move AND the client
  // must be told — the same answer §6 requires for food we cannot price: ask, never guess. Without
  // the `unresolved` signal this wrote the addition alone, which is the append defect's mechanism
  // surviving in a phrasing the quantity owner does not claim.
  const unres = await journey("correct-unresolvable", [[13, "I had chicken and rice"], [14, "it wasn't beef, it was fish"]]);
  ledgerHolds("correct-unresolvable", unres.rows);
  const unresTotal = unres.rows.reduce((s, r) => s + r.kcal_int, 0);
  chk(unresTotal === 580, "the day is left exactly as it was — no half-applied correction",
    `total=${unresTotal} items=${JSON.stringify(unres.rows.map(names))}`);
  chk(/couldn'?t find|what it should be/i.test(unres.bodies.join("\n")),
    "and the client is told what we hold and asked what it should be",
    `body=${JSON.stringify(unres.bodies.join(" | ").slice(0, 300))}`);

  // 8d — THE SAME CLAIM, SPELLED FOUR WAYS. parseQuantityCorrection required digits and
  // planCorrection caught the rest, so one question had two owners split by nothing but spelling
  // — and the word path was the broken one. Every form must reach the same day.
  for (const [label, correction] of [
    ["digits, trailing", "Actually it was 2 chicken breasts not 1"],
    ["digits, comma", "2 chicken breasts, not 1"],
    ["words, identity grammar", "it wasn't one chicken breast, it was two chicken breasts"],
    ["digits, identity grammar", "it wasn't 1 chicken breast, it was 2 chicken breasts"],
  ] as const) {
    const j = await journey(`qform-${label.replace(/\W/g, "")}`, [[13, "I had one chicken breast"], [14, correction]]);
    ledgerHolds(`qform-${label}`, j.rows);
    const t = j.rows.reduce((s, r) => s + r.kcal_int, 0);
    chk(t > 500 && t < 700, `${label}: reaches the same two-breast day`,
      `total=${t} items=${JSON.stringify(j.rows.map(names))}`);
    chk(j.total === t, `${label}: users.today_calories agrees`, `user=${j.total} rows=${t}`);
  }

  // 8e — THE QUANTITY AUTHORITY, REACHED THROUGH THE IDENTITY PATH. Routing consolidation sends
  // bare quantity claims to parseQuantityCorrection, but resolveFood still prices every
  // corrected-TO food — and that food can carry a quantity of its own. This is the live seam where
  // bypassing adjustFoodsForSegment still costs the client half their calories: two breasts is
  // 594, one is 297, and before the repair this path always said 297.
  const idQty = await journey("correct-idqty", [[13, "I had rice"], [14, "it wasn't rice, it was two chicken breasts"]]);
  ledgerHolds("correct-idqty", idQty.rows);
  const idQtyTotal = idQty.rows.reduce((s, r) => s + r.kcal_int, 0);
  chk(idQtyTotal > 500 && idQtyTotal < 700,
    "a replacement that names a quantity is priced for that quantity",
    `total=${idQtyTotal} items=${JSON.stringify(idQty.rows.map(names))}`);
  chk(idQty.rows.some(r => (r.items || []).some(i => Number(i.quantity) === 2)),
    "…and the persisted item records the quantity it was priced for",
    JSON.stringify(idQty.rows.map(r => r.items)));

  // 8c — CONTROL: the identity axis still replaces. This one worked before the repair and must
  // keep working, or the fix has traded one broken axis for another.
  const ident = await journey("correct-identity", [[13, "I had rice"], [14, "it wasn't rice, it was pap"]]);
  ledgerHolds("correct-identity", ident.rows);
  const identNames = ident.rows.flatMap(names).join(" ").toLowerCase();
  chk(/pap/.test(identNames) && !/\brice\b/.test(identNames),
    "CONTROL: an identity correction still replaces the food",
    `items=${JSON.stringify(ident.rows.map(names))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n9. A ZERO-CALORIE LOG COUNTS AS LOGGED — EVERYWHERE, INCLUDING THE CARD");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The systemic sibling: `kcal > 0` used to mean "food was logged". A row is a row.
{
  await clear();
  const un = freezeSast(13);
  try {
    const at = new RealDate(RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], 7, 0, 0));
    await pool.query(
      `INSERT INTO meal_logs (user_id, raw_message, kcal_int, protein_int, logged_at, meal_label, source, items)
       VALUES ($1, $2, 0, 0, $3, NULL, 'text', $4::jsonb)`,
      [user.id, "a glass of water", at, JSON.stringify([{ name: "Water", grams: 250, kcal: 0, protein: 0 }])]);
    await processTextAsync(phone, "progress", null, null, [], handleMessage as any, "c11-zero-card");
    await settle();
  } finally { un(); }
  const body = (await wire()).join("\n");
  const rs = await rows();
  chk(rs.length === 1 && rs[0].kcal_int === 0, "the day holds one row worth zero calories",
    `rows=${JSON.stringify(rs.map(r => r.kcal_int))}`);
  chk(!/nothing logged yet/i.test(body),
    "the progress card does not call a logged day empty",
    `body=${JSON.stringify(body.slice(0, 260))}`);
  // THE CARD MUST NOT CONTRADICT ITSELF EITHER. Before the repair it printed "Today: nothing
  // logged yet" directly above "Food logged: 1/7 days" — two adjacent lines disagreeing about the
  // same day, which is the defect its own comment records being fixed once before.
  chk(!(/nothing logged yet/i.test(body) && /Food logged:\s*\*[1-9]/i.test(body)),
    "…and does not print both \"nothing logged\" and a logged-day count",
    `body=${JSON.stringify(body.slice(0, 260))}`);

  // AND THE COACH'S OWN DECISION AGREES. The card is one surface; the ladder is the one that
  // chooses what to say next, and it read the same calorie total. A zero-calorie day that still
  // asks the client to report the food they already sent is the same defect one surface over.
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const un2 = freezeSast(13);
  try { await processTextAsync(phone, "What should I have for dinner tonight?", null, null, [], handleMessage as any, "c11-zero-coach"); await settle(); }
  finally { un2(); }
  const coachBody = (await wire()).join("\n");
  chk(!/\btell me what you ate today\b/i.test(coachBody),
    "the Coach does not ask for food the zero-calorie day already holds",
    `body=${JSON.stringify(coachBody.slice(0, 300))}`);
  chk((await rows()).length === 1,
    "and the question wrote nothing of its own", `rows=${(await rows()).length}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n10. THE PERSISTED ITEM EXPLAINS ITS OWN CALORIES");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The ledger is the items, so an item that states 440 kcal and cannot say how it got there is a
// number nobody can check, reproduce or correct. This grades the LOGGING path's provenance —
// §8e grades the correction path's — because they are different writers and a repair to one says
// nothing about the other.
{
  const j = await journey("provenance", [[13, "I had 2 cups cooked rice"]]);
  ledgerHolds("provenance", j.rows);
  const it: any = (j.rows[0]?.items || [])[0] || {};
  chk(j.rows.length === 1 && !!it.name, "the plate is stored", JSON.stringify(j.rows.map(r => r.items)));
  chk(Number(it.quantity) === 2, "the item records HOW MUCH — two, not one", `quantity=${it.quantity}`);
  chk(String(it.unit || "").toLowerCase() === "cups", "…in the client's own unit", `unit=${JSON.stringify(it.unit)}`);
  chk(it.portionSource === "explicit", "…and that the client stated it rather than us guessing",
    `portionSource=${JSON.stringify(it.portionSource)}`);
  chk(/2 cups/i.test(String(it.portionDescription || "")),
    "…against a portion description scaled to what they said", `desc=${JSON.stringify(it.portionDescription)}`);
  chk(it.basis === "cooked" && it.canonicalBasis === "cooked",
    "…on the preparation basis both sides agree on", `basis=${it.basis}/${it.canonicalBasis}`);
  chk(Number(it.grams) === 400 && Number(it.kcal) === 440,
    "…and the grams and calories that follow from all of it", `grams=${it.grams} kcal=${it.kcal}`);

  // A GUESS MUST SAY IT IS ONE. The same fields on a plate where the client stated no amount: the
  // value of portionSource is that "default" and "explicit" are distinguishable afterwards.
  const g = await journey("provenance-default", [[13, "I had rice"]]);
  const gi: any = (g.rows[0]?.items || [])[0] || {};
  chk(gi.portionSource === "default", "an unstated amount is recorded as a default, not as fact",
    `portionSource=${JSON.stringify(gi.portionSource)}`);
  chk(Number(gi.quantity) === 1 && gi.unit === null,
    "…with no unit invented for words the client never said", `quantity=${gi.quantity} unit=${JSON.stringify(gi.unit)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n11. WHAT REVIEW FOUND — the defects this cut shipped, widened, or left standing");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Five findings from the review of 66a4443. Each was reproduced before it was repaired, and two
// of them were this cut's OWN doing. They are graded here rather than in the sections above
// because what they have in common is their provenance, and a reader who wants to know whether
// review's findings are actually closed should be able to read that in one place.

// ── 11a — A WEIGHT IS AN AMOUNT OF FOOD, NOT A COUNT OF SERVINGS ────────────────────────────
// "100 grams rice" divided 100 by the portion's serving count and logged ONE HUNDRED portions:
// 22,000 kcal, stamped as database-verified. Measured on e53763b, so the bug predates this cut —
// but this cut WIDENED it, because admitting a preparation word between the unit and the food
// pulled "100 grams cooked rice" (220 kcal on e53763b) into the same branch. Both forms below.
{
  const w = await journey("weight-grams", [[13, "I had 200 grams of chicken breast"]]);
  ledgerHolds("weight-grams", w.rows);
  const wi: any = (w.rows[0]?.items || [])[0] || {};
  chk(w.rows.length === 1 && Number(wi.grams) === 200,
    "the persisted grams ARE the weight the client stated", `grams=${wi.grams} rows=${w.rows.length}`);
  chk(w.total > 250 && w.total < 400,
    "…and the calories are one portion's worth of it, not two hundred portions", `total=${w.total}`);

  const kg = await journey("weight-kg", [[13, "I had 1 kg of chicken breast"]]);
  ledgerHolds("weight-kg", kg.rows);
  chk(Number(((kg.rows[0]?.items || [])[0] as any)?.grams) === 1000 && kg.total > 1400 && kg.total < 1900,
    "a kilogram converts to a kilogram, not to a thousand servings",
    `total=${kg.total} items=${JSON.stringify(kg.rows.map(r => r.items))}`);

  const prep = await journey("weight-prep", [[13, "I had 100 grams cooked rice"]]);
  ledgerHolds("weight-prep", prep.rows);
  const pi: any = (prep.rows[0]?.items || [])[0] || {};
  chk(prep.rows.length === 1 && Number(pi.grams) === 100 && prep.total > 60 && prep.total < 200,
    "the phrasing this cut widened into the bug is priced as 100g of rice",
    `total=${prep.total} items=${JSON.stringify(prep.rows.map(r => r.items))}`);

  // CONTROL: a unit with no fixed size is nobody's weight. "Cup", "plate" and "spoon" must keep
  // going to classifyPortionUnit — the owner that knows a cup of rice is a portion of rice — or
  // the repair has traded a catastrophic over-count for a silent under-count.
  const cups = await journey("weight-control-cups", [[13, "I had 2 cups of rice"]]);
  ledgerHolds("weight-control-cups", cups.rows);
  const ci: any = (cups.rows[0]?.items || [])[0] || {};
  chk(Number(ci.quantity) === 2 && Number(ci.grams) === 400 && cups.total === 440,
    "CONTROL: two cups of rice is still two portions of rice, untouched by the weight path",
    `total=${cups.total} items=${JSON.stringify(cups.rows.map(r => r.items))}`);
}

// ── 11b — A LINE WE COULD NOT PARSE IS FOOD WE MAY NOT DELETE ───────────────────────────────
// The reconciler's grammar is strict, so one reply can hold a line it reads and a line it does
// not. Taking the item sum unconditionally persisted only the line we could read and dropped the
// rest, under-counting the client's day by exactly the food we failed to parse.
{
  const { reconcileVisionMeal } = await import("../server/serving-units");
  const partial = reconcileVisionMeal([
    "Chicken breast (180g): ~300 kcal, 56g protein",
    "Rice: about 250 calories",                    // real phrasing, outside the grammar
    "TOTAL: 550 kcal | 61g protein",
  ].join("\n"), 550, 61);
  const psum = partial.items.reduce((s, i) => s + i.kcal, 0);
  chk(partial.kcalInt === 550 && psum === 550,
    "the unread food survives as its own item, and the ledger still balances",
    JSON.stringify(partial));
  chk(partial.items.length === 2 && partial.items.some(i => i.kcal === 250),
    "…carrying exactly the shortfall the model's own total says is missing",
    JSON.stringify(partial.items));

  // CONTROL: a shortfall with EVERY line read is the model's arithmetic, not lost food. This is
  // the distinction the repair turns on — without it the reconciler would answer §7's fixture by
  // inventing 283 kcal of "other items" that the model never claimed were on the plate.
  const arith = reconcileVisionMeal([
    "Chicken breast (180g): ~297 kcal, 56g protein",
    "Rice (200g): ~220 kcal, 5g protein",
    "TOTAL: 800 kcal | 70g protein",
  ].join("\n"), 800, 70);
  chk(arith.kcalInt === 517 && arith.items.length === 2,
    "CONTROL: a disagreeing total whose every line we read invents nothing", JSON.stringify(arith));

  // CONTROL: a total BELOW the item sum is the model's arithmetic being wrong, not an item being
  // missing. There the parsed items stand and nothing is invented to make the numbers meet.
  const over = reconcileVisionMeal([
    "Chicken breast (180g): ~297 kcal, 56g protein",
    "Rice (200g): ~220 kcal, 5g protein",
    "TOTAL: 300 kcal | 70g protein",
  ].join("\n"), 300, 70);
  chk(over.kcalInt === 517 && over.items.length === 2,
    "CONTROL: a model total below its own items adds no phantom item", JSON.stringify(over));
}

// ── 11c — A PHOTO ITEM SAYS WHERE IT CAME FROM ──────────────────────────────────────────────
// summariseProvenance reads `origin` and defaults a missing one to "unknown". Giving the photo
// path items without tagging them turned a formerly-classifiable row into an unknown one, and at
// half the day unknown the food confidence drops to "insufficient" — so this cut's own repair
// would have degraded the confidence of every photo meal it fixed.
{
  const { reconcileVisionMeal, itemsFromVisionText } = await import("../server/serving-units");
  const parsed = itemsFromVisionText("Chicken breast (180g): ~297 kcal, 56g protein");
  chk(parsed.length === 1 && parsed[0].origin === "photo",
    "a parsed vision item records that a photo is where its number came from", JSON.stringify(parsed));
  const bare = reconcileVisionMeal("TOTAL: 640 kcal | 41g protein", 640, 41);
  const short = reconcileVisionMeal(
    "Chicken breast (180g): ~300 kcal, 56g protein\nRice: about 250 calories\nTOTAL: 550 kcal", 550, 61);
  chk(short.items.length === 2 && bare.items.length === 1
    && bare.items.every(i => i.origin === "photo") && short.items.every(i => i.origin === "photo"),
    "…and so does every item the reconciler synthesises for it",
    JSON.stringify([bare.items, short.items]));
}

// ── 11d — A CORRECTED COUNT RESCALES THE EVIDENCE, NOT ONLY THE CALORIES ────────────────────
// The quantity-correction path scaled kcal and protein and wrote everything else back untouched,
// so after "two chicken breasts not one" the row held TWO breasts' calories while still stating
// quantity 1 and one breast's grams. That is the exact contradiction C11's provenance fields
// exist to make impossible: the row can no longer explain the number it shows.
{
  const c = await journey("correct-provenance", [[13, "I had one chicken breast"], [14, "Actually it was two chicken breasts not one"]]);
  ledgerHolds("correct-provenance", c.rows);
  const all = c.rows.flatMap(r => (Array.isArray(r.items) ? r.items : []) as any[]);
  const br = all.find(i => /breast/i.test(String(i.name || "")));
  chk(!!br, "the corrected food is still on the plate", JSON.stringify(c.rows.map(r => r.items)));
  if (br) {
    chk(Number(br.quantity) === 2,
      "the item states the count the client corrected it to", `quantity=${br.quantity}`);
    chk(Number(br.grams) === 360,
      "…the grams that follow from that count", `grams=${br.grams}`);
    chk(/\b2\b/.test(String(br.portionDescription || "")),
      "…and a portion description that describes the same amount",
      `desc=${JSON.stringify(br.portionDescription)}`);
    chk(Number(br.kcal) > 500 && Number(br.kcal) < 700,
      "…all of it beside the calories it already got right", `kcal=${br.kcal}`);
  }
}

// ── 11e — A PREPARATION WORD BELONGS TO THE FOOD IT IS ATTACHED TO ──────────────────────────
// One basis was read per segment and copied onto every food in it, so "cooked rice and raw
// chicken thigh" recorded BOTH as cooked. The chicken's item then claimed a preparation the
// client never made about it, and basisConflict — which reads exactly that field — could no
// longer see the raw chicken at all.
{
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
  const { adjustFoodsForSegment, basisConflict } = await import("../server/portion-memory");
  const mixed = "cooked rice and raw chicken thigh";
  const adj: any[] = adjustFoodsForSegment(scanForSAFoods(mixed) as any, mixed) as any;
  const rice = adj.find(f => /rice/i.test(f.name));
  const thigh = adj.find(f => /thigh/i.test(f.name));
  chk(!!rice && !!thigh, "both foods are found", JSON.stringify(adj.map(f => f.name)));
  chk(rice?.statedBasis === "cooked" && thigh?.statedBasis === "raw",
    "each food carries the basis the client stated about IT",
    JSON.stringify(adj.map(f => [f.name, f.statedBasis])));
  chk(/thigh/i.test(String(basisConflict(adj)?.name || "")),
    "…so the raw food priced as cooked is the one we would ask about",
    JSON.stringify(basisConflict(adj)?.name));

  // A basis that cannot be attached to any food is not assigned to one. Two foods, one loose
  // preparation word: whichever the client meant, guessing writes a claim they did not make.
  const loose = "I had rice and chicken breast, both cooked";
  const la: any[] = adjustFoodsForSegment(scanForSAFoods(loose) as any, loose) as any;
  chk(la.every(f => f.statedBasis === null),
    "an unattached word in a two-food sentence is recorded as no basis at all",
    JSON.stringify(la.map(f => [f.name, f.statedBasis])));

  // CONTROL: one food, one preparation word — still read, whichever side of the food it sits.
  for (const [label, text] of [["before", "I had 2 cups cooked rice"], ["after", "I had rice, cooked"]] as const) {
    const a: any[] = adjustFoodsForSegment(scanForSAFoods(text) as any, text) as any;
    chk(a.length > 0 && a.every(f => f.statedBasis === "cooked"),
      `CONTROL: a single food still takes its own basis (${label})`,
      JSON.stringify(a.map(f => [f.name, f.statedBasis])));
  }
}

REAL(`\n${failed === 0 ? "pg-food-calorie-truth-acceptance: GREEN" : `pg-food-calorie-truth-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
