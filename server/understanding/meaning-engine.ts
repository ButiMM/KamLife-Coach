/**
 * The Meaning Engine — the single conversational owner (the "Coach K" cortex).
 *
 * This is the heart of the rebuild. One flow, one identity:
 *
 *   message + prior understanding
 *     → PERCEPTION pass   (cheap model updates the state; never writes the reply)
 *     → PROMPT COMPILER   (state → a tight blurb; zero tokens)
 *     → ORCHESTRATOR      (one Coach K: Assess → Plan → act ONLY if explicitly asked → Reply)
 *     → { reply, updated understanding }
 *
 * It embodies the golden rule: understand BEFORE you act. The orchestrator is told to
 * reach for an action only on an explicit request; open/reflective/emotional messages get
 * a coaching reply or ONE clarifying question — never a workout dump, never a step-nag at a
 * sick client.
 *
 * SHADOW-SAFE: this module only PRODUCES a reply + a new state. It does not send anything
 * and does not persist. The caller decides whether to use it (live) or score it (shadow).
 * Fail-open: any error returns null so the existing pipeline remains the fallback.
 */

import type OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "../ai-offline";
import { recordGptCost } from "../gpt";
import { BRAIN_SYSTEM } from "../brain/coach-brain";
import { type UnderstandingState } from "./state";
import { compileStateBlurb, compileKeyFacts } from "./compiler";
import { runPerception } from "./perception";

// COACH K'S CONSTITUTION (final review): the immutable laws every reply obeys. These sit
// ABOVE everything — the one identity, expressed as principles, so the engine behaves the
// same coherent way on every message (this is what stops the "five subsystems each think
// they're the coach" feeling). They are prompt, tests, and culture in one.
const CONSTITUTION = `COACH K'S CONSTITUTION — these laws are absolute, they override any other instinct:
1. Understand before acting — grasp what they mean before you decide what to do.
2. Never guess — if you're unsure what they mean, ask ONE short question.
3. Remember the person, not the message — reference who they are and where they are.
4. Never sacrifice safety — if they're sick, hurt, or unwell, care first; never push training or steps.
5. Reduce shame — never scold a missed session or a bad meal; coach the next step, warmly.
6. Reward consistency over perfection — showing up beats a perfect day.
7. Speak plainly — short, simple, South African; no jargon, no calorie/kilojoule figures unless they asked.`;

// The "think" wrapper (blueprint Days 21-30). The persona + hard rules live in
// BRAIN_SYSTEM (one identity, one voice — no second personality); this adds the
// assess-before-act discipline and forbids tool-reach on open messages. Kept SHORT so it
// steers without drowning the persona.
const THINK_HEADER = `Before you write a single word, think silently in this order:
1. ASSESS — what is actually happening for this person in this message? What do they mean?
2. NEED — what do they need right now: to be heard, an answer, permission, a push, or an action?
3. ACT? — only if they EXPLICITLY asked for an action (log, today's workout, the full plan) do you act. Otherwise you talk. If unsure, ask ONE short question.
4. REPLY — as Coach K, short and human, using what you know about them below. Never dump a workout or plan onto an open, reflective, or emotional message. If they're sick or recovering, hold rest — never push training or steps.
Do the thinking silently; output ONLY the reply.`;

// Emotional/pushback/long messages get the stronger model — the moments that decide
// whether a client stays. Routine chat stays on mini (margin).
function pickModel(message: string): "gpt-4o" | "gpt-4o-mini" {
  const hard = /\b(wrong|bad advice|not what i|don'?t give me|hate|quit|give up|can'?t do this|frustrat|useless|nonsense|you said|you told|listen to me|scared|anxious|depress|alone|struggling)\b/i.test(message)
    || message.length > 220;
  return hard ? "gpt-4o" : "gpt-4o-mini";
}

export interface MeaningInput {
  openai: OpenAI;
  user: any;
  message: string;
  prior: UnderstandingState;
  /** the real DB snapshot text (trustworthy numbers) — optional but strongly recommended */
  snapshot?: string;
  /** DB-derived stats to fold into understanding */
  stats?: Partial<UnderstandingState["stats"]>;
  /** recent turns for continuity: [{role, content}] */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface MeaningResult {
  reply: string;
  state: UnderstandingState;
  model: string;
}

export async function runMeaningEngine(input: MeaningInput): Promise<MeaningResult | null> {
  const { openai, user, message, prior, snapshot, stats, history } = input;
  try {
    // 1. PERCEPTION — update understanding first (the one place text becomes understanding).
    const state = await runPerception(openai, { message, prior, stats, userId: user?.id });

    // 2. PROMPT COMPILER — render the state to a tight blurb (not raw JSON).
    const blurb = compileStateBlurb(state);
    const keyFacts = compileKeyFacts(state);

    // 3. ORCHESTRATOR — one Coach K, assess→plan→reply, grounded in state + real numbers.
    assertAiOnline("meaning_engine");
    const model = pickModel(message);
    const systemParts = [
      CONSTITUTION,
      BRAIN_SYSTEM,
      THINK_HEADER,
      `WHAT YOU KNOW ABOUT THIS CLIENT RIGHT NOW:\n${blurb}`,
      keyFacts,
      snapshot ? `THEIR REAL NUMBERS (authoritative — quote these, never invent):\n${snapshot}` : "",
    ].filter(Boolean);

    const messages: any[] = [
      { role: "system", content: systemParts.join("\n\n") },
      ...(history || []).slice(-8),
      { role: "user", content: message },
    ];

    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.5,
      max_tokens: 400,
      messages, // v1: NO tools — the engine produces the CONVERSATIONAL reply; transactions
                // stay on the deterministic pipeline until the engine graduates from shadow.
    });
    recordGptCost({
      userId: user?.id ?? null,
      model,
      feature: "meaning_engine",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    });

    const reply = (resp.choices[0]?.message?.content || "").trim();
    if (!reply) return null;
    return { reply, state, model };
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[MEANING_ENGINE] failed (deferring):", (e as any)?.message || e);
    return null; // fail-open
  }
}
