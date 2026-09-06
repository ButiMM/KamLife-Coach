/**
 * REAL-POSTGRESQL ACCEPTANCE — the constraint reaches every mouth that names a food (#128).
 *
 * THE DEFECT, REPRODUCED ON THIS BRANCH'S PARENT. One client, dietary_restrictions = 'vegan',
 * asking the plainest question this product answers:
 *
 *   "what should I eat"
 *   → *🍽️ Next Meal Suggestion*
 *     1. 2 chicken thighs + rice + mixed veg
 *     2. Beef mince + pap + spinach
 *     3. Chicken breast + rice + spinach
 *     4. Tin of pilchards + sweet potato
 *     5. 3 eggs + brown bread + tomato
 *
 * Five plates, five of them impossible. The grocery list, the meal plan and the permission-ask all
 * consult foodConstraints; this door had ZERO calls to it, and the grocery personalization block
 * could print "grab eggs" three lines above "🚫 Left off — you told me: eggs".
 *
 * WHY POSTGRESQL. The reply is composed from the day ledger — what is logged, what is left — so
 * which branch of the menu a client reaches depends on real rows. A fixture that answers every
 * query the same way puts every client on one branch, which is how a menu that never asked about
 * constraints looked fine.
 *
 * EVERY PROHIBITION IS PAIRED WITH ITS CONTROL. "The coach offered no chicken" is trivially
 * satisfied by a coach that offers nothing at all, so each section has an unconstrained twin that
 * must still be offered the thing the constrained client is not.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-food-constraint-mouths-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { buildGroceryPersonalization } = await import("../server/grocery-personalize");
const { foodConstraints } = await import("../server/food-swaps");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// THE TEST'S OWN VOCABULARY, not the product's. Asserting with `constraints.allows` would grade
// the filter against itself and pass for any client on any reply.
const ANIMAL = /\b(chicken|beef|mince|steak|lamb|mutton|biltong|pilchards?|tuna|fish|hake|eggs?|yoghurt|amasi|milk|cheese)\b/i;
const PORK = /\b(pork|bacon|ham|gammon)\b/i;

async function seed(over: Record<string, any>): Promise<{ id: string; phone: string }> {
  const phone = `whatsapp:+2795${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, weeklyFoodBudget: "100_300",
    createdAt: new Date(), lastActiveAt: new Date(), ...over,
  } as any).returning();
  // ONE LOGGED MEAL, so the client is on the branch that has calories AND a protein gap left —
  // the branch that prints the menu. Without it every client lands on the cold-start line.
  await pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     VALUES ($1, now(), 'lunch', 500, 20, $2, 'seed', 'sa_scanner')`,
    [u.id, JSON.stringify([{ name: "pap", grams: 200 }])]);
  return { id: u.id, phone };
}

const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

REAL("\n=== THE PLATE THE COACH NAMES ===");

// ── §1 THE ASK THIS DOOR EXISTS FOR ─────────────────────────────────────────────────────────
const vegan = await seed({ dietaryRestrictions: "vegan" });
for (const question of ["what should I eat", "what can I eat", "I'm hungry"]) {
  const reply = await ask(vegan.phone, question);
  chk(!ANIMAL.test(reply), `"${question}" offers a vegan client no animal protein`,
    (reply.match(ANIMAL) || []).join(",") + " | " + reply.slice(0, 200));
  chk(/\n/.test(reply.trim()) && reply.trim().length > 60,
    `…and still answers with something — silence is not honouring a constraint`, reply.slice(0, 120));
}

// ── §2 THE CONTROL: THE SAME DOOR STILL NAMES MEAT WHEN NOTHING IS DECLARED ─────────────────
//
// §1 is satisfied by a coach that never names a food again. This is what stops that reading.
const open = await seed({ dietaryRestrictions: null });
const openReply = await ask(open.phone, "what should I eat");
chk(ANIMAL.test(openReply), "an unconstrained client is still offered real protein by name",
  openReply.slice(0, 200));
chk(openReply !== await ask(vegan.phone, "what should I eat"),
  "the two clients genuinely receive different menus");

// ── §3 THE OTHER CONSTRAINTS, ON THE SAME DOOR ──────────────────────────────────────────────
const halaal = await seed({ dietaryRestrictions: "halaal" });
const halaalReply = await ask(halaal.phone, "what should I eat");
chk(!PORK.test(halaalReply), "a halaal client is offered no pork", halaalReply.slice(0, 200));
chk(/chicken|beef|mince|fish|eggs?/i.test(halaalReply),
  "…and is still offered the animal protein they DO eat — halaal is not vegan",
  halaalReply.slice(0, 200));

const noEggs = await seed({ foodDislikes: "eggs" });
const noEggsReply = await ask(noEggs.phone, "what should I eat");
chk(!/\beggs?\b/i.test(noEggsReply), "a literal named food from signup is honoured too",
  noEggsReply.slice(0, 200));
chk(/chicken|beef|mince|pilchards?/i.test(noEggsReply),
  "…and nothing else was taken away with it", noEggsReply.slice(0, 200));

// ── §4 THE CALORIE-CEILING BRANCH, WHICH NAMES A SNACK ──────────────────────────────────────
//
// A second branch of the same door, reached by a different day. It printed "(eggs, yoghurt,
// biltong)" unconditionally.
const full = await seed({ dietaryRestrictions: "vegan", calorieTarget: 600, proteinTarget: 150 });
const fullReply = await ask(full.phone, "what should I eat");
chk(!ANIMAL.test(fullReply), "the day-is-done branch names no animal snack either",
  fullReply.slice(0, 220));

REAL("\n=== THE GROCERY BLOCK ===");

// ── §5 THE HEADER MUST NOT CONTRADICT THE FOOTER ────────────────────────────────────────────
//
// buildGroceryPersonalization is pure, so it is graded directly with the profile a real client's
// meal logs produce: someone who logged chicken for months and has since told us they are vegan.
const profile = {
  topFoods: [
    { name: "chicken", count: 9 }, { name: "pap", count: 8 }, { name: "white bread", count: 6 },
    { name: "cabbage", count: 4 }, { name: "rice", count: 3 }, { name: "spinach", count: 2 },
  ],
  distinctCount: 6,
};
const veganBlock = buildGroceryPersonalization(profile, "fat_loss", foodConstraints({ dietaryRestrictions: "vegan" }));
chk(!ANIMAL.test(veganBlock), "the personalization block names no food this client refuses",
  veganBlock.replace(/\n/g, " | "));
chk(/Kept in/.test(veganBlock) && /pap|cabbage|spinach/i.test(veganBlock),
  "…and still tells them what it kept from their own logs", veganBlock.replace(/\n/g, " | "));

const openBlock = buildGroceryPersonalization(profile, "fat_loss");
chk(/chicken/i.test(openBlock), "the control block still builds around the chicken they log",
  openBlock.replace(/\n/g, " | "));

// The protein-gap line was the hardcoded "Eggs and a tin of pilchards".
const noProtein = { topFoods: [{ name: "pap", count: 9 }, { name: "cabbage", count: 5 },
  { name: "rice", count: 4 }, { name: "spinach", count: 3 }, { name: "butternut", count: 2 },
  { name: "tomato", count: 2 }], distinctCount: 6 };
const veganGap = buildGroceryPersonalization(noProtein, "fat_loss", foodConstraints({ dietaryRestrictions: "vegan" }));
chk(/Add protein/.test(veganGap) && !ANIMAL.test(veganGap),
  "the protein-gap line still fires, and names something they can buy",
  veganGap.replace(/\n/g, " | "));
chk(/Add protein/.test(buildGroceryPersonalization(noProtein, "fat_loss")),
  "…and the unconstrained client still gets the same nudge");

await pool.query("DELETE FROM users WHERE id = ANY($1)",
  [[vegan.id, open.id, halaal.id, noEggs.id, full.id]]);
REAL(`\npg-food-constraint-mouths-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
