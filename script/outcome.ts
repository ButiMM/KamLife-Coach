/**
 * THE POSITIVE-OUTCOME LAW (issue #63, item 1.2).
 *
 *   A customer-facing test must prove the intended outcome OCCURRED.
 *   "The bad response disappeared" is not evidence that the client was served.
 *
 * WHY THIS IS A HELPER AND NOT A CONVENTION. #61 shipped green. Its fixture read:
 *
 *     assert.ok(!/rest today|hit it fresh tomorrow/i.test(reply), …)
 *
 * The wrong answer was gone, the check passed, and the customer was asked about food instead of
 * being given the session they had just said they moved. Comprehension was correct
 * (`readTrainingDay` returns `moved_to_today`), no downstream owner consumed it, and the turn fell
 * to the generic ladder. A negative assertion cannot see that, because "not rest today" is
 * satisfied by silence, by a crash fallback, and by an answer to a different question.
 *
 * Conventions do not survive a tired afternoon. A signature that will not compile without a
 * positive expectation does.
 */

import assert from "node:assert/strict";

export interface Outcome {
  /** What the client must actually receive. REQUIRED — this is the whole point. */
  got: RegExp | ((reply: string) => boolean);
  /** What must not appear. Optional, and never sufficient on its own. */
  notGot?: RegExp;
  /** The customer sentence in one line: what should have happened, and why it matters. */
  because: string;
  /**
   * A KNOWN PRODUCT DEFECT this assertion is waiting on, e.g. "#63 moved_to_today has no consumer".
   *
   * Reports instead of failing — but only in one direction. If a pending outcome starts PASSING it
   * fails loudly, so a fixed defect cannot leave a permanent excuse behind in the suite. That is
   * what stops this from becoming a way to mute assertions.
   */
  pending?: string;
}

/** Collected so a suite can print what it did not enforce. Never silent. */
export const PENDING: Array<{ because: string; pending: string }> = [];

export function assertCustomerOutcome(reply: string, spec: Outcome): void {
  const text = String(reply ?? "");
  const hit = typeof spec.got === "function" ? spec.got(text) : spec.got.test(text);

  if (spec.pending) {
    if (hit) {
      throw new Error(
        `PENDING OUTCOME NOW PASSES — remove the pending marker.\n` +
        `      ${spec.because}\n      was waiting on: ${spec.pending}\n` +
        `      Leaving it pending would let this regress again unnoticed.`);
    }
    PENDING.push({ because: spec.because, pending: spec.pending });
    return;
  }

  // A crash fallback satisfies almost any negative assertion, so it is refused first and by name.
  assert.ok(text.trim().length > 0, `no reply at all — ${spec.because}`);
  assert.ok(!/something went wrong on my side|give me a second and try again/i.test(text),
    `the pipeline crashed and returned its apology, which passes any "the bad string is absent" ` +
    `check — ${spec.because}:\n      ${text.slice(0, 160)}`);

  assert.ok(hit,
    `the client did not get the outcome. ${spec.because}\n` +
    `      Note: the forbidden response may well be absent — that is not the same as being served.\n` +
    `      got: ${text.slice(0, 220)}`);

  if (spec.notGot) {
    assert.ok(!spec.notGot.test(text),
      `the forbidden response is present. ${spec.because}\n      got: ${text.slice(0, 220)}`);
  }
}

/** Printed at the end of a suite so an unenforced outcome is visible on every run. */
export function reportPending(): void {
  if (!PENDING.length) return;
  console.log(`\n⊘ ${PENDING.length} customer outcome(s) asserted but NOT ENFORCED — known defects:`);
  for (const p of PENDING) console.log(`  ⊘ ${p.because}\n      waiting on: ${p.pending}`);
  console.log("  These are the outcomes a client is not getting today.");
}
