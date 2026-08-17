/**
 * Perception pass (blueprint safeguard A).
 *
 * THE ONE PLACE a raw message becomes updated understanding. It runs a cheap/fast
 * model whose ONLY job: update UnderstandingState — it never writes the reply.
 *
 * Trust gate: model output is clamped/whitelisted. Pattern timestamps are server-owned;
 * the model may describe evidence/confidence/confirmation but cannot forge chronology.
 *
 * Offline/fail-safe: any error returns the prior state unchanged.
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
- observations.learnedPatterns: use this ONLY for repeated, evidence-backed behavioural patterns that can improve future coaching. A single event is NOT a pattern. Never infer a hidden cause from missing data. Never write "overeats on weekends" because Saturdays are missing; that is uncertainty, not evidence. Pattern `text` must describe what was observed, `evidence` must name the concrete repeated evidence, `confidence` is low/medium/high, and `confirmed` is true only when the client explicitly confirms the pattern or the evidence has repeated independently. Keep at most 8 patterns. When a known pattern is contradicted, update its evidence/confidence instead of silently preserving it.
- Pattern chronology is NOT model-owned. Do not invent `firstObserved` or `lastObserved` timestamps; the server will retain and update them from persisted state and the current turn.
- profile.lifeStory: a <=50-word narrative in TWO parts. First, WHO THEY ARE (permanent — e.g. "a cleaner, two daughters, wants to be strong for her grandchildren") — keep this stable. Then THEIR CURRENT CHAPTER (what's happening now — update only this part as things change). Do not turn a single incident into a permanent identity statement.
- Leave stats untouched (those come from the database, not from you).

Return ONLY valid JSON matching the shape you were given. No prose, no explanation.`;

export interface PerceptionInput {
  message: string;
  prior: UnderstandingState;
  stats?: Partial<UnderstandingState["stats"]>;
  userId?: string | null;
}

export async function runPerception(openai: OpenAI, input: PerceptionInput): Promise<UnderstandingState> {
  const { message, prior, stats, userId } = input;
  const withStats: UnderstandingState = { ...prior, stats: { ...prior.stats, ...(stats || {}) } };

  try {
    assertAiOnline("perception");
    const seed = {
      profile: withStats.profile,
      current: withStats.current,
      observations: withStats.observations,
    };
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 360,
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
    const now = new Date().toISOString();
    const priorPatterns = withStats.observations.learnedPatterns || [];
    const candidatePatterns = Array.isArray(parsed?.observations?.learnedPatterns) ? parsed.observations.learnedPatterns : [];
    const byText = new Map<string, any>();
    for (const p of candidatePatterns) {
      const text = typeof p?.text === "string" ? p.text.trim() : "";
      if (text) byText.set(text.toLowerCase(), p);
    }
    const mergedPatterns = priorPatterns.map(existing => {
      const candidate = byText.get(existing.text.trim().toLowerCase());
      if (!candidate) return existing;
      return {
        ...existing,
        ...candidate,
        text: existing.text,
        evidence: typeof candidate.evidence === "string" && candidate.evidence.trim() ? candidate.evidence : existing.evidence,
        firstObserved: existing.firstObserved,
        lastObserved: now,
        confirmed: existing.confirmed || candidate.confirmed === true,
      };
    });
    const existingKeys = new Set(priorPatterns.map(p => p.text.trim().toLowerCase()));
    for (const candidate of candidatePatterns) {
      const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
      if (!text || existingKeys.has(text.toLowerCase())) continue;
      mergedPatterns.push({
        ...candidate,
        text,
        firstObserved: now,
        lastObserved: now,
        confirmed: candidate.confirmed === true,
      });
    }
    const parsedWithPatterns = {
      ...parsed,
      observations: { ...withStats.observations, ...(parsed?.observations || {}), learnedPatterns: mergedPatterns },
    };
    const coerced = coerceUnderstanding(parsedWithPatterns, withStats.profile.name, withStats);
    coerced.stats = withStats.stats;
    coerced.updatedAt = now;
    return coerced;
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[PERCEPTION] update failed (keeping prior state):", (e as any)?.message || e);
    return withStats;
  }
}

export { persistableUnderstanding };
