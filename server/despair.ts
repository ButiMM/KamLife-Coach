/**
 * DESPAIR — "this isn't working", and who is allowed to answer it.
 *
 * (2026-07-29 sweep.) It is the commonest thing a client says just before they quit, and it
 * matched nothing. The frustration intercept listed "doesn't work" but not "isn't working". The
 * progress command, meanwhile, had a bare `working\??` alternative that matches the word
 * ANYWHERE — so the message was claimed by a scorecard and answered with:
 *
 *     ❌ Training: 0/3 sessions this week
 *     *First step:* Log every meal this week. Without data, I am coaching blind.
 *
 * Every number correct, at the worst possible moment, reading as though it were their fault.
 *
 * Two call sites need this and they must never disagree: the frustration intercept has to CLAIM
 * the message, and the progress command has to DECLINE it. When those two lists drift the
 * message falls between them, which is exactly what happened. So the rule lives here once.
 *
 * Pure — no DB, no model. Unit-tested.
 */

// Two shapes, because the negation lives in different places.
//
// A NEUTRAL subject needs an explicit negation: "this isn't working", "it's not working". The
// contraction is optional and may be typed without the apostrophe — "its not working" is how it
// actually arrives on a phone, and an earlier draft of this file missed exactly that.
const NEUTRAL = String.raw`(?:this|it|that)(?:.?s)?\s*(?:is\s*n.?t|isn.?t|ain.?t|not)\s+working`;
// An ALREADY-NEGATIVE subject carries it alone: "nothing is working", "none of this is working".
const NEGATIVE = String.raw`(?:nothing|none of (?:this|it))(?:.?s)?\s*(?:is|.s)?\s*working`;

const NOT_WORKING = new RegExp(String.raw`\b(?:${NEUTRAL}|${NEGATIVE})\b|\bnot working for me\b|\bnever works?\b`, "i");

/**
 * Are they telling us it is not working? Deliberately broad about WHO is speaking and narrow
 * about WHAT they mean, because both readings deserve a human answer: somebody discouraged by
 * their results and somebody whose payment link is broken both want "what exactly went wrong —
 * tell me and I'll fix it", and neither wants a progress table.
 */
export function saysNotWorking(m: string): boolean {
  return NOT_WORKING.test(m || "");
}

/**
 * A status report answers a QUESTION. This is the guard the progress command uses to decline a
 * message that only looks like one because it contains the word "working". Wider than
 * saysNotWorking on purpose — a scorecard is the wrong reply to any of these, whoever ends up
 * handling it.
 */
// "Giving up" and "I'm done" are only OURS when they are about this. "I feel like giving up on
// my career" is a conversation, and forcing it onto deterministic rails would hand a person
// venting about their job a fitness scorecard. So these fire only when the phrase ENDS the
// clause, or is aimed at the programme — never when it is aimed at something else in their life.
const QUITTING = /\b(?:i give up|giving up|i.?m done|i am done)\b(?=[.!?,]|\s*$|\s+on\s+(?:this|it|everything|the (?:programme|program|plan|diet|gym)))/i;

export function isDespairNotAQuestion(m: string): boolean {
  const s = m || "";
  return saysNotWorking(s) || /\b(?:is\s*n.?t|.?s not|isn.?t|ain.?t|not)\s+working\b/i.test(s) || QUITTING.test(s);
}
