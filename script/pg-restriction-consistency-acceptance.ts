/**
 * REAL-POSTGRESQL ACCEPTANCE — one restriction, every surface (#220).
 *
 * THE RULE THIS ENFORCES. The same CURRENT restriction controls every customer-facing surface.
 * A client cannot be vegan in canonical memory while groceries, meal suggestions, proactive food
 * coaching or the model's own context still behave omnivorous — and a restriction they RETRACTED
 * must stop suppressing food everywhere, in the same breath.
 *
 * Four divergence shapes were traced through the real front door on main@2cb48c1 before anything
 * changed. Every fix below closes one of them, and each is named at its own check:
 *
 *   A · A SECOND STORE.   onboarding-meal-plan.ts read `diet:` flags out of profileNotes and
 *                         allergies out of otherMedicalNotes, never users.dietary_restrictions.
 *                         A vegan whose fact sat in the canonical column — where recordClientFacts
 *                         writes it and where every other food mouth reads it — asked for
 *                         "7 day meals" and got chicken thigh, boiled eggs, pilchards, low fat
 *                         yoghurt and beef mince, with no vegan line in the header at all.
 *
 *   B · NO CONSULTATION.  The protein-target answer was fixed prose ("Best SA sources: eggs,
 *                         pilchards, chicken breast, tinned tuna") with no constraint read of any
 *                         kind. buildClientSnapshot — the whole picture handed to the model —
 *                         read users.food_dislikes raw and nothing else, so "vegan" appeared
 *                         nowhere in it. topUpsForDay had no constraint parameter.
 *
 *   C · A FALLBACK PAST IT. meal-plan.ts filtered its pools correctly and then, when the filter
 *                         emptied one, served the UNFILTERED pool: `safeProteinDays.length > 0 ?
 *                         safeProteinDays : proteinDayPool`. A vegan received chicken breast,
 *                         lean mince, hake and rump steak under a header reading "· Vegan". Its
 *                         verifier caught this exactly right — "CRITICAL: vegan plan contains
 *                         animal products" — and had no mouth, only a console.warn.
 *
 *   D · HONOURED BY DELETION. getShoppingList filtered correctly and shipped the wreckage: for a
 *                         vegan the entire protein category vanished, "*Meal ideas to mix it up:*"
 *                         printed with nothing under it, and the message still opened "a solid,
 *                         quality base for your goal" and promised 150g of protein.
 *
 * WHY POSTGRESQL AND THE REAL FRONT DOOR. Consistency is a claim about what a CLIENT receives
 * across surfaces that are reached by different handlers, different jobs and different cron
 * minutes. A unit test on `allows` proves the predicate; it cannot prove that the grocery list,
 * the meal plan, the protein answer, the Sunday send and the model's context all asked it.
 * SHADOW=on routes every outbound into shadow_replies, so the proactive surfaces are graded on
 * the MESSAGE a client would have received rather than on the decision behind it.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "No chicken in the reply" is trivially satisfied by a
 * coach that stopped naming food, or that suppresses chicken for everyone — both of which are the
 * opposite defect. So each restricted client is checked beside an UNRESTRICTED one on the same
 * surface, the retracted client is checked for the restriction actually lifting, and a client
 * with a mere dislike is checked for NOT being treated as a hard diet.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-restriction-consistency-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const { eq } = await import("drizzle-orm");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { buildClientSnapshot } = await import("../server/brain/client-snapshot");
const { runSundayMealPlan, runSundayWeeklyReport } = await import("../server/scheduler/jobs/weekly");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

/**
 * FOODS A VEGAN MUST NEVER BE OFFERED. The lookbehind is not decoration: "soya mince", "soya
 * milk" and "soya yoghurt" are the vegan SUBSTITUTES named after what they replace, and a
 * detector without it fails this suite on correct output — it did, on the first trace run.
 */
const ANIMAL = /(?<!soya |soy |veggie |vegan |plant )\b(chicken|beef|mince|steak|pilchards?|tuna|hake|fish|eggs?|biltong|wors|boerewors|lamb|pork|mutton|yoghurts?|milk|cheese|amasi|maas)\b/i;
const DAIRY = /(?<!soya |soy |almond |oat |coconut )\b(milk|cheese|yoghurts?|yogurts?|amasi|maas|cream)\b/i;
const PEANUT = /\bpeanuts?\b|\bgroundnuts?\b/i;
/** Tree nuts, which a PEANUT allergy must NOT suppress — the exactness half of the allergy case. */
const TREE_NUT = /\b(almonds?|cashews?|mixed nuts|walnuts?)\b/i;

/**
 * THE PART OF A REPLY THAT RECOMMENDS FOOD, with the part that merely NAMES the restriction back
 * removed.
 *
 * Saying the constraint out loud is the correct behaviour, not a leak: "🚫 Left off — you told
 * me: broccoli", "⚠️ Medical: Peanut allergy — PB removed" and the plan header's "· Fish-free"
 * are the coach proving it listened, and so is "I can't build you a plan that respects vegan,
 * tofu, lentils, beans". A detector that cannot tell those from an instruction to eat marks
 * correct output as a violation — this suite did exactly that on its first run, on all four of
 * them. Everything else in the message is fair game.
 */
function body(reply: string): string {
  return reply.split("\n")
    .filter(l => !/you told me:|left off|⚠️ *Medical:|does not eat:|allergy|can'?t build a plan|can'?t build you a plan/i.test(l))
    .join("\n")
    .replace(/\b(fish|dairy|gluten|peanut)-free\b/gi, "");
}

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];

async function client(name: string, over: Record<string, any> = {}) {
  const phone = `whatsapp:+2793${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    weeklyFoodBudget: "300_600", totalWorkoutsCompleted: 12,
    createdAt: D(60), programmeStartDate: D(60), programmeWeek: 4, lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  await pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     SELECT $1, now() - (d || ' days')::interval, 'lunch', 600, 40, $2, 'seed', 'sa_scanner'
       FROM generate_series(1, 6) AS d`,
    [u.id, JSON.stringify([{ name: "pap", grams: 200 }])]);
  await pool.query(
    `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
     SELECT $1, 'pap and beans', 'ok', 'FOOD_LOG', now() - (d || ' days')::interval
       FROM generate_series(1, 6) AS d`, [u.id]);
  return { id: u.id, phone };
}

const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

/** Everything a proactive job sent this client, as one blob. */
async function proactive(id: string, job: () => Promise<void>): Promise<string> {
  await pool.query("DELETE FROM shadow_replies");
  await pool.query("DELETE FROM daily_sends").catch(() => {});
  await job().catch(() => {});
  const { rows } = await pool.query("SELECT body FROM shadow_replies WHERE user_id = $1 ORDER BY id", [id]);
  return rows.map((r: any) => String(r.body)).join("\n---\n");
}

/** The four reactive food surfaces a client can type their way to. */
const FOOD_DOORS: Array<[string, string]> = [
  ["meal plan", "meal plan"],
  ["grocery list", "grocery list"],
  ["protein target", "protein"],
  ["7 day meals", "7 day meals"],
];

REAL("\n=== A · THE CANONICAL COLUMN ALONE MUST CONTROL EVERY SURFACE ===");
REAL("    (no profileNotes `diet:` flag, no otherMedicalNotes — only users.dietary_restrictions,");
REAL("     which is the column recordClientFacts writes when a client says 'I'm vegan'.)");
{
  const vegan = await client("Vegan", { dietaryRestrictions: "vegan" });
  const omni = await client("Omni");
  for (const [label, text] of FOOD_DOORS) {
    const restricted = await ask(vegan.phone, text);
    const control = await ask(omni.phone, text);
    chk(!ANIMAL.test(body(restricted)), `${label}: a vegan is offered no animal food`,
      `${(body(restricted).match(new RegExp(ANIMAL.source, "gi")) || []).join(", ")}\n          ${JSON.stringify(restricted.slice(0, 400))}`);
    // THE CONTROL. Silence and blanket suppression both satisfy the line above.
    chk(ANIMAL.test(body(control)), `CONTROL: ${label} still names real protein for a client with no restriction`,
      JSON.stringify(control.slice(0, 300)));
    chk(restricted.length > 200, `…and the vegan's ${label} is a real answer, not a shrug`,
      `${restricted.length} chars: ${JSON.stringify(restricted.slice(0, 200))}`);
  }
}

REAL("\n=== B · THE RESTRICTION REACHES THE MODEL'S OWN CONTEXT ===");
{
  const vegan = await client("VeganPrompt", { dietaryRestrictions: "vegan" });
  const omni = await client("OmniPrompt");
  const [vu] = await db.select().from(schema.users).where(eq(schema.users.id, vegan.id)).limit(1);
  const [ou] = await db.select().from(schema.users).where(eq(schema.users.id, omni.id)).limit(1);
  const snap = await buildClientSnapshot(vu as any);
  const snapOmni = await buildClientSnapshot(ou as any);
  chk(/vegan/i.test(snap), "the snapshot handed to the model says the client is vegan",
    JSON.stringify(snap.slice(0, 400)));
  chk(/does not eat/i.test(snap), "…in the same sentence every other food mouth is given",
    JSON.stringify((snap.match(/[^\n]*does not eat[^\n]*/i) || ["(absent)"])[0]));
  // THE CONTROL. A line that appears for everybody carries no information.
  chk(!/does not eat/i.test(snapOmni), "CONTROL: a client who declared nothing gets no restriction line",
    JSON.stringify((snapOmni.match(/[^\n]*does not eat[^\n]*/i) || [""])[0]));
}

REAL("\n=== C · THE PLAN MAY NOT FALL BACK PAST THE RESTRICTION ===");
REAL("    (premium tier: every stock protein day and breakfast is animal, so this is the exact");
REAL("     shape that used to empty the filter and serve the unfiltered pool.)");
{
  const vegan = await client("VeganPlan", { dietaryRestrictions: "vegan", weeklyFoodBudget: "300_600" });
  const plan = await ask(vegan.phone, "meal plan");
  chk(!ANIMAL.test(body(plan)), "the 3-day plan names no animal food anywhere — meals, cook notes or top-ups",
    `${(body(plan).match(new RegExp(ANIMAL.source, "gi")) || []).join(", ")}`);
  // NAMED SEPARATELY because it is the LAST thing appended to the plate, after every pool filter
  // has run — the one place a compliant plan could still pick up a forbidden food.
  const topUp = (plan.match(/Extra to hit your target:[^\n]*/i) || [""])[0];
  chk(!ANIMAL.test(topUp), "…including the top-up appended after the pools were filtered",
    JSON.stringify(topUp));
  chk(/vegan/i.test(plan), "…and still declares the restriction it is built around",
    JSON.stringify(plan.slice(0, 160)));
  chk(/day 2/i.test(plan) && /day 3/i.test(plan), "…and is still three days, not a stub",
    JSON.stringify(plan.slice(0, 200)));
  // THE VERIFIER'S OWN FINDING, now client-visible instead of console-only: the plan-check note
  // is a recommendation and must obey the same constraint the plan does.
  const note = (plan.match(/Plan check:[^_]*/i) || [""])[0];
  chk(!ANIMAL.test(note), "…and the verifier's own plan-check note recommends no animal food",
    JSON.stringify(note));

  // THE FALLBACK ITSELF, reached. Adding plant-based days to the pools means the vegan case above
  // no longer empties the filter — so it no longer exercises `length > 0 ? filtered : pool`, and a
  // mechanism nothing can reach is a mechanism nothing is testing. This client's own literal
  // exclusions do empty it: every remaining plant day names tofu, lentils or beans. The old code
  // served the unfiltered pool here; the honest answer is to say we cannot build it.
  const cornered = await client("Cornered", {
    dietaryRestrictions: "vegan, tofu, lentils, beans", weeklyFoodBudget: "300_600" });
  const refused = await ask(cornered.phone, "meal plan");
  chk(!ANIMAL.test(body(refused)) && !/tofu|lentil|bean/i.test(body(refused)),
    "a filter that leaves NOTHING produces no plan rather than a forbidden one",
    (body(refused).match(new RegExp(ANIMAL.source, "gi")) || []).join(", ") + " :: " + JSON.stringify(refused.slice(0, 300)));
  chk(/can't build|cannot build/i.test(refused) && /vegan/i.test(refused),
    "…and says so in their own terms, with a way forward",
    JSON.stringify(refused.slice(0, 300)));

  // THE CONTROL, on the same tier: the pool must not have been emptied for everyone.
  const omni = await client("OmniPlan", { weeklyFoodBudget: "300_600" });
  const control = await ask(omni.phone, "meal plan");
  chk(/chicken|mince|steak|hake|pilchard/i.test(control),
    "CONTROL: the premium plan still rotates real meat for a client with no restriction",
    JSON.stringify(control.slice(0, 300)));
}

REAL("\n=== D · HONOURING A RESTRICTION IS NOT DELETING THE ANSWER ===");
{
  const vegan = await client("VeganShop", { dietaryRestrictions: "vegan" });
  const list = await ask(vegan.phone, "grocery list");
  chk(!ANIMAL.test(body(list)), "the grocery list offers no animal food",
    (body(list).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));
  chk(/🥩 Protein:/.test(list), "…and still HAS a protein section", JSON.stringify(list.slice(0, 500)));
  chk(/beans|lentils|tofu|soya/i.test(list), "…stocked with protein this client can actually buy",
    JSON.stringify((list.match(/\*🥩 Protein:\*[^*]*/) || ["(none)"])[0]));
  // The hollow-list signature: a heading printed over nothing.
  chk(!/\*Meal ideas to mix it up:\*\s*(\n\s*)*$|\*Meal ideas to mix it up:\*\s*\n\s*\n/.test(list),
    "…and no section heading is printed with nothing under it",
    JSON.stringify(list.slice(list.indexOf("Meal ideas"), list.indexOf("Meal ideas") + 200)));
  // The avoid list is an instruction to buy, too: "plain or Greek only" reached a dairy-free
  // client six lines under "Left off — you told me: no dairy".
  const noDairy = await client("NoDairy", { dietaryRestrictions: "dairy" });
  const dairyList = await ask(noDairy.phone, "grocery list");
  const shelf = (dairyList.match(/Leave these on the shelf:[\s\S]*?(?=\n\n|$)/) || [""])[0];
  chk(!DAIRY.test(shelf), "the `leave these on the shelf` block recommends no dairy to a dairy-free client",
    JSON.stringify(shelf));
  chk(!DAIRY.test(body(dairyList)), "…and neither does the rest of their list",
    (body(dairyList).match(new RegExp(DAIRY.source, "gi")) || []).join(", "));
  // THE CONTROL. The block must still exist for everyone else — it is real coaching.
  const omni = await client("OmniShop");
  const omniList = await ask(omni.phone, "grocery list");
  chk(/Flavoured yoghurt/i.test(omniList),
    "CONTROL: the shelf block is intact for a client with no restriction", JSON.stringify(omniList.slice(-600)));
  chk(/🥩 Protein:/.test(omniList) && /chicken|eggs|mince/i.test(omniList),
    "CONTROL: …and their protein section is untouched", JSON.stringify(omniList.slice(0, 400)));
}

REAL("\n=== E · EXACT ALLERGY: PEANUTS IS NOT ALL NUTS ===");
{
  const p = await client("PeanutAllergy", { dietaryRestrictions: "peanuts" });
  for (const [label, text] of FOOD_DOORS) {
    const reply = await ask(p.phone, text);
    chk(!PEANUT.test(body(reply)),
      `${label}: a peanut allergy removes peanuts and groundnuts`,
      JSON.stringify(reply.slice(0, 300)));
  }
  // EXACTNESS IS THE CLAIM, not suppression. A peanut allergy is not a tree-nut allergy, and
  // widening it would take almonds and cashews off the plate of someone who can eat them.
  const plan = await ask(p.phone, "meal plan");
  chk(/chicken|mince|eggs|pilchard|steak|hake/i.test(plan),
    "CONTROL: a peanut allergy suppresses nothing else — meat and eggs stay",
    JSON.stringify(plan.slice(0, 300)));
  const { foodConstraints } = await import("../server/food-swaps");
  const c = foodConstraints({ dietaryRestrictions: "peanuts" });
  chk(TREE_NUT.test("almonds") && c.allows("almonds") && c.allows("mixed nuts") && c.allows("cashews"),
    "CONTROL: …and tree nuts are still allowed — `peanuts` does not silently become `nuts`");
  chk(!c.allows("peanut butter") && !c.allows("groundnuts"),
    "…while the peanut cluster itself is complete (peanut butter, groundnuts)");
}

REAL("\n=== F · THE SAME RESTRICTION IN PROACTIVE FOOD COACHING ===");
REAL("    (graded on the MESSAGE in shadow_replies, not on the decision behind it.)");
{
  const vegan = await client("VeganProactive", { dietaryRestrictions: "vegan" });
  const plan = await proactive(vegan.id, runSundayMealPlan);
  chk(plan.length > 0, "the Sunday meal plan actually sends", `body: ${JSON.stringify(plan.slice(0, 120))}`);
  chk(!ANIMAL.test(body(plan)), "…and the proactive plan names no animal food",
    (body(plan).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));

  const report = await proactive(vegan.id, runSundayWeeklyReport);
  chk(report.length > 0, "the Sunday weekly report actually sends");
  chk(!ANIMAL.test(body(report)), "…and the grocery list it carries names no animal food",
    (body(report).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));

  // THE CONTROL. Proactive food coaching must not have gone quiet or plant-only for everyone.
  const omni = await client("OmniProactive");
  const control = await proactive(omni.id, runSundayMealPlan);
  chk(ANIMAL.test(body(control)), "CONTROL: the same proactive job still names meat for an unrestricted client",
    JSON.stringify(control.slice(0, 300)));
}

REAL("\n=== G · A RETRACTED RESTRICTION STOPS SUPPRESSING FOOD, EVERYWHERE ===");
{
  const c = await client("WasVegan", { dietaryRestrictions: "vegan" });
  const before = await ask(c.phone, "meal plan");
  chk(!ANIMAL.test(body(before)), "while vegan, the plan is plant-based",
    (body(before).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));

  await ask(c.phone, "I'm not vegan anymore");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  chk(!/vegan/i.test(String((u as any).dietaryRestrictions || "")),
    "the retraction clears the canonical column",
    `column=${JSON.stringify((u as any).dietaryRestrictions)} notes=${JSON.stringify((u as any).profileNotes)}`);
  chk(!/diet:vegan/i.test(String((u as any).profileNotes || "")),
    "…and leaves no `diet:vegan` flag behind in profileNotes to out-live it (#211)",
    JSON.stringify((u as any).profileNotes));

  for (const [label, text] of FOOD_DOORS) {
    const after = await ask(c.phone, text);
    chk(ANIMAL.test(body(after)), `${label}: animal food returns after the retraction`,
      JSON.stringify(after.slice(0, 300)));
  }
}

REAL("\n=== H · SAME TURN: THE FACT AND THE QUESTION ARRIVE TOGETHER ===");
{
  const c = await client("SameTurn");
  const reply = await ask(c.phone, "I'm vegan now, what should I eat?");
  chk(!ANIMAL.test(body(reply)), "a restriction stated in the same breath already governs the answer",
    `${(body(reply).match(new RegExp(ANIMAL.source, "gi")) || []).join(", ")}\n          ${JSON.stringify(reply.slice(0, 300))}`);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  chk(/vegan/i.test(String((u as any).dietaryRestrictions || "")),
    "…and it is durable, not just honoured for one turn",
    JSON.stringify((u as any).dietaryRestrictions));
  const next = await ask(c.phone, "grocery list");
  chk(!ANIMAL.test(body(next)), "…so the next surface obeys it too",
    (body(next).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));
}

REAL("\n=== I · NEGATIVE CONTROL: A PREFERENCE IS NOT A DIET ===");
{
  const c = await client("Dislikes", { foodDislikes: "broccoli" });
  for (const [label, text] of FOOD_DOORS) {
    const reply = await ask(c.phone, text);
    chk(ANIMAL.test(body(reply)), `${label}: one named dislike does not turn the client vegan`,
      JSON.stringify(reply.slice(0, 250)));
    chk(!/broccoli/i.test(body(reply)), `…while the disliked food itself is still left out of ${label}`,
      JSON.stringify((reply.match(/[^\n]*broccoli[^\n]*/i) || [""])[0]));
  }
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  const snap = await buildClientSnapshot(u as any);
  chk(/broccoli/i.test(snap), "…and the model is told about it rather than the fact being lost",
    JSON.stringify((snap.match(/[^\n]*broccoli[^\n]*/i) || ["(absent)"])[0]));
  chk(!/vegan|vegetarian/i.test(snap), "…without the model being told they follow a diet they never named",
    JSON.stringify((snap.match(/[^\n]*veg[ae]/i) || [""])[0]));
}

REAL(`\n${failed === 0
  ? "pg-restriction-consistency-acceptance: GREEN — all checks passed"
  : `pg-restriction-consistency-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs",
                   "chat_history", "turn_ledger", "shadow_replies", "daily_sends"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);
