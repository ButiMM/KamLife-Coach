/**
 * The Judge (blueprint safeguard B).
 *
 * Shadow mode is worthless if a human has to score hundreds of replies a day — it gets
 * abandoned in a week. This is the automated scorer: a strict rubric model that grades a
 * candidate coach reply (and, in shadow mode, compares it to the current production reply)
 * so the "5 consecutive days better" gate is objective. Humans review ONLY what the Judge
 * flags as low or a tie.
 *
 * Rubric (0-10 each):
 *  - stateAdherence:  did it use what we know right now (sickness, mood, streak, recent topic)?
 *  - intentAccuracy:  did it answer what they MEANT — and avoid acting when not asked (the
 *                     "map my journey → workout" trap)?
 *  - toneFit:         is it Coach K — warm, plain, SA, non-robotic, right length — not a canned wall?
 *
 * Cheap (gpt-4o-mini), cost-logged, and offline-safe (returns null so callers skip scoring).
 */

import type OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "../ai-offline";
import { recordGptCost } from "../gpt";

export interface JudgeScore {
  stateAdherence: number; // 0-10
  intentAccuracy: number; // 0-10
  toneFit: number;        // 0-10
  overall: number;        // mean of the three
  worstIssue: string;     // one short phrase
  needsHumanReview: boolean;
}

export interface JudgeComparison {
  candidate: JudgeScore;
  baseline?: JudgeScore;         // present when a production reply was supplied
  winner?: "candidate" | "baseline" | "tie";
  needsHumanReview: boolean;     // true on any low score OR a tie — the only rows a human sees
}

const JUDGE_SYSTEM = `You are a STRICT quality judge for "Coach K", a South African WhatsApp fitness/nutrition coach for a low-literacy, low-income, voice-first market. You are NOT the coach; you grade replies. Soft grading defeats the purpose — a merely "fine" reply is a 5, not an 8.

You are given the client's message, what the coach KNOWS about the client right now (their state), and one or two candidate replies. Score EACH reply 0-10 on:
- stateAdherence: did the reply USE the known state? If the client is sick, did it hold rest and NOT nag steps/training? If they're frustrated, did it acknowledge that? Ignoring known sickness or mood is a 2, not a 6.
- intentAccuracy: did it answer what the client actually MEANT? Did it avoid doing an action they didn't ask for (e.g. dumping a workout onto "map my journey")? Did it avoid repeating something the client just rejected? Wrong-action-on-open-request is a 1-3.
- toneFit: does it sound like ONE warm, plain-language, South African coach — short, human, no robotic filler, no canned wall of text, no jargon/calorie-speak to a number-free client?

Return ONLY JSON:
{ "candidate": { "stateAdherence": n, "intentAccuracy": n, "toneFit": n, "worstIssue": "short phrase" }%BASELINE% }
where each score is an integer 0-10.`;

const BASELINE_SLOT = `, "baseline": { "stateAdherence": n, "intentAccuracy": n, "toneFit": n, "worstIssue": "short phrase" }`;

function toScore(raw: any): JudgeScore | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = (n: unknown) => Math.max(0, Math.min(10, Math.round(Number(n)) || 0));
  const stateAdherence = c(raw.stateAdherence);
  const intentAccuracy = c(raw.intentAccuracy);
  const toneFit = c(raw.toneFit);
  const overall = (stateAdherence + intentAccuracy + toneFit) / 3;
  const worstIssue = typeof raw.worstIssue === "string" ? raw.worstIssue.slice(0, 120) : "unspecified";
  // A human looks at anything weak on any axis — that's where regressions hide.
  const needsHumanReview = stateAdherence <= 4 || intentAccuracy <= 4 || toneFit <= 4 || overall < 6;
  return { stateAdherence, intentAccuracy, toneFit, overall, worstIssue, needsHumanReview };
}

export interface JudgeInput {
  clientMessage: string;
  stateBlurb: string;         // the compiled understanding (what the coach knew)
  candidateReply: string;     // the new engine's reply
  baselineReply?: string;     // the current production reply (shadow comparison)
  candidateModel?: string;    // the model that WROTE the candidate — the judge picks a different one
  userId?: string | null;
}

// Law 12 — no self-judging. The judge must never run on the same model that wrote the
// reply, or it grades with the same blind spots. Pick the opposite of the writer's model.
function pickJudgeModel(candidateModel?: string): "gpt-4o" | "gpt-4o-mini" {
  return candidateModel === "gpt-4o" ? "gpt-4o-mini" : "gpt-4o";
}

export async function judgeReply(openai: OpenAI, input: JudgeInput): Promise<JudgeComparison | null> {
  const { clientMessage, stateBlurb, candidateReply, baselineReply, candidateModel, userId } = input;
  try {
    assertAiOnline("judge");
    const judgeModel = pickJudgeModel(candidateModel);
    const system = JUDGE_SYSTEM.replace("%BASELINE%", baselineReply ? BASELINE_SLOT : "");
    const userParts = [
      `CLIENT STATE (what the coach knew): ${stateBlurb || "(none)"}`,
      `CLIENT MESSAGE: "${clientMessage.slice(0, 800)}"`,
      `CANDIDATE REPLY: "${candidateReply.slice(0, 800)}"`,
    ];
    if (baselineReply) userParts.push(`BASELINE (current production) REPLY: "${baselineReply.slice(0, 800)}"`);

    const resp = await openai.chat.completions.create({
      model: judgeModel,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts.join("\n\n") },
      ],
    });
    recordGptCost({
      userId: userId ?? null,
      model: judgeModel,
      feature: "judge",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    const candidate = toScore(parsed.candidate);
    if (!candidate) return null;
    const baseline = baselineReply ? toScore(parsed.baseline) : undefined;

    let winner: JudgeComparison["winner"];
    if (baseline) {
      if (candidate.overall > baseline.overall + 0.5) winner = "candidate";
      else if (baseline.overall > candidate.overall + 0.5) winner = "baseline";
      else winner = "tie";
    }
    const needsHumanReview = candidate.needsHumanReview || (baseline?.needsHumanReview ?? false) || winner === "tie";
    return { candidate, baseline, winner, needsHumanReview };
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[JUDGE] scoring failed (skipping):", (e as any)?.message || e);
    return null;
  }
}
