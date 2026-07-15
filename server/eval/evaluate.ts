/**
 * evaluateTurn — the one place a single turn is run through the new Meaning Engine and
 * scored against the reply production actually gave. Shared by:
 *   - the LIVE shadow (understanding/shadow.ts): fire-and-forget on real traffic.
 *   - the REPLAY harness (script/replay-harness.ts): dry-run over historical conversations
 *     (blueprint Days 21-30 — "dry-run 100 historical conversations"). This is how we get
 *     objective signal WITHOUT needing live volume: we already own the traffic in the DB.
 *
 * It carries the UnderstandingState in and out, so a replay can thread understanding
 * across the turns of one real conversation exactly as production would over time.
 */

import type OpenAI from "openai";
import { seedUnderstanding } from "../understanding/seed";
import { runMeaningEngine } from "../understanding/meaning-engine";
import { compileStateBlurb } from "../understanding/compiler";
import { judgeReply, type JudgeComparison } from "./judge";
import type { UnderstandingState } from "../understanding/state";

export interface EvaluateInput {
  openai: OpenAI;
  user: any;
  message: string;
  productionReply: string;
  snapshot?: string;
  /** carry understanding across turns of one conversation; seeded if omitted */
  prior?: UnderstandingState;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface EvaluateResult {
  candidateReply: string;
  verdict: JudgeComparison;
  state: UnderstandingState;
  blurb: string;
  model: string;
}

export async function evaluateTurn(input: EvaluateInput): Promise<EvaluateResult | null> {
  const { openai, user, message, productionReply, snapshot, prior, history } = input;
  const priorState = prior ?? seedUnderstanding(user, snapshot);

  const engine = await runMeaningEngine({ openai, user, message, prior: priorState, snapshot, history });
  if (!engine) return null;

  const blurb = compileStateBlurb(engine.state);
  const verdict = await judgeReply(openai, {
    clientMessage: message,
    stateBlurb: blurb,
    candidateReply: engine.reply,
    baselineReply: productionReply,
    candidateModel: engine.model, // Law 12 — judge runs on a DIFFERENT model than the writer
    userId: user?.id,
  });
  if (!verdict) return null;

  return { candidateReply: engine.reply, verdict, state: engine.state, blurb, model: engine.model };
}
