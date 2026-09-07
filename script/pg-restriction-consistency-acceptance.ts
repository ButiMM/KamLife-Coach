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

REAL("\n=== J · THE LITERAL FOODS THEY NAMED, ON THE FIXED TEMPLATE ===");
REAL("    (CTO GATE P1-1 and P1-2 on PR #222, and their mandatory controls.)");
{
  // A CLUSTER BOOLEAN IS NOT THE WHOLE CONSTRAINT. foodConstraints also records the literal foods
  // a client named, `c.allows` rejects them, and every other surface obeys — the 3-day plan came
  // back clean for these clients while the 7-day template recommended eggs on six mornings and
  // lentils in eight lines, because it copied the booleans and never asked the predicate.
  //
  // THE SLOT ROTATES BEFORE IT REFUSES. Each meal is chosen from a seven-candidate array whose
  // line carries a FIXED protein figure, so swapping candidates inside one array changes no number
  // and invents no food. Refusing while a compliant option sits one index away would be honouring
  // the constraint by giving up, which is the same failure as the hollow grocery list.

  // P1-1 control 1 — the ordinary client is untouched.
  const plain = await client("Sipho");
  const plainPlan = await ask(plain.phone, "7 day meals");
  chk(!/can't build/i.test(plainPlan) && /Monday/.test(plainPlan) && /Sunday/.test(plainPlan),
    "CONTROL: an unrestricted client still receives the ordinary 7-day plan",
    JSON.stringify(plainPlan.slice(0, 160)));

  // P1-1 control 2 — a literal `eggs` exclusion. Every breakfast candidate in this template is an
  // egg, so no rotation can save it and the honest refusal is the answer.
  const eggs = await client("Naledi", { foodDislikes: "eggs" });
  const seven = await ask(eggs.phone, "7 day meals");
  chk(!/\begg/i.test(body(seven)), "a literal `eggs` exclusion reaches the fixed 7-day template",
    JSON.stringify((body(seven).match(/[^\n]*egg[^\n]*/i) || [""])[0]));
  chk(/can't build/i.test(seven),
    "…and with no egg-free breakfast candidate to rotate to, it refuses rather than prescribing one",
    JSON.stringify(seven.slice(0, 200)));

  // P1-1 control 3 — THE ONE THAT DISTINGUISHES ROTATION FROM GIVING UP. Vegan AND no lentils: the
  // same arrays carry tofu, soya mince and sugar beans, so a plan must still come out.
  const noLentils = await client("Zanele", { dietaryRestrictions: "vegan, lentils" });
  const vPlan = await ask(noLentils.phone, "7 day meals");
  chk(!/lentil/i.test(body(vPlan)), "vegan + `lentils` excluded: no lentil is recommended anywhere",
    JSON.stringify((body(vPlan).match(/[^\n]*lentil[^\n]*/i) || [""])[0]));
  chk(!/can't build/i.test(vPlan) && /Sunday/.test(vPlan),
    "…and the plant-based alternative survives — they still get the whole week",
    JSON.stringify(vPlan.slice(0, 200)));
  chk(/tofu|soya|sugar beans/i.test(vPlan), "…built on the compliant plant proteins the arrays already carry",
    JSON.stringify((vPlan.match(/[^\n]*(tofu|soya|sugar beans)[^\n]*/i) || ["(none)"])[0]));
  chk(!ANIMAL.test(body(vPlan)), "…and it is still vegan", (body(vPlan).match(new RegExp(ANIMAL.source, "gi")) || []).join(", "));

  // The same rotation is what keeps a coeliac covered: every gluten carb has a non-gluten
  // candidate in its own array, so the plan changes rather than disappearing.
  const coeliac = await client("Lerato", { dietaryRestrictions: "gluten" });
  const gPlan = await ask(coeliac.phone, "7 day meals");
  chk(!/bread|pasta|wheat/i.test(body(gPlan)), "a gluten-free client is recommended no bread, pasta or wheat",
    JSON.stringify((body(gPlan).match(/[^\n]*(bread|pasta|wheat)[^\n]*/i) || [""])[0]));
  chk(!/can't build/i.test(gPlan) && /Sunday/.test(gPlan), "…and still gets the whole week",
    JSON.stringify(gPlan.slice(0, 160)));

  // The control on the control: a dislike the plan never names must cost the client nothing.
  // The fixture NAME must not carry a food word — the header interpolates it, and a client called
  // "DislikesBroccoli" fails a broccoli detector on the greeting line alone.
  const broc = await client("Thabo", { foodDislikes: "broccoli" });
  const ok = await ask(broc.phone, "7 day meals");
  chk(!/can't build/i.test(ok) && /Monday/.test(ok) && /Sunday/.test(ok),
    "CONTROL: a dislike the template never names still gets the whole week",
    JSON.stringify(ok.slice(0, 200)));
  chk(!/broccoli/i.test(body(ok)), "…with the disliked food itself absent from it",
    JSON.stringify((body(ok).match(/[^\n]*broccoli[^\n]*/i) || [""])[0]));

  // ── P1-2 · KOSHER IS NOT HALAAL, AND IT FAILS CLOSED ───────────────────────────────────────
  //
  // `declaredLabel` covers both, so testing it truthy sent a kosher client down the halal path —
  // "buy halal-certified chicken and beef". The first fix gave them the plan with a "check the
  // hechsher yourself" caveat, which is a kosher rule invented at the mouth: these templates put
  // chicken and yoghurt in the same day, so they break kashrut on what may be eaten TOGETHER, and
  // nothing in this product owns that rule. Until a kosher-safe owner exists, it fails closed.
  const kosher = await client("Yosef", { dietaryRestrictions: "kosher" });
  const kPlan = await ask(kosher.phone, "7 day meals");
  chk(!/halal|halaal/i.test(kPlan), "a kosher client is never labelled halal",
    JSON.stringify((kPlan.match(/[^\n]*hal[a]?al[^\n]*/i) || [""])[0]));
  chk(/can't build/i.test(kPlan), "…and an unsupported kosher plan fails honestly rather than being caveated",
    JSON.stringify(kPlan.slice(0, 220)));
  chk(!/chicken|beef|yoghurt|milk|cheese/i.test(body(kPlan)),
    "…prescribing no food at all rather than food we cannot vouch for",
    (body(kPlan).match(/chicken|beef|yoghurt|milk|cheese/gi) || []).join(", "));
  // P1-2 control 1 — the halal path itself must be untouched for someone who declared it.
  const halaal = await client("Aisha", { dietaryRestrictions: "halaal" });
  const hPlan = await ask(halaal.phone, "7 day meals");
  chk(/halal-certified/i.test(hPlan), "CONTROL: a client who declared halaal still gets the halal-safe path",
    JSON.stringify((hPlan.match(/[^\n]*halal[^\n]*/i) || ["(absent)"])[0]));
  chk(!/can't build/i.test(hPlan) && /Sunday/.test(hPlan), "CONTROL: …and their whole week",
    JSON.stringify(hPlan.slice(0, 160)));

  // SALMON WAS NOT IN THE FISH CLUSTER, found by running the fix over the premium tier.
  const fish = await client("Bongani", { dietaryRestrictions: "fish", weeklyFoodBudget: "over_600" });
  const fPlan = await ask(fish.phone, "7 day meals");
  chk(!/salmon|mackerel|kingklip/i.test(body(fPlan)),
    "a declared fish allergy covers salmon on the shopping list and in the pro tip",
    JSON.stringify((body(fPlan).match(/[^\n]*salmon[^\n]*/i) || [""])[0]));
  chk(!/can't build/i.test(fPlan) && /Sunday/.test(fPlan),
    "CONTROL: …and they still get the whole week — a dropped line is not a dropped plan",
    JSON.stringify(fPlan.slice(0, 160)));
}

REAL("\n=== K · THE ROTATION'S OWN REGRESSIONS (#220 recovery, post-merge) ===");
REAL("    (four defects Codex found on b04283a, verified against the real builder and closed.)");
{
  // P1 · THE WEEK EATS MORE THAN THE LIST BUYS. Rotation concentrates the plan onto the surviving
  // candidates while the shopping list stayed a fixed string, so `vegan, lentils` prescribed 1400g
  // of tofu and 600g of dry soya mince against a list buying 800g and 250g. The client shops on
  // Sunday, follows the plan exactly, and runs out on Thursday — a worse failure than the one the
  // rotation fixed, because they did nothing wrong.
  const v = await client("Zanele", { dietaryRestrictions: "vegan, lentils", weeklyFoodBudget: "300_600" });
  const plan = await ask(v.phone, "7 day meals");
  const gramsOf = (re: RegExp) => [...plan.matchAll(re)].reduce((n, m) => n + Number(m[1] || 0), 0);
  const eatenTofu = gramsOf(/(\d+)\s*g firm tofu/gi);
  const eatenSoya = gramsOf(/soya mince\s*(\d+)\s*g dry/gi);
  const boughtOf = (name: RegExp) => {
    const line = (plan.split("\n").find(l => name.test(l) && /—\s*R\d+$/.test(l)) || "");
    const m = line.match(/(\d+)\s*g(?:\s*×\s*(\d+))?/);
    return m ? Number(m[1]) * Number(m[2] || 1) : 0;
  };
  chk(eatenTofu > 0 && boughtOf(/^Firm tofu/i) >= eatenTofu,
    "the shopping list buys at least as much tofu as the week prescribes",
    `eats ${eatenTofu}g, buys ${boughtOf(/^Firm tofu/i)}g`);
  chk(eatenSoya > 0 && boughtOf(/^Soya mince/i) >= eatenSoya,
    "…and at least as much soya mince",
    `eats ${eatenSoya}g dry, buys ${boughtOf(/^Soya mince/i)}g`);
  // THE CONTROL. Buying more is trivially satisfied by buying everything in the shop; the list
  // must also stop listing what the plan never names, and stay priced.
  chk(!/Cottage cheese|Greek yoghurt|Eggs \d+ pack/i.test(plan),
    "CONTROL: …and does not list food this vegan's plan never names",
    JSON.stringify(plan.split("\n").filter(l => /—\s*R\d+$/.test(l))));
  // A DRY WEIGHT IS NOT A COOKED ONE, AND THE LINE MUST KEEP SAYING SO. Rebuilding the line from
  // its parsed parts dropped "dry" from "Soya mince 250g dry", and a client buying 750g of soya
  // mince by cooked weight buys nearly three times what they need.
  chk(/Soya mince[^\n]*\bdry\b/i.test(plan), "the rewritten quantity keeps the line's own dry-weight wording",
    JSON.stringify((plan.match(/[^\n]*Soya mince[^\n]*/i) || ["(absent)"])[0]));
  chk(/Estimated total: R\d+/.test(plan) && !/R0\b/.test(plan), "CONTROL: …and the week still carries a real total",
    JSON.stringify((plan.match(/Estimated total: R\d+/) || ["(absent)"])[0]));

  // P2 · A DAY-INDEXED SCHEDULE IS NOT A CANDIDATE POOL. For recomposition, dinnerCarbs is
  // "training days get a carb, rest days get none". Compacting it and rotating printed
  // "extra veg only (rest day)" on Monday, Wednesday and Friday — the words reaching the client on
  // a training day, with the training-day calories still claimed over veg.
  const rc = await client("Lindiwe", { goalType: "recomposition", foodDislikes: "sweet potato" });
  const rPlan = await ask(rc.phone, "7 day meals");
  const dinners = rPlan.split("\n\n").join("\n").split("\n");
  let day = "", misbound = 0, trainingDinners = 0;
  for (const l of dinners) {
    if (/^\*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(l)) day = l;
    if (/^Dinner:/.test(l) && /Training Day/.test(day)) {
      trainingDinners++;
      if (/rest day/i.test(l)) misbound++;
    }
  }
  chk(trainingDinners > 0 && misbound === 0,
    "a training-day dinner is never given the rest-day entry",
    `${misbound} of ${trainingDinners} training dinners said "(rest day)"`);
  chk(!/sweet potato/i.test(body(rPlan)), "…while the excluded carb is still gone",
    JSON.stringify((body(rPlan).match(/[^\n]*sweet potato[^\n]*/i) || [""])[0]));
  chk(/½ cup brown rice|samp|pap|oats/i.test(rPlan),
    "…and the training day still gets a real carb, replaced rather than borrowed",
    JSON.stringify((rPlan.match(/Dinner:[^\n]*/) || [""])[0]));
  // THE CONTROL: an unrestricted recomposition client keeps the original schedule exactly.
  const rc2 = await client("Ayanda", { goalType: "recomposition" });
  const r2 = await ask(rc2.phone, "7 day meals");
  chk(/½ medium sweet potato/.test(r2) && /extra veg only \(rest day\)/.test(r2),
    "CONTROL: an unrestricted recomposition client keeps the stock training/rest split",
    JSON.stringify((r2.match(/Dinner:[^\n]*/) || [""])[0]));

  // P2 · A FOOD THAT CONTAINS THE WORD IS NOT A DECLARATION. `foodDislikes: "kosher salt"` set
  // declaredLabel, which set noPork, which — once the builder began failing closed — refused the
  // client's entire meal plan over a salt preference.
  const salt = await client("Refilwe", { foodDislikes: "kosher salt" });
  const sPlan = await ask(salt.phone, "7 day meals");
  chk(!/can't build/i.test(sPlan) && /Sunday/.test(sPlan),
    "a `kosher salt` dislike is a food, not a declaration — the plan is still built",
    JSON.stringify(sPlan.slice(0, 200)));
  const { foodConstraints: fc } = await import("../server/food-swaps");
  chk(fc({ foodDislikes: "kosher salt" }).declaredLabel === "",
    "…and it sets no declared diet label at the canonical owner");
  chk(!fc({ foodDislikes: "kosher salt" }).noPork,
    "…nor the no-pork consequence that label used to carry");
  // THE CONTROL: a real declaration still is one, in every column it can arrive in.
  chk(fc({ dietaryRestrictions: "kosher" }).declaredLabel === "kosher"
      && fc({ dietaryRestrictions: "halaal" }).declaredLabel === "halaal"
      && fc({ foodDislikes: "halaal" }).declaredLabel === "halaal"
      && fc({ dietaryRestrictions: "kosher" }).noPork,
    "CONTROL: a declared kosher/halaal is still recognised, and still implies no pork");

  // P2 · NEVER ASK FOR SOMETHING THAT CANNOT CHANGE THE ANSWER. Kosher is refused unconditionally,
  // so "name two or three proteins you DO eat" was a question no answer could satisfy.
  const k = await client("Yosef", { dietaryRestrictions: "kosher" });
  const kPlan = await ask(k.phone, "7 day meals");
  chk(!/two or three proteins/i.test(kPlan),
    "the unsupported-kosher reply does not ask for proteins it cannot use",
    JSON.stringify(kPlan));
  chk(/can't build you a meal plan for kosher/i.test(kPlan) && /everything else still works/i.test(kPlan),
    "…it says plainly what is unsupported, and what still is",
    JSON.stringify(kPlan.slice(0, 240)));
  // THE CONTROL: the ask is still there when it CAN unblock the plan.
  const eggs = await client("Naledi", { foodDislikes: "eggs" });
  chk(/two or three proteins/i.test(await ask(eggs.phone, "7 day meals")),
    "CONTROL: …while a client whose pools merely ran out is still asked, because naming one helps");
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
