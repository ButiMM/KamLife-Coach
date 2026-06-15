// GPT-backed intent classifier — infrastructure for replacing the regex cascade.
//
// Scope: top-level routing only. Returns one of 16 broad categories + confidence.
// The 90+ fine-grained intents (FOOD_LOG variants, WORKOUT_LOG variants, etc.)
// stay handled by existing code; this classifier only decides which BUCKET to
// route into.
//
// Usage model: shadow-mode first. Call this in parallel with the regex cascade,
// log both predictions, compare after real traffic accumulates. Do NOT use it
// to route production messages until confidence has been validated on ≥1000 real
// messages against human-labelled ground truth.

import OpenAI from "openai";
import { assertAiOnline } from "./ai-offline";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

// Broad routing categories — each maps to a cluster of fine-grained intents.
// Kept small and orthogonal so GPT can classify reliably.
export const INTENT_CATEGORIES = [
  "FOOD_LOG",         // user reporting what they ate
  "WORKOUT_LOG",      // user reporting a completed workout / exercise
  "STEP_LOG",         // user reporting step count
  "WEIGHT_LOG",       // user reporting weight / body measurement
  "WATER_LOG",        // user reporting water intake
  "MOOD_SLEEP_LOG",   // user reporting mood, sleep, energy
  "WORKOUT_REQUEST",  // user asking for today's workout / programme
  "PROGRESS_CHECK",   // user asking for stats / trends / reports
  "PROFILE_UPDATE",   // user changing goal, weight target, training days, etc.
  "QUESTION",         // nutrition/training/general question expecting advice
  "MOTIVATION",       // user expressing struggle / frustration / needing support
  "INJURY_MEDICAL",   // user reporting injury, pain, medical condition
  "OPT_OUT_IN",       // user sending stop/start/pause/resume
  "CANCEL_BILLING",   // user asking to cancel, refund, billing issue
  "GREETING",         // hi / hello / good morning / short pleasantry
  "UNKNOWN",          // anything else — fall through to fallback
] as const;

export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export interface IntentClassification {
  intent: IntentCategory;
  confidence: number; // 0..1
  reasoning?: string; // optional short rationale for debugging
}

const SYSTEM_PROMPT = `You classify a South African WhatsApp fitness-coach message into ONE routing category.

Categories (pick exactly one):
- FOOD_LOG: user reports food eaten ("I had pap and chicken", "ate breakfast", "2 eggs")
- WORKOUT_LOG: user reports completed workout ("done", "finished my session", "did 3x10 squats")
- STEP_LOG: user reports steps ("8500 steps", "did 10k today")
- WEIGHT_LOG: user reports weight/measurements ("78kg", "lost 2kg", "waist 34")
- WATER_LOG: user reports water intake ("2 litres today", "had 8 glasses")
- MOOD_SLEEP_LOG: user reports mood/sleep/energy ("slept 5 hours", "feeling drained", "mood 7")
- WORKOUT_REQUEST: user asks for today's workout or programme ("give me today's workout", "what's my programme", "show me day 1")
- PROGRESS_CHECK: user asks for their stats/trends ("how am I doing", "weekly report", "show my progress")
- PROFILE_UPDATE: user changes their profile ("change goal to muscle gain", "I now train 4 days", "new weight 75kg")
- QUESTION: user asks advice ("what should I eat?", "how much protein?", "best time to train?")
- MOTIVATION: user expresses struggle/frustration ("I can't do this", "so tired", "want to quit")
- INJURY_MEDICAL: user reports pain/injury/medical condition ("knee hurts", "I have asthma", "chest pain")
- OPT_OUT_IN: user wants to stop or resume messages ("stop", "pause for a week", "resume", "I'm back")
- CANCEL_BILLING: user asks to cancel subscription/refund/billing ("cancel my subscription", "refund", "payment issue")
- GREETING: short pleasantry ("hi", "hello", "morning")
- UNKNOWN: none of the above

Return ONLY valid JSON: {"intent":"FOOD_LOG","confidence":0.93,"reasoning":"short phrase"}
Confidence: 0.9+ = very sure, 0.7–0.9 = fairly sure, below 0.7 = uncertain.`;

/**
 * Classify a single inbound message into one of 16 broad routing categories.
 *
 * Network + cost: one GPT-4o-mini call per invocation (~200 tokens, ~$0.00003).
 * Callers should cache or skip for obvious cases before invoking.
 *
 * Failure mode: returns {intent:"UNKNOWN", confidence:0} on any error so the
 * caller can fall back to the regex cascade without throwing.
 */
export async function classifyIntent(message: string): Promise<IntentClassification> {
  const trimmed = (message || "").trim();
  if (!trimmed) return { intent: "UNKNOWN", confidence: 0, reasoning: "empty message" };

  try {
    assertAiOnline("intent-classifier");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed.slice(0, 500) },
      ],
      max_tokens: 80,
    });
    const raw = resp.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const intent = INTENT_CATEGORIES.includes(parsed.intent) ? parsed.intent : "UNKNOWN";
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { intent, confidence, reasoning: parsed.reasoning };
  } catch (err) {
    console.warn("[intent-classifier] error:", err);
    return { intent: "UNKNOWN", confidence: 0, reasoning: "error" };
  }
}
