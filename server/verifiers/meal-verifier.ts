/**
 * meal-verifier.ts — Self-verifying loop for GPT meal calorie/macro estimates.
 *
 * Runs up to 3 passes before estimates are written to the DB:
 *   Pass 1 — Math check       (free, deterministic, always runs)
 *   Pass 2 — SA ground-truth  (free, in-memory lookup, always runs)
 *   Pass 3 — LLM plausibility (gpt-4o-mini, only when P1/P2 found issues or suspicious items remain)
 *
 * Always fail-open: any unhandled error returns the original estimate unchanged.
 */

import OpenAI from "openai";
import { db } from "../db";
import { gptCosts } from "../../shared/schema";

// ── OpenAI client (module-level, shared) ─────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

// ── Re-declared types (mirrors GptFoodItem / GptFoodFallbackResult in gpt.ts) ─
// Kept local to avoid circular imports — keep in sync if gpt.ts changes the shape.
export interface GptFoodItemLike {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  portion_desc: string;
  category: string;
}

export interface GptFoodFallbackResultLike {
  foods: GptFoodItemLike[];
  totalKcal: number;
  totalProtein: number;
  coachNote: string;
  dropped?: string[];
  fromCache?: boolean;
}

export interface VerifyResult {
  result: GptFoodFallbackResultLike;
  passes: number;
  corrected: boolean;
  log: string[];
}

// ── SA reference table ────────────────────────────────────────────────────────
// Each entry: [keywords[], { kcal, protein_g }]
// Match is case-insensitive substring: the food name must contain ALL keywords.
interface SARef {
  keywords: string[];
  kcal: number;
  protein_g: number;
}

const SA_REFERENCE: SARef[] = [
  { keywords: ["chicken breast"],        kcal: 290, protein_g: 55 },
  { keywords: ["chicken"],               kcal: 230, protein_g: 35 },
  { keywords: ["pap"],                   kcal: 300, protein_g: 7  },
  { keywords: ["maize meal"],            kcal: 300, protein_g: 7  },
  { keywords: ["mealie pap"],            kcal: 300, protein_g: 7  },
  { keywords: ["maize"],                 kcal: 300, protein_g: 7  },
  { keywords: ["rice"],                  kcal: 230, protein_g: 5  },
  { keywords: ["pilchards"],             kcal: 215, protein_g: 26 },
  { keywords: ["egg"],                   kcal: 85,  protein_g: 7  },
  { keywords: ["brown bread"],           kcal: 155, protein_g: 5  },
  { keywords: ["white bread"],           kcal: 170, protein_g: 5  },
  { keywords: ["bread"],                 kcal: 155, protein_g: 5  },
  { keywords: ["sweet potato"],          kcal: 130, protein_g: 2  },
  { keywords: ["avocado"],               kcal: 115, protein_g: 1  },
  { keywords: ["avo"],                   kcal: 115, protein_g: 1  },
  { keywords: ["banana"],                kcal: 90,  protein_g: 1  },
  { keywords: ["sugar beans"],           kcal: 220, protein_g: 15 },
  { keywords: ["beans"],                 kcal: 220, protein_g: 15 },
  { keywords: ["oats"],                  kcal: 310, protein_g: 11 },
  { keywords: ["potato"],                kcal: 115, protein_g: 3  },
];

// More-specific entries must come first so "chicken breast" wins over "chicken"
// and "brown bread" / "white bread" win over plain "bread".
// The array above is already ordered that way — longest/most-specific match first.

function findSARef(foodName: string): SARef | null {
  const lower = foodName.toLowerCase();
  for (const ref of SA_REFERENCE) {
    if (ref.keywords.every(kw => lower.includes(kw))) {
      return ref;
    }
  }
  return null;
}

// ── SA reference description (for Pass 3 prompt) ─────────────────────────────
const SA_REF_TEXT = `
South African food reference standards (use these to judge plausibility):
- Chicken breast (180g cooked): 290 kcal, 55g protein
- Chicken piece (generic, 140g): 230 kcal, 35g protein
- Pap / maize meal / mealie pap (300g cooked): 300 kcal, 7g protein
- Rice (180g cooked): 230 kcal, 5g protein
- Pilchards (215g tin): 215 kcal, 26g protein
- Egg (1 large): 85 kcal, 7g protein
- Brown bread / bread (1 slice): 155 kcal, 5g protein
- White bread (1 slice): 170 kcal, 5g protein
- Sweet potato (130g): 130 kcal, 2g protein
- Oats (80g dry): 310 kcal, 11g protein
- Potato / boiled potato (150g): 115 kcal, 3g protein
- Avo / avocado (half): 115 kcal, 1g protein
- Banana (medium): 90 kcal, 1g protein
- Sugar beans / beans (1 cup cooked): 220 kcal, 15g protein
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recalculate kcal from macros: protein*4 + carbs*4 + fat*9 */
function kcalFromMacros(item: GptFoodItemLike): number {
  return Math.round(item.protein_g * 4 + item.carbs_g * 4 + item.fat_g * 9);
}

/** Recompute result totals from corrected foods array */
function recomputeTotals(result: GptFoodFallbackResultLike): GptFoodFallbackResultLike {
  const totalKcal = result.foods.reduce((s, f) => s + f.kcal, 0);
  const totalProtein = result.foods.reduce((s, f) => s + f.protein_g, 0);
  return { ...result, totalKcal, totalProtein };
}

/** Deep-clone a result so passes don't mutate the original */
function cloneResult(r: GptFoodFallbackResultLike): GptFoodFallbackResultLike {
  return { ...r, foods: r.foods.map(f => ({ ...f })) };
}

/** GPT-4o-mini gpt_costs row insert — best-effort, never throws */
async function recordLLMCost(
  userId: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  // gpt-4o-mini pricing as of 2025: $0.15/1M prompt, $0.60/1M completion
  const costUsd = ((promptTokens * 0.15 + completionTokens * 0.60) / 1_000_000).toFixed(6);
  try {
    await db.insert(gptCosts).values({
      userId: userId ?? null,
      model: "gpt-4o-mini",
      feature: "meal_verify",
      promptTokens,
      completionTokens,
      costUsd,
    });
  } catch {
    // fire-and-forget — never surface cost-logging errors to the caller
  }
}

// ── Pass 1 — Math check ───────────────────────────────────────────────────────

function runPass1(
  result: GptFoodFallbackResultLike,
): { result: GptFoodFallbackResultLike; corrected: number; log: string[] } {
  const log: string[] = [];
  let corrected = 0;
  const foods = result.foods.map(item => {
    const expected = kcalFromMacros(item);
    // Avoid divide-by-zero if both are 0
    if (expected === 0 && item.kcal === 0) return item;
    const base = Math.max(expected, item.kcal, 1);
    const diff = Math.abs(item.kcal - expected) / base;
    if (diff > 0.20) {
      corrected++;
      log.push(`[P1] corrected ${item.name}: ${item.kcal}→${expected} kcal (macro-derived)`);
      return { ...item, kcal: expected };
    }
    return item;
  });
  const updated = recomputeTotals({ ...result, foods });
  return { result: updated, corrected, log };
}

// ── Pass 2 — SA ground-truth cross-reference ──────────────────────────────────

function runPass2(
  result: GptFoodFallbackResultLike,
): { result: GptFoodFallbackResultLike; corrected: number; log: string[] } {
  const log: string[] = [];
  let corrected = 0;
  const KCAL_TOL = 0.40;
  const PROT_TOL = 0.50;

  const foods = result.foods.map(item => {
    const ref = findSARef(item.name);
    if (!ref) {
      return item;
    }

    const kcalBase = Math.max(ref.kcal, item.kcal, 1);
    const protBase = Math.max(ref.protein_g, item.protein_g, 1);
    const kcalDiff = Math.abs(item.kcal - ref.kcal) / kcalBase;
    const protDiff  = Math.abs(item.protein_g - ref.protein_g) / protBase;

    // Only apply when BOTH kcal AND protein are outside tolerance together
    if (kcalDiff > KCAL_TOL && protDiff > PROT_TOL) {
      corrected++;
      log.push(
        `[P2] corrected ${item.name}: ${item.kcal}→${ref.kcal} kcal, ` +
        `${item.protein_g}→${ref.protein_g}g protein (SA ref)`
      );
      return { ...item, kcal: ref.kcal, protein_g: ref.protein_g };
    }

    log.push(`[P2] ${item.name} OK (within SA ref tolerance)`);
    return item;
  });

  const updated = recomputeTotals({ ...result, foods });
  return { result: updated, corrected, log };
}

// ── Pass 3 — LLM plausibility check ──────────────────────────────────────────

interface P3Correction {
  name: string;
  issue: string;
  correctedKcal: number;
  correctedProtein: number;
  correctedCarbs: number;
  correctedFat: number;
}

interface P3Response {
  verdict: "pass" | "fail";
  corrections: P3Correction[] | null;
}

async function runPass3(
  message: string,
  result: GptFoodFallbackResultLike,
  userId: string | null | undefined,
): Promise<{ result: GptFoodFallbackResultLike; corrected: number; log: string[] }> {
  const log: string[] = [];
  let corrected = 0;

  const itemsJson = JSON.stringify(
    result.foods.map(f => ({
      name: f.name,
      kcal: f.kcal,
      protein_g: f.protein_g,
      carbs_g: f.carbs_g,
      fat_g: f.fat_g,
      portion_desc: f.portion_desc,
      category: f.category,
    })),
    null,
    2,
  );

  const systemPrompt =
    `You are a South African dietitian cross-checking AI-estimated meal data for plausibility.\n` +
    `${SA_REF_TEXT}\n\n` +
    `You MUST respond with valid JSON matching this schema exactly:\n` +
    `{ "verdict": "pass" | "fail", "corrections": [ { "name": string, "issue": string, "correctedKcal": number, "correctedProtein": number, "correctedCarbs": number, "correctedFat": number } ] | null }\n` +
    `Set verdict to "pass" and corrections to null if all items look plausible.\n` +
    `Set verdict to "fail" and list corrections only for items that need fixing.\n` +
    `Be conservative — only flag obvious outliers, not minor estimation differences.`;

  const userPrompt =
    `User food message: "${message}"\n\n` +
    `Estimated items:\n${itemsJson}`;

  try {
    const resp = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pass3_timeout")), 700)
      ),
    ]);

    // Record cost (best-effort)
    const usage = resp.usage;
    if (usage) {
      void recordLLMCost(userId, usage.prompt_tokens, usage.completion_tokens);
    }

    const raw = resp.choices[0]?.message?.content ?? "{}";
    let parsed: P3Response;
    try {
      parsed = JSON.parse(raw) as P3Response;
    } catch {
      log.push("[P3] JSON parse error — skipping corrections");
      return { result, corrected, log };
    }

    if (parsed.verdict === "pass" || !parsed.corrections?.length) {
      log.push("[P3] pass — no corrections needed");
      return { result, corrected, log };
    }

    // Apply corrections
    const correctionMap = new Map<string, P3Correction>(
      parsed.corrections.map(c => [c.name.toLowerCase(), c])
    );

    const foods = result.foods.map(item => {
      const fix = correctionMap.get(item.name.toLowerCase());
      if (!fix) return item;
      corrected++;
      log.push(
        `[P3] corrected ${item.name}: ${item.kcal}→${fix.correctedKcal} kcal ` +
        `(${fix.issue})`
      );
      return {
        ...item,
        kcal: fix.correctedKcal,
        protein_g: fix.correctedProtein,
        carbs_g: fix.correctedCarbs,
        fat_g: fix.correctedFat,
      };
    });

    const updated = recomputeTotals({ ...result, foods });
    return { result: updated, corrected, log };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push(`[P3] skipped — ${msg}`);
    return { result, corrected, log };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function verifyMealEstimate(
  message: string,
  initial: GptFoodFallbackResultLike,
  user: { id?: string | null; goalType?: string | null },
): Promise<VerifyResult> {
  const allLog: string[] = [];
  let totalCorrected = 0;

  try {
    let current = cloneResult(initial);

    // ── Pass 1: math check ────────────────────────────────────────────────────
    const p1 = runPass1(current);
    current = p1.result;
    totalCorrected += p1.corrected;
    allLog.push(...p1.log);
    const mathCorrected = p1.corrected;
    console.log(`[VERIFY_MEAL] P1 math: ${p1.corrected} correction(s)`);

    // ── Pass 2: SA ground-truth ───────────────────────────────────────────────
    const p2 = runPass2(current);
    current = p2.result;
    totalCorrected += p2.corrected;
    allLog.push(...p2.log);
    const saRefCorrected = p2.corrected;
    console.log(`[VERIFY_MEAL] P2 SA-ref: ${p2.corrected} correction(s)`);

    // ── Detect suspicious items (after P1+P2) ─────────────────────────────────
    const suspiciousItems = current.foods.filter(
      f => f.kcal > 1500 ||
           f.protein_g > 150 ||
           (f.kcal === 0 && f.category !== "beverage"),
    );

    // ── Pass 3: LLM plausibility (conditional) ────────────────────────────────
    const needsP3 = suspiciousItems.length > 0 || mathCorrected > 0 || saRefCorrected > 0;
    if (needsP3) {
      const p3 = await runPass3(message, current, user.id);
      current = p3.result;
      totalCorrected += p3.corrected;
      allLog.push(...p3.log);
      console.log(`[VERIFY_MEAL] P3 LLM: ${p3.corrected} correction(s)`);
    } else {
      allLog.push("[P3] skipped — no issues found");
      console.log("[VERIFY_MEAL] P3 skipped — no issues found");
    }

    const passes = needsP3 ? 3 : 2;
    const corrected = totalCorrected > 0;

    return { result: current, passes, corrected, log: allLog };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VERIFY_MEAL] fatal error — returning original: ${msg}`);
    return {
      result: initial,
      passes: 0,
      corrected: false,
      log: [`error: ${msg}`],
    };
  }
}
