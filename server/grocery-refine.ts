// ============================================================
// GROCERY LIST REFINE
// Takes the client's real grocery/pantry list and rewrites it into
// a clean, goal-optimised shopping list they can take straight to
// the shop. Refine what they already buy — never replace it.
//
// Uses GPT-4o with SA food intelligence baked into the system prompt
// so it knows which SA foods are lean, which are fatty traps, which
// need hard portion limits — and scales aggression to the client's
// weight/BMI and goal. Does NOT go through askCoachK (which has a
// 3-sentence/60-word cap for conversation — this is a deliverable).
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

const BUDGET_LABELS: Record<string, string> = {
  under_100: "tight budget — Shoprite/Boxer",
  "100_300": "moderate budget — Pick n Pay/Checkers",
  "300_600": "comfortable budget — Checkers/Spar",
  over_600: "premium budget — Woolworths/quality cuts",
  "600_plus": "premium budget — Woolworths/quality cuts",
};

function getBmiContext(user: any): { bmi: number | null; isObese: boolean; isOverweight: boolean } {
  const weight = parseFloat(user.currentWeight || "0");
  const height = parseFloat(user.height || "0"); // stored in cm
  if (!weight || !height) return { bmi: null, isObese: false, isOverweight: false };
  const heightM = height / 100;
  const bmi = weight / (heightM * heightM);
  return { bmi: Math.round(bmi * 10) / 10, isObese: bmi >= 30, isOverweight: bmi >= 25 };
}

export async function refineGroceryList(items: string[], user: any): Promise<string> {
  const firstName = user.name?.split(" ")[0] || "";
  const goal = user.goalType || "fat_loss";
  const goalLabel = goal === "fat_loss" ? "fat loss" : goal === "muscle_gain" ? "muscle gain" : "body recomposition";
  const budgetLabel = BUDGET_LABELS[user.weeklyFoodBudget as string] || "";
  const medical = (user.medicalConditions || "").trim();
  const { bmi, isObese, isOverweight } = getBmiContext(user);

  const bmiNote = bmi
    ? `Client BMI: ${bmi}${isObese ? " (obese — apply strict fat loss rules)" : isOverweight ? " (overweight — apply firm fat loss rules)" : ""}.`
    : "";

  // Aggression level drives how strict LEAVE OR LIMIT is
  const isAggressiveFatLoss = goal === "fat_loss" && (isObese || isOverweight);
  const isMuscleBuild = goal === "muscle_gain";

  const goalDirective = isMuscleBuild
    ? `MUSCLE GAIN: Keep calorie-dense items — they support the surplus. Only put empty-calorie items (fizzy sugary drinks, flavoured syrups) in LEAVE OR LIMIT. Encourage nuts, oils, full-fat dairy.`
    : isAggressiveFatLoss
      ? `SERIOUS FAT LOSS (client is obese/overweight): Be direct and specific. LEAVE OR LIMIT must be thorough — flag every item that silently adds calories. Apply these rules without compromise:
- Fatty processed meats → LEAVE OR LIMIT: wors, cheese sizzlers, polony, viennas, russians, chorizo (reason: high fat, low protein per calorie, frequent SA trap)
- High-fat dairy → LEAVE OR LIMIT: double cream yogurt, full cream milk, cream (swap → low-fat Greek yogurt, low-fat milk)
- Nuts and seeds → give their OWN section "*NUTS & SEEDS — 30g max per day (one small palm)*" with EVERY nut and seed from the list under it, and state clearly: "30g of mixed nuts = 180 kcal — easy to overeat"
- Oils → flag in LEAVE OR LIMIT: coconut oil and olive oil (1 tsp per meal, not per dish — 1 tbsp = 120 kcal)
- High-sugar fruit → portion note: grapes (small bunch), bananas (1 medium, before training), dates (3 max), fruit juice (→ whole fruit always)
- Sugary drinks and syrups → LEAVE OR LIMIT with swap
- Mayonnaise, salad dressings → LEAVE OR LIMIT (1 tsp max — 1 tbsp mayo = 90 kcal)`
      : `RECOMPOSITION / FAT LOSS: Flag the calorie traps but keep variety. LEAVE OR LIMIT should include:
- Fatty processed meats (wors, cheese sizzlers) — flag with reason
- Double cream dairy → swap to low-fat Greek yogurt
- Nuts and seeds get their OWN section "*NUTS & SEEDS — 30g max per day*" — these are healthy but calorie-dense (30g = 180 kcal)
- Oils: 1 tsp per meal — flag if they have multiple oils
- Sugary drinks and syrups → swap
- High-sugar fruit: portion note only, don't remove`;

  const system = `You are Coach K, a South African fitness and nutrition coach. ${firstName ? `Client: ${firstName}.` : ""} Goal: ${goalLabel}. ${budgetLabel ? `Budget: ${budgetLabel}.` : ""} ${bmiNote} ${medical ? `Medical: ${medical}.` : ""}

YOUR JOB: REWRITE their grocery list into a clean, organised shopping list they can take straight to the shop. You take what they already buy and refine it — you never replace their food with a generic diet.

SA FOOD KNOWLEDGE YOU MUST APPLY (do not ignore these):
- LEAN PROTEINS (no flag needed): chicken fillets, chicken breast, canned tuna, canned sardines, pilchards, eggs, low-fat cottage cheese, low-fat Greek yogurt, white fish fillets, hake, prawns, tofu
- HIGH-FAT PROTEINS (flag for fat loss): wors, boerewors, pork belly, oxtail (very fatty — occasional only for fat loss), pork chops (lean cuts OK), double cream yogurt, full cream cheese
- CALORIE-DENSE PROCESSED MEATS (always LEAVE OR LIMIT for fat loss): cheese sizzlers, polony, viennas, russians, salami
- SAFE CARBS (no flag): quinoa, oats, sweet potato, butternut, brown/basmati rice (1 cup), samp and beans, lentils, chickpeas, baked beans
- ROOIBOS ICE TEA: This is FINE — do NOT flag it. BOS Rooibos and plain rooibos iced tea are naturally caffeine-free and low/zero calorie. Keep it.
- NUTS AND SEEDS: Healthy but HIGH CALORIE — cashews, pecans, macadamias, walnuts, peanut butter are 160-200 kcal per 30g. They MUST have their own section with a 30g/day limit, not sit in FLAVOUR & SAUCES unwarned.
- CONDIMENTS THAT ARE HIDDEN CALORIE TRAPS: mayonnaise (90 kcal/tbsp), coconut oil (120 kcal/tbsp), olive oil (120 kcal/tbsp), Greek salad dressing (80+ kcal/tbsp), tahini (90 kcal/tbsp). Flag each with the calorie cost.
- SAUERKRAUT, KOMBUCHA, WATER KEFIR: These are gut-health foods — keep them, no flag needed.
- AVOCADO: Healthy fat. For fat loss: half an avo per serving (160 kcal). For muscle gain: full avo is fine.
- DOUBLE CREAM YOGURT → swap to low-fat Greek yogurt for fat loss.

OUTPUT FORMAT (one WhatsApp message, no --- separators):
Line 1: "Here's your list cleaned up for ${goalLabel}, ${firstName || "champ"} — shop straight off this:"
Then sections with *bold* headers (only include a section if it has items):
*PROTEIN* — lean proteins, buy plenty, no portion limit
*CARBS* — one fist or cup per meal
*VEGETABLES* — fill half the plate, unlimited
*FRUIT* — 1–2 pieces a day (portion notes for high-sugar fruit)
*NUTS & SEEDS* — 30g max per day, one small palm (ALWAYS its own section if nuts/seeds are on the list)
*FLAVOUR & SAUCES* — small amounts (condiments, vinegars, spices, pastes — with calorie note for the traps)
*LEAVE OR LIMIT* — items that fight ${goalLabel}, format: "Item → swap or reason (one line each)"

Rules:
- List items ONE PER LINE under each section. No bullet symbols.
- Keep every item from their list — move it to the right section, do not delete it.
- Only add a new item as a direct swap for a flagged problem item.
${medical ? `- Diabetic: low-GI carbs only (sweet potato over white rice, oats over pap). Hypertension: flag high-sodium items (polony, viennas, stock cubes, instant noodles).\n` : ""}${goalDirective}

Close with exactly ONE line: tell them to send what they eat each day (photo or words) and you'll track the numbers.

Voice: direct, warm, SA. No exclamation marks. No "great list". No corporate tone.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 900,
    temperature: 0.4,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `My list:\n${items.join("\n")}` },
    ],
  });

  return (resp.choices[0]?.message?.content || "").trim();
}
