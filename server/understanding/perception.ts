/**
 * Perception pass (blueprint safeguard A).
 *
 * THE ONE PLACE a raw message becomes updated understanding. It runs a cheap/fast
 * model whose ONLY job is to update UnderstandingState — it never writes the reply.
 * This is the hard split the reviews demanded: if the same model both replied AND
 * wrote the state, it would reverse-engineer the state to justify its own reply
 * (harsh reply → invents "readinessToPush: high" to excuse itself). Fact-finding is
 * kept separate from decision-making.
 *
 * Trust gate: whatever the model returns is passed through coerceUnderstanding(),
 * which clamps ranges and whitelists enums — the model can never poison the state
 * with an out-of-range value or an invented mood.
 *
 * Offline/fail-safe: any error returns the prior state unchanged (understanding never
 * regresses on a hiccup, and a reply can still be produced from what we already knew).
 */

import type OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "../ai-offline";
import { recordGptCost } from "../gpt";
import {
  type UnderstandingState,
  coerceUnderstanding,
  persistableUnderstanding,
} from "./state";

const PERCEPTION_SYSTEM = `You are the PERCEPTION layer of a South African WhatsApp coach. You do NOT talk to the client and you do NOT write any reply. Your only job: read the client's new message and the current understanding of them, and return an UPDATED understanding as JSON.

You are updating a running model of a real person. Move fields only when the message gives real evidence — do not flip mood on thin signals, do not invent facts.

Rules:
- mood: how they sound in THIS message (frustrated/anxious/motivated/neutral/hopeful).
- healthStatus: "sick" if they say they're ill/flu/not well/recovering; "recovering" just after; else keep as-is. Never downgrade to "healthy" unless they say they're better.
- topic: what this message is about (recovery/nutrition/workout/life/gratitude/progress).
- observations.confidenceTrend / frustrationLevel(1-10) / readinessToPush(low/medium/high) / trustLevel(1-10): nudge SLOWLY over time; one message rarely swings these hard. If they're angry at the coach, trust drops and frustration rises.
- profile.keyFacts: append a durable fact ONLY if they revealed something lasting. Two kinds count: (a) life facts — an injury, their job, family, a firm goal, a food they can't eat; and (b) EVIDENCE of how they respond — observed behaviour that ages well, e.g. "responds well to encouragement", "goes quiet when pushed hard", "mentioned wanting to quit", "logs food daily", "opens up in voice notes". Store the EVIDENCE (what they said or did), never your interpretation ("trustLevel 7", "mood frustrated") — those you infer fresh each message. Never store a passing mood as a fact.
- profile.lifeStory: a <=50-word narrative in TWO parts. First, WHO THEY ARE (permanent — e.g. "a cleaner, two daughters, wants to be strong for her grandchildren") — keep this stable. Then THEIR CURRENT CHAPTER (what's happening now — e.g. "recovering from flu, confidence dipping, looking forward to next week") — update only this part as things change. Splitting it this way keeps the permanent truth from being overwritten by a passing week.
- Leave stats untouched (those come from the database, not from you).

Return ONLY valid JSON matching the shape you were given. No prose, no explanation.`;

export interface PerceptionInput {
  message: string;
  prior: UnderstandingState;
  /** trustworthy DB-derived stats to fold in (streak, weight direction, averages) */
  stats?: Partial<UnderstandingState["stats"]>;
  userId?: string | null;
}

export async function runPerception(openai: OpenAI, input: PerceptionInput): Promise<UnderstandingState> {
  const { message, prior, stats, userId } = input;
  // Stats are DB truth — fold them in regardless of the model, and never let the model touch them.
  const withStats: UnderstandingState = { ...prior, stats: { ...prior.stats, ...(stats || {}) } };

  try {
    assertAiOnline("perception");
    // We send the model the durable subset + current, and ask for an update. Stats are
    // omitted from what the model sees it can change.
    const seed = {
      profile: withStats.profile,
      current: withStats.current,
      observations: withStats.observations,
    };
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 320,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PERCEPTION_SYSTEM },
        { role: "user", content: `CURRENT UNDERSTANDING:\n${JSON.stringify(seed)}\n\nCLIENT'S NEW MESSAGE:\n"${message.slice(0, 1200)}"\n\nReturn the updated understanding as JSON.` },
      ],
    });
    recordGptCost({
      userId: userId ?? null,
      model: "gpt-4o-mini",
      feature: "perception",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) return withStats;
    const parsed = JSON.parse(content);
    // Trust gate + re-attach the DB stats (model output for stats is ignored).
    const coerced = coerceUnderstanding(parsed, withStats.profile.name);
    coerced.stats = withStats.stats;
    coerced.updatedAt = new Date().toISOString();
    return coerced;
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[PERCEPTION] update failed (keeping prior state):", (e as any)?.message || e);
    return withStats; // fail-safe: understanding never regresses
  }
}

// Re-export for the wiring step so callers persist only the durable subset.
export { persistableUnderstanding };
