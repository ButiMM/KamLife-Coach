// ============================================================
// GROCERY LIST REFINE
// The heart of Coach K's food philosophy made literal: take the
// client's REAL grocery/pantry list and rewrite it into a clean,
// organised, goal-optimised shopping list they can take straight
// to the shop. We refine what they already buy — we never replace
// it with a generic diet. Keeps their foods, reorganises them,
// adds portion guidance, swaps only the items that fight their goal.
//
// Uses GPT (the input is an arbitrary list) but produces a STRUCTURED
// DELIVERABLE, so it deliberately does NOT go through askCoachK — that
// path enforces a 3-sentence/60-word cap meant for conversation.
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

const BUDGET_LABELS: Record<string, string> = {
  under_100: "tight budget — Shoprite/Boxer prices",
  "100_300": "moderate budget — Pick n Pay/Checkers",
  "300_600": "comfortable budget — Checkers/Spar",
  over_600: "premium budget — Woolworths/quality cuts",
  "600_plus": "premium budget — Woolworths/quality cuts",
};

export async function refineGroceryList(items: string[], user: any): Promise<string> {
  const firstName = user.name?.split(" ")[0] || "";
  const goal = user.goalType || "fat_loss";
  const goalLabel = goal === "fat_loss" ? "fat loss" : goal === "muscle_gain" ? "muscle gain" : "body recomposition";
  const budgetLabel = BUDGET_LABELS[user.weeklyFoodBudget as string] || "";
  const medical = (user.medicalConditions || "").trim();

  const goalDirective =
    goal === "fat_loss"
      ? "Push lean protein and vegetable volume. Move calorie-dense items (sugary drinks, syrups, processed meats, fatty cheese, oils) into LEAVE/LIMIT with a one-word swap each."
      : goal === "muscle_gain"
        ? "Keep the calorie-dense items — they help the surplus. Push protein hard. Only move pure-sugar drinks into LEAVE/LIMIT."
        : "Portion carbs and calorie-dense items but keep the variety. Move only the empty-calorie items (sugary drinks, syrups) into LEAVE/LIMIT.";

  const system = `You are Coach K, a South African fitness and nutrition coach. Your client${firstName ? ` ${firstName}` : ""} sent you their real grocery/pantry list. Goal: ${goalLabel}.${budgetLabel ? ` Budget: ${budgetLabel}.` : ""}${medical ? ` Medical: ${medical}.` : ""}

YOUR JOB: REWRITE their list into a clean, organised shopping list they can take straight to the shop. This is exactly how you coach — you take what they already buy and refine it. You never replace their food with a new diet. People stick to refined habits, not overhauls.

OUTPUT — a rewritten shopping list, organised so it is easy to shop from:
- Open with ONE short line: "Here's your list cleaned up for ${goalLabel}, ${firstName || "champ"} — shop straight off this:"
- Then these sections, each with a *bold* header, only if they have items for it:
  *PROTEIN* — their foundation, buy plenty
  *CARBS* — one fist/cup per meal
  *VEGETABLES* — fill half the plate, buy lots
  *FRUIT* — 1–2 a day
  *FLAVOUR & SAUCES* — small amounts
  *LEAVE OR LIMIT* — the items that fight ${goalLabel}, each with a short reason or a one-word swap (e.g. "Pina colada soft drinks → sparkling water")
- Under each header, list items ONE PER LINE. Just the item name, plus a short portion note only where it matters. No bullet symbols.
- Close with ONE line: tell them to send what they eat each day (photo or words) and you'll track the numbers.

RULES:
- Keep EVERY good item from their list. Do not invent foods they did not mention — the only new items allowed are direct swaps for a flagged problem item.
- ${goalDirective}
${medical ? `- Respect their medical condition in the notes (diabetic → low-GI carbs; hypertension → flag high-sodium processed items like polony, viennas, stock cubes).\n` : ""}- Voice: direct, warm, South African. No corporate tone. No "great list". No exclamation marks. A tick ✓ is fine, no other emojis.
- Output ONE WhatsApp message. Do NOT use "---" separators.`;

  const decision = goal === "recomposition" || medical
    ? { model: "gpt-4o", maxTokens: 750 }
    : { model: "gpt-4o", maxTokens: 700 };

  const resp = await openai.chat.completions.create({
    model: decision.model,
    max_tokens: decision.maxTokens,
    temperature: 0.5,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `My list:\n${items.join("\n")}` },
    ],
  });

  return (resp.choices[0]?.message?.content || "").trim();
}
