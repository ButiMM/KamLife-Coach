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
import { loadUnderstanding, saveUnderstanding } from "./store";
import { evaluateTurn } from "../eval/evaluate";
import { captureQualitySignal } from "../quality-signals";
import { buildClientSnapshot } from "../brain/client-snapshot";

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
      // Ground the engine in the client's REAL numbers so the Judge can score state
      // adherence honestly (built here, in the detached shadow job — never on the client's
      // critical path). Falls back to no-snapshot if it's unavailable.
      const grounded = snapshot ?? await buildClientSnapshot(user).catch(() => undefined);
      // Durable prior: what we already understand about this person, merged onto this turn.
      const prior = user?.id ? await loadUnderstanding(user.id, seedUnderstanding(user, grounded)) : seedUnderstanding(user, grounded);
      const result = await evaluateTurn({ openai, user, message, productionReply, snapshot: grounded, prior, history });
      if (!result) {
        console.log(`[SHADOW] engine/judge produced nothing for "${message.slice(0, 60)}"`);
        return;
      }
      // Persist the EVOLVED understanding (durable subset only) — the client's cortex
      // grows every message, even while the engine is still in shadow. When we flip it
      // live, the memory is already there.
      if (user?.id) await saveUnderstanding(user.id, result.state);
      const verdict = result.verdict;
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
          messageOut: result.candidateReply,
          detail: `winner=${verdict.winner} cand=${c.overall.toFixed(1)} base=${b?.overall.toFixed(1) ?? "-"} candIssue="${c.worstIssue}" prodReply="${productionReply.slice(0, 160)}"`,
        });
      }
    } catch (e) {
      console.warn("[SHADOW] eval failed (non-fatal):", (e as any)?.message || e);
    }
  })();
}
