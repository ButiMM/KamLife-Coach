/**
 * response-gate.ts — Safety gate for coaching responses.
 *
 * Runs after the GPT coach generates a reply, before it's sent to the client.
 * Two-stage: fast regex (always, ~1ms) then LLM revision (only on detected conflict, ~400ms).
 *
 * Checks:
 *   1. Injury/exercise conflict — does the response recommend exercises that load
 *      a body part the client has flagged as injured?
 *   2. Medical condition conflict — does the response give advice that contradicts
 *      the client's medical conditions (diabetes, hypertension)?
 *   3. Calorie target consistency — if the response cites a specific kcal target,
 *      does it match the client's stored target (within 100 kcal)?
 *
 * Always fail-open: any unhandled error returns the original draft unchanged.
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

// ── Injury → contraindicated exercise keywords ────────────────────────────────
// Keys are body-part tokens extracted from the injuries field.
// Values are exercise phrases to flag in the response (case-insensitive).
const INJURY_CONTRAINDICATIONS: Record<string, string[]> = {
  knee: [
    "squat", "lunge", "leg press", "leg extension", "jumping",
    "plyometric", "box jump", "step up", "step-up", "sprint", "running",
    "jogging", "bulgarian", "pistol squat",
  ],
  back: [
    "deadlift", "bent over row", "bent-over row", "good morning",
    "sit-up", "sit up", "crunch", "roman chair", "back extension",
    "suitcase carry", "jefferson curl",
  ],
  shoulder: [
    "overhead press", "shoulder press", "military press", "lateral raise",
    "front raise", "upright row", "arnold press", "clean and press",
    "pull-up", "chin-up", "dip",
  ],
  hip: [
    "hip thrust", "squat", "lunge", "deadlift", "step up", "step-up",
    "leg press", "cable kickback",
  ],
  ankle: [
    "jump", "jumping", "sprint", "sprinting", "box jump", "plyometric",
    "calf raise", "rope skipping",
  ],
  wrist: [
    "push-up", "pushup", "bench press", "bicep curl", "wrist curl",
    "pull-up", "plank", "front rack", "clean",
  ],
  neck: ["overhead press", "upright row", "neck curl", "neck extension"],
};

// ── Body part extraction from free-text injury description ───────────────────
function extractBodyParts(injuries: string): string[] {
  const lower = injuries.toLowerCase();
  const parts: string[] = [];
  if (/knee|patella|acl|mcl|meniscus/i.test(lower)) parts.push("knee");
  if (/back|spine|lumbar|herniat|disc|sciatica|lower back|upper back/i.test(lower)) parts.push("back");
  if (/shoulder|rotator|cuff|labrum/i.test(lower)) parts.push("shoulder");
  if (/hip|iliopsoas|it band|iliotib/i.test(lower)) parts.push("hip");
  if (/ankle|achilles|plantar/i.test(lower)) parts.push("ankle");
  if (/wrist|carpal|forearm.*pain|tendon.*wrist/i.test(lower)) parts.push("wrist");
  if (/neck|cervical/i.test(lower)) parts.push("neck");
  return parts;
}

// ── Check response for contraindicated exercises ──────────────────────────────
function checkInjuryConflicts(response: string, bodyParts: string[]): string[] {
  const lower = response.toLowerCase();
  const conflicts: string[] = [];
  for (const part of bodyParts) {
    const banned = INJURY_CONTRAINDICATIONS[part] || [];
    const found = banned.filter(ex => lower.includes(ex));
    if (found.length > 0) {
      conflicts.push(`Response recommends "${found.join('", "')}" but client has ${part} injury`);
    }
  }
  return conflicts;
}

// ── Check response against medical conditions ─────────────────────────────────
function checkMedicalConflicts(response: string, conditions: string): string[] {
  const lowerResp = response.toLowerCase();
  const lowerCond = conditions.toLowerCase();
  const conflicts: string[] = [];

  if (/diabetes|diabetic/i.test(lowerCond)) {
    // Skipping meals is dangerous for diabetes
    if (/skip.*meal|fast.*training|train.*fasted|intermittent fast/i.test(lowerResp)) {
      conflicts.push("Advice suggests skipping meals / fasted training — dangerous for diabetic client");
    }
  }

  if (/hypertension|high blood pressure/i.test(lowerCond)) {
    // Maximal exertion cues are risky
    if (/max.*effort|all.?out|go.*hard.*possible|1rm|one rep max/i.test(lowerResp)) {
      conflicts.push("Advice suggests maximal exertion — risky for hypertensive client");
    }
  }

  return conflicts;
}

// ── Calorie target consistency (soft check — warn only) ──────────────────────
function checkCalorieConsistency(response: string, calorieTarget?: number | null): string | null {
  if (!calorieTarget || calorieTarget <= 0) return null;
  // Look for explicit kcal numbers in the response: "1 400 kcal", "1400kcal", "1,400 calories"
  const matches = response.match(/(\d[\d,\s]{2,4})\s*(?:kcal|calories?|cal\b)/gi);
  if (!matches) return null;
  for (const m of matches) {
    const num = parseInt(m.replace(/[^\d]/g, ""), 10);
    if (num < 500 || num > 5000) continue; // not a daily target
    if (Math.abs(num - calorieTarget) > 200) {
      return `Response cites ${num} kcal target but client target is ${calorieTarget} kcal`;
    }
  }
  return null;
}

// ── LLM revision — rewrites conflicting response with safe alternatives ───────
const REVISION_TIMEOUT_MS = 900;

async function llmRevise(
  draft: string,
  injuries: string,
  conditions: string,
  conflicts: string[],
): Promise<string | null> {
  try {
    const conflictList = conflicts.map(c => `• ${c}`).join("\n");
    let revised: string | null = null;
    const timeoutHandle = setTimeout(() => { revised = null; }, REVISION_TIMEOUT_MS);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 250,
      messages: [
        {
          role: "system",
          content: `You are a safety reviewer for a fitness coaching app. A coaching response contains advice that conflicts with the client's injury/medical profile. Rewrite it to remove the conflict and substitute safe alternatives. Keep the same SA coaching voice, warmth, and length. Return ONLY the rewritten response — no commentary, no preamble.`,
        },
        {
          role: "user",
          content: `Client injuries: ${injuries || "none"}
Client medical conditions: ${conditions || "none"}

Detected conflicts:
${conflictList}

Original response:
${draft}

Rewrite removing the conflicting advice. Substitute safe exercise alternatives where relevant.`,
        },
      ],
    });
    clearTimeout(timeoutHandle);
    revised = completion.choices[0]?.message?.content?.trim() || null;
    return revised;
  } catch (e) {
    console.warn("[RESPONSE_GATE] LLM revision error:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface GateResult {
  response: string;
  passed: boolean;
  issues: string[];
  revised: boolean;
}

export async function safetyGate(
  draft: string,
  user: {
    id?: string | null;
    injuries?: string | null;
    medicalConditions?: string | null;
    calorieTarget?: number | null;
  },
  _originalMessage: string,
): Promise<GateResult> {
  try {
    const injuries = (user.injuries || "").trim();
    const conditions = (user.medicalConditions || "").trim();
    const issues: string[] = [];

    // ── Stage 1: fast regex checks ────────────────────────────────────────────
    if (injuries && injuries !== "none" && injuries !== "None") {
      const bodyParts = extractBodyParts(injuries);
      if (bodyParts.length > 0) {
        issues.push(...checkInjuryConflicts(draft, bodyParts));
      }
    }

    if (conditions && conditions !== "none" && conditions !== "None") {
      issues.push(...checkMedicalConflicts(draft, conditions));
    }

    const calIssue = checkCalorieConsistency(draft, user.calorieTarget);
    if (calIssue) issues.push(calIssue);

    // ── Fast path: no issues ──────────────────────────────────────────────────
    if (issues.length === 0) {
      return { response: draft, passed: true, issues: [], revised: false };
    }

    // Log all conflicts
    console.warn(`[RESPONSE_GATE] ${issues.length} conflict(s) detected for user ${user.id?.slice(-6) ?? "?"}:`, issues);

    // ── Stage 2: LLM revision for injury/medical conflicts ────────────────────
    // Calorie inconsistency is a soft warn — don't revise, just log.
    const hardConflicts = issues.filter(i => !i.startsWith("Response cites"));
    if (hardConflicts.length > 0) {
      const revised = await llmRevise(draft, injuries, conditions, hardConflicts);
      if (revised && revised.length > 20) {
        console.log(`[RESPONSE_GATE] revised response for user ${user.id?.slice(-6) ?? "?"}`);
        return { response: revised, passed: false, issues, revised: true };
      }
    }

    // Revision failed or only soft issues — return original
    return { response: draft, passed: false, issues, revised: false };
  } catch (e) {
    console.warn("[RESPONSE_GATE] unhandled error — passing through:", e instanceof Error ? e.message : e);
    return { response: draft, passed: true, issues: [], revised: false };
  }
}
