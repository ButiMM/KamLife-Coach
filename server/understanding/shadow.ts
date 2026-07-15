/**
 * Shadow runner (blueprint Days 1-10 — the dual-write loop).
 *
 * For a real conversational message, the CURRENT system replies to the client as always.
 * This runs the new Meaning Engine SILENTLY on the same message, has the Judge score the
 * new reply against the production reply, logs the comparison, and files anything weak or
 * tied into the founder review queue. The client sees nothing different.
 *
 * This is how we prove the rebuild before it ever touches a client: watch the new engine
 * beat production for 5 straight days on real traffic, then flip. No guessing, no big-bang.
 *
 * Contract: FIRE-AND-FORGET and flag-gated (SHADOW_ENGINE=on, off by default). It never
 * throws, never blocks, never delays or alters the real reply.
 */

import type OpenAI from "openai";
import { seedUnderstanding } from "./seed";
import { runMeaningEngine } from "./meaning-engine";
import { compileStateBlurb } from "./compiler";
import { judgeReply } from "../eval/judge";
import { captureQualitySignal } from "../quality-signals";

export function shadowEnabled(): boolean {
  return process.env.SHADOW_ENGINE === "on";
}

export interface ShadowInput {
  openai: OpenAI;
  user: any;
  phone?: string;
  message: string;
  productionReply: string;           // what the client actually got
  snapshot?: string;                 // real DB numbers, if available
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Kick off a shadow evaluation. Returns immediately; the work runs detached.
 * Safe to call on every conversational turn — it no-ops unless SHADOW_ENGINE=on.
 */
export function runShadowEval(input: ShadowInput): void {
  if (!shadowEnabled()) return;
  const { openai, user, phone, message, productionReply, snapshot, history } = input;
  (async () => {
    try {
      const prior = seedUnderstanding(user, snapshot);
      const result = await runMeaningEngine({ openai, user, message, prior, snapshot, history });
      if (!result) {
        console.log(`[SHADOW] engine produced nothing for "${message.slice(0, 60)}"`);
        return;
      }
      const blurb = compileStateBlurb(result.state);
      const verdict = await judgeReply(openai, {
        clientMessage: message,
        stateBlurb: blurb,
        candidateReply: result.reply,
        baselineReply: productionReply,
        userId: user?.id,
      });
      if (!verdict) {
        console.log(`[SHADOW] judge unavailable for "${message.slice(0, 60)}"`);
        return;
      }
      const c = verdict.candidate;
      const b = verdict.baseline;
      console.log(
        `[SHADOW] winner=${verdict.winner ?? "n/a"} ` +
        `cand=${c.overall.toFixed(1)}(s${c.stateAdherence}/i${c.intentAccuracy}/t${c.toneFit}) ` +
        `base=${b ? b.overall.toFixed(1) + `(s${b.stateAdherence}/i${b.intentAccuracy}/t${b.toneFit})` : "n/a"} ` +
        `model=${result.model} flag=${verdict.needsHumanReview} msg="${message.slice(0, 60)}"`,
      );
      // Only the weak/tied cases go to the human queue — the whole point of the Judge.
      if (verdict.needsHumanReview) {
        captureQualitySignal("shadow_review", {
          userId: user?.id,
          phone,
          messageIn: message,
          messageOut: result.reply,
          detail: `winner=${verdict.winner} cand=${c.overall.toFixed(1)} base=${b?.overall.toFixed(1) ?? "-"} candIssue="${c.worstIssue}" prodReply="${productionReply.slice(0, 160)}"`,
        });
      }
    } catch (e) {
      console.warn("[SHADOW] eval failed (non-fatal):", (e as any)?.message || e);
    }
  })();
}
