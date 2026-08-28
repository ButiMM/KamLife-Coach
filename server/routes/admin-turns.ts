import type { Express } from "express";
import { db } from "../db";
import { sql, eq, and, gte, lte, desc, inArray } from "drizzle-orm";
import { turnLedger, adminEvents, users } from "../../shared/schema";
import { requireAdminKey } from "./auth";

/**
 * THE TURN TRIAGE SURFACE — a reader for the forensic record we were already keeping.
 *
 * WHY THIS EXISTS. turn_ledger has recorded the MECHANISM of every turn since 2026-08-10 — the
 * state a turn read, every write it made in order, the reply it sent, its latency, and the build
 * SHA that produced it. On 2026-08-25 an audit found exactly one reference to that table in the
 * entire server: the INSERT. Two weeks of forensic data, and nothing could look at it.
 *
 * That is the same shape as every recurrence we traced that day — the capability exists and the
 * last link is missing. The vision acceptance test disabled for want of a fixture URL. Four CI
 * suites reachable only through a path filter. A client-snapshot fix that gpt.ts never got. An
 * owner that was correct while a caller hand-built the old string beside it. This file is the
 * missing link for the fifth one, and it is deliberately a READER, not a new system.
 *
 * WHAT IT CHANGES. A tester says "this reply was terrible." Instead of archaeology, you open that
 * turn and read: build 1b49633, input=voice, state read = X, mutations = Y, reply = Z. Then you
 * record a verdict — which of the five layers failed — and the lifecycle carries it to the only
 * state that means anything, `revalidated`.
 *
 * ── POPIA (settled before this shipped, not after) ────────────────────────────────────────────
 *
 * This view shows raw client conversation. That is not a new exposure — /admin/activity already
 * renders raw client messages behind this same guard — but two things here ARE new and were
 * decided deliberately:
 *
 *  1. stateRead and mutations can carry weight values and sick-hold state. That is health data:
 *     SPECIAL personal information under POPIA s26, a higher bar than message text. It is shown
 *     unredacted, because a mechanism trace with the mechanism removed answers nothing — but it
 *     is shown knowingly, and that is why (2) exists.
 *
 *  2. EVERY READ IS AUDITED. admin_events previously recorded only write actions (force_activate,
 *     manual_cancel); looking at a client's data left no trace at all. For health data the read
 *     log is the control that actually matters, so every list and every detail view writes a row.
 *     The audit write must never block the read — a failed log is warned about, not thrown.
 *
 * Retention is 90 days, enforced by purgeExpiredTurns() (below), called from the daily ops job.
 * Long enough to investigate a complaint weeks later and to measure whether a fix held across a
 * release; short enough to be a defensible minimisation position.
 *
 * WHAT THIS DOES NOT DO. It does not fix admin identity. Access is a single shared
 * COACH_DASHBOARD_KEY, so the audit records THAT a client's data was read and when, but cannot
 * say by whom. That gap is pre-existing and real; naming it here so it is not mistaken for
 * solved.
 */

/** The five layers a turn can fail at. The whole point is that these are distinguishable. */
const FAILURE_CATEGORIES = ["STATE", "UNDERSTANDING", "REASONING", "ACTION", "RESPONSE"] as const;

/**
 * observed -> confirmed -> fixed -> deployed -> revalidated
 *
 * Ordered deliberately. "fixed" is a claim about a diff, "deployed" a claim about a build; only
 * "revalidated" means someone replayed this conversation against the build that shipped and it
 * behaved. Every "we fixed it but it still happens" we traced stopped at one of the first three.
 */
const LIFECYCLE = ["observed", "confirmed", "fixed", "deployed", "revalidated"] as const;

const RETENTION_DAYS = 90;

/** Exported so the retention rule is testable as a value, not inferred from a delete statement. */
export function retentionCutoff(now: number = Date.now()): Date {
  return new Date(now - RETENTION_DAYS * 86_400_000);
}

export type VerdictPatch = { failureCategory?: string | null; lifecycleStatus?: string | null; fixRef?: string | null; triageNote?: string | null; triagedAt?: Date };

/**
 * THE CLOSED VOCABULARIES, ENFORCED HERE RATHER THAN IN THE ROUTE.
 *
 * Free-text categories would make the one number this table exists to produce — a countable
 * failure distribution — unmeasurable inside a week: "RESPONSE", "response", "output layer" and
 * "mouth" would be four categories describing one thing. So an unknown value is REFUSED, not
 * coerced and not stored.
 *
 * Extracted from the handler so it can be tested against real inputs; the route is then a thin
 * adapter over it. Returns the patch to apply, or the message explaining the refusal.
 */
export function validateVerdict(body: any): { ok: true; patch: VerdictPatch } | { ok: false; message: string } {
  const { failureCategory, lifecycleStatus, fixRef, triageNote } = body || {};
  const patch: VerdictPatch = {};

  if (failureCategory !== undefined) {
    if (failureCategory !== null && !FAILURE_CATEGORIES.includes(failureCategory)) {
      return { ok: false, message: `failureCategory must be one of ${FAILURE_CATEGORIES.join(", ")}` };
    }
    patch.failureCategory = failureCategory;
  }
  if (lifecycleStatus !== undefined) {
    if (lifecycleStatus !== null && !LIFECYCLE.includes(lifecycleStatus)) {
      return { ok: false, message: `lifecycleStatus must be one of ${LIFECYCLE.join(", ")}` };
    }
    patch.lifecycleStatus = lifecycleStatus;
  }
  // Bounded, because both land in an admin page: an unbounded note is a stored-XSS payload
  // budget, and the page escapes on render but the cap is the belt.
  if (fixRef !== undefined) patch.fixRef = fixRef ? String(fixRef).slice(0, 200) : null;
  if (triageNote !== undefined) patch.triageNote = triageNote ? String(triageNote).slice(0, 2000) : null;

  if (!Object.keys(patch).length) return { ok: false, message: "Nothing to update" };
  patch.triagedAt = new Date();
  return { ok: true, patch };
}

/**
 * Records that a client's conversation data was read. Fire-and-forget by design: an audit
 * failure must never deny a legitimate read, but it must be visible when it happens.
 */
async function auditRead(action: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(adminEvents).values({ action, meta, reason: "turn triage" });
  } catch (e) {
    console.warn("[TURN_TRIAGE] audit write failed:", (e as any)?.message);
  }
}

/**
 * POPIA minimisation, enforced rather than declared. Called from the daily ops job rather than
 * its own cron — a new cron registration would break a frozen budget for a job that has no
 * reason to keep its own clock.
 */
export async function purgeExpiredTurns(): Promise<number> {
  try {
    const cutoff = retentionCutoff();
    const gone = await db.delete(turnLedger).where(lte(turnLedger.createdAt, cutoff)).returning({ id: turnLedger.id });
    if (gone.length) console.log(`[TURN_TRIAGE] purged ${gone.length} turns older than ${RETENTION_DAYS}d`);
    return gone.length;
  } catch (e) {
    console.warn("[TURN_TRIAGE] purge failed:", (e as any)?.message);
    return 0;
  }
}

/**
 * COACH HEALTH — the adjudicated failures, counted automatically (2026-08-27).
 *
 * THE PROBLEM THIS SOLVES. Every failure this project has fixed arrived the same way: the founder
 * noticed it on his own phone, screenshotted it, and described it. That makes one person the
 * sensor for the whole product, and it means a failure is only ever as discoverable as his
 * attention. turn_ledger has been recording the mechanism of every turn since 2026-08-10, and the
 * triage surface above can already read it — but only a HUMAN verdict (failure_category) puts a
 * turn in the queue, so nothing is found that nobody looked at.
 *
 * WHAT THESE RULES ARE, AND ARE NOT. Each one is a failure we already traced, implemented, proved
 * with controls, and merged. They are not invented categories and there is no model judging
 * anything: a rule names a customer meaning as a pattern over the client's own words, and the
 * property the reply had to have. That is exactly what each cut's contract test asserts — the
 * same rule, pointed at production instead of a fixture.
 *
 * WHY IT LIVES HERE. This file is already the reader of turn_ledger, and the architecture governor
 * counts modules under server/: a new file for four regexes would be a new architectural failure
 * to save an import. The rules sit beside the queue they feed.
 *
 * A RULE IS ONLY ADDED AFTER ADJUDICATION. Not when a failure is suspected — when it has been
 * proved, fixed and merged. That keeps the count honest: every row here is a regression watch on
 * work that is already done, so a non-zero count means the fix is not holding in production.
 */
type HealthRule = {
  id: string;
  label: string;
  layer: "Claim" | "Decision" | "Response" | "Coaching";
  fixRef: string;
  expected: string;
  /**
   * WHEN THE FIX LANDED ON MAIN — the commit date of the squash merge, not an estimate.
   *
   * A COUNT WITHOUT THIS IS A LIE (2026-08-27, CTO review of the first version). The page said a
   * non-zero count meant "a merged fix is not holding in production". It scanned a 1/7/30-day
   * window and applied each rule to every row in it, so a turn from BEFORE the fix merged — where
   * the failure is the expected, already-corrected behaviour — was counted exactly the same as a
   * genuine regression. "7 failures" could have been seven turns that the fix has since repaired.
   */
  fixedAt: string;
  /**
   * WHAT PUTS A TURN IN THE DENOMINATOR. A `request` rule is triggered by the client's words, so
   * the denominator is how many people asked. A `mutation` rule is triggered by what the turn
   * WROTE, so every scanned turn is a candidate and calling them "asked" would be a false
   * operator statistic — 88 turns scanned is not 88 people asking for anything.
   */
  trigger: "request" | "mutation";
  /** Does this turn ask the question the rule is about? Read from the client's own words. */
  asks: (input: string) => boolean;
  /** Given it was asked, did the reply fail to carry what was owed? */
  failed: (turn: { reply: string; mutations: string[] }) => boolean;
};

const lastBlockIsAMove = (reply: string) => {
  const blocks = String(reply || "").trim().split(/\n\s*\n/);
  const last = (blocks[blocks.length - 1] || "").trim();
  return blocks.length > 1 && !last.includes("?") && !/\[(?:BUTTONS|MEDIA)/i.test(last);
};

/**
 * IS THIS HIT A REGRESSION, OR THE FAILURE WE ALREADY FIXED?
 *
 * Exported because it is the property the whole page rests on: a turn from before the fix merged
 * is the old behaviour doing exactly what we found it doing, and counting it as "the fix is not
 * holding" would make the number mean the opposite of what the page says. Graded in the contract
 * suite against both sides of each fix's merge instant.
 */
export function isRegression(rule: Pick<HealthRule, "fixedAt">, turnAt: Date | string | number): boolean {
  return new Date(turnAt).getTime() >= Date.parse(rule.fixedAt);
}

export const COACH_HEALTH_RULES: HealthRule[] = [
  {
    id: "plate-ask-routing",
    label: "Plate-ask reached the meal-plan owner",
    layer: "Claim", fixRef: "#86",
    fixedAt: "2026-08-27T12:14:47+02:00", trigger: "request",
    expected: "Next Meal Suggestion, not a 3-day plan",
    asks: i => /\bwhat (?:can|should|must) i eat\b/i.test(i)
      && !/\bthis week\b/i.test(i)
      && !/\b(breakfast|lunch|dinner|supper|braai)\b/i.test(i),
    failed: t => /3-Day Meal Plan/i.test(t.reply) || !/Next Meal Suggestion/i.test(t.reply),
  },
  {
    id: "goal-distance-missing",
    label: "Distance question answered without the distance",
    layer: "Response", fixRef: "#85",
    fixedAt: "2026-08-27T11:03:23+02:00", trigger: "request",
    expected: "kg to go, and the goal weight",
    asks: i => /\bhow far (?:am i|are we) (?:from|to)\b/i.test(i) && /\b(goal|target)\b/i.test(i),
    failed: t => !/\bto (?:go|gain)\b|at your goal weight/i.test(t.reply),
  },
  {
    id: "meal-for-calories-claim",
    label: "Meal request answered with a calorie readout",
    layer: "Claim", fixRef: "#81",
    fixedAt: "2026-08-27T09:19:40+02:00", trigger: "request",
    expected: "a meal, not the day's totals",
    asks: i => /\b(?:give|send|show|suggest|recommend)\s+(?:me\s+)?(?:a|an|another|the)?\s*meal\b/i.test(i),
    failed: t => !/Next Meal Suggestion/i.test(t.reply) && /kcal\b.*\bleft\b|\d+\s*\/\s*\d+\s*kcal/i.test(t.reply),
  },
  {
    id: "step-raise-no-move",
    label: "Step raise ended in a receipt, no next move",
    layer: "Coaching", fixRef: "#84",
    fixedAt: "2026-08-27T10:37:40+02:00", trigger: "mutation",
    expected: "one coaching move after the write",
    asks: () => true,   // decided by the WRITE, not the wording — see below
    failed: t => t.mutations.some(mm => /UPDATE steps/i.test(mm)) && !lastBlockIsAMove(t.reply),
  },
];

/**
 * WHAT THIS CANNOT SEE, stated here rather than discovered later.
 *
 * The closed-day card contradiction (#83) is NOT in the list above and cannot be. Its failure is
 * a line of text rendered into a PNG, and turn_ledger stores the marker, not the pixels. A rule
 * that matched on the marker would count cards, not contradictions — a number that looks like
 * evidence and is not. It stays a contract-suite property until the card's next-move line is
 * recorded on the turn.
 *
 * The step-raise rule is also the one to read carefully: it is triggered by the MUTATION, not by
 * the client's words, so `asks` is unconditional and the whole judgement sits in `failed`. That
 * is correct for a coaching-contract rule and wrong for a claim rule, which is why the two kinds
 * are not merged into one shape.
 */
const CANNOT_SURFACE = [
  { id: "closed-day-card", fixRef: "#83", why: "the card's next-move line is rendered into a PNG; the ledger stores the marker, not the pixels" },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * COACH HEALTH V2 — WHAT NOBODY HAS ADJUDICATED YET (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * V1 watches four failures we already fixed. That answers "are our fixes holding" and NOTHING
 * about what else is broken — so the founder was still the only sensor for anything new. This is
 * the half that finds the unknown.
 *
 * THE DISCIPLINE THAT MAKES IT SAFE. An invariant here never says "this is a defect". It says a
 * property the coach is supposed to hold did not hold on this turn, and attaches the turn. That
 * distinction is the whole design: a detector that declares defects would flood the queue with
 * confident nonsense, and every hour spent disproving it is an hour not spent fixing the product.
 * Candidates are ranked evidence, and adjudication stays with a human.
 *
 * WHY RULES AND NOT A MODEL. A model asked "was this reply good?" produces an opinion that cannot
 * be controlled, cannot be reproduced, and costs money per turn — and it would run precisely when
 * nobody is watching it. Every check below is a property over fields the ledger already stores,
 * so it is free, deterministic, and reviewable as code.
 *
 * WHAT IT CANNOT SEE, and this bounds every count below: turn_ledger stores the inbound text, the
 * state read, the mutations, the outbound reply, the latency and the build. It does NOT store the
 * claimant. So "the wrong door answered" is only visible where the REPLY betrays it — a plan when
 * a plate was asked for, a fallback where an owner exists. A claim defect whose reply looks
 * plausible is invisible here, and stamping the claimant on the turn is the cut that would fix
 * that. Named so the absence is not mistaken for health.
 */
type Invariant = {
  id: string;
  label: string;
  layer: "Claim" | "State" | "Decision" | "Response" | "Coaching";
  /** What the coach was supposed to do. Shown next to every candidate. */
  expected: string;
  holds: (t: { input: string; reply: string; mutations: string[]; state: any }) => boolean;
};

const FALLBACK_REPLY = /didn'?t (?:quite )?catch that|say it another way|had a moment|try that again|i'?m not sure what you mean/i;
const SELLS_FOOD_NOW = /\b(?:eat|have)\b[^.!?]{0,40}\b(?:now|tonight|next meal|this afternoon)\b|next two meals|get a real protein into/i;
const CLOSES_THE_DAY = /that'?s the day|day'?s done|day'?s wrapped|tomorrow[^.!?]{0,40}\b(?:breakfast|first meal)\b/i;
const DURABLE_MUTATION = /\b(?:INSERT|UPDATE)\s+(?:meal|steps|water|weight|workout)/i;
const ASKS_SOMETHING = /\?\s*$|^(?:what|when|where|why|how|which|who|can i|should i|is it|do i|am i|are we)\b/i;

export const COACH_HEALTH_INVARIANTS: Invariant[] = [
  {
    id: "unowned-message",
    label: "The coach did not understand a message",
    layer: "Claim",
    expected: "an owner answers, or the coach asks one specific question back",
    // The fallback is the shape of "no door claimed this". It is not always a defect — a genuinely
    // unparseable message exists — which is exactly why it is a candidate and clusters by wording.
    holds: t => !FALLBACK_REPLY.test(t.reply),
  },
  {
    id: "question-mutated-state",
    label: "A question changed tracking state",
    layer: "State",
    expected: "a question is answered, never written",
    // LAW 2 of the tracking contract, watched in production. The costliest class we have: a false
    // write is invisible to the client and enters every downstream decision.
    holds: t => !(ASKS_SOMETHING.test(t.input.trim()) && t.mutations.some(m => DURABLE_MUTATION.test(m))),
  },
  {
    id: "durable-write-no-move",
    label: "A durable write ended in a receipt",
    layer: "Coaching",
    expected: "one next coaching move after a durable change",
    // LAW 4, generalised past steps to every domain that writes. #84 was one instance of this.
    holds: t => !(t.mutations.some(m => DURABLE_MUTATION.test(m)) && !lastBlockIsAMove(t.reply)),
  },
  {
    id: "reply-contradicts-itself",
    label: "One reply both closed the day and sold food",
    layer: "Response",
    expected: "one decision, one voice",
    // The text-only half of the #83 contradiction: the card is a PNG, but a reply that says both
    // in words is visible here.
    holds: t => !(CLOSES_THE_DAY.test(t.reply) && SELLS_FOOD_NOW.test(t.reply)),
  },
  {
    id: "empty-reply",
    label: "The client received nothing",
    layer: "Response",
    expected: "every turn answers",
    holds: t => t.reply.trim().length > 0,
  },
];

/**
 * THE SIGNATURE A CANDIDATE CLUSTERS ON.
 *
 * Turns are grouped by (invariant, shape of the question) so the queue reads "this KIND of message
 * keeps doing this", not "here are 400 unrelated turns". Numbers, punctuation and the filler that
 * varies between people are stripped, and the first few content words carry the meaning: "im
 * hungry what can i eat" and "I'm hungry, what can I eat?" land together.
 *
 * Deliberately crude. A cleverer similarity measure would merge things that are not the same
 * question and produce a confident cluster nobody can act on — the failure mode of this whole
 * feature is a queue that wastes engineering hours, not a queue that misses a variant.
 */
const STOPWORDS = new Set(["the", "a", "an", "my", "me", "i", "im", "is", "it", "to", "for", "of", "and", "please", "hey", "hi", "coach", "kam"]);

/**
 * A SHORT, STABLE REFERENCE for one candidate — "CH-3F2A" — so it can be named in a brief, a
 * commit message or a conversation and still mean the same cluster tomorrow. Derived from the
 * cluster's own identity rather than stored, so it needs no table and cannot drift from what it
 * points at. Same invariant plus same message shape always yields the same handle.
 */
export function candidateRef(invariantId: string, signature: string): string {
  let h = 2166136261;
  for (const ch of `${invariantId}::${signature}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 4);
}
export function candidateSignature(input: string): string {
  const words = String(input || "").toLowerCase()
    .replace(/[0-9]+/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
  return words.slice(0, 5).join(" ") || "(no words)";
}

export function registerAdminTurns(app: Express) {
  // ── COACH HEALTH ────────────────────────────────────────────────────────────────────────────
  // Rule-based, no model, no new telemetry: it reads the turns the ledger already holds.
  // ── THE MORNING BRIEF ───────────────────────────────────────────────────────────────────────
  // Known regressions, unknown candidates, unexercised rules and build warnings — computed from
  // the ledger on read. There is no second store and no background job: the evidence persists
  // because turn_ledger persists, which is what lets a weekend of testing accumulate while every
  // agent involved in this project is switched off.
  app.get("/api/admin/coach-health/brief", requireAdminKey, async (req: any, res) => {
    try {
      const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || "1"))));
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await db.select({
        id: turnLedger.id, userId: turnLedger.userId, createdAt: turnLedger.createdAt,
        inputText: turnLedger.inputText, reply: turnLedger.reply,
        mutations: turnLedger.mutations, stateRead: turnLedger.stateRead,
        version: turnLedger.version, lifecycleStatus: turnLedger.lifecycleStatus,
        failureCategory: turnLedger.failureCategory,
        fixRef: turnLedger.fixRef,
      })
        .from(turnLedger)
        .where(gte(turnLedger.createdAt, since))
        .orderBy(desc(turnLedger.createdAt))
        .limit(5000);

      const shaped = rows.map(r => ({
        row: r,
        input: String(r.inputText || ""),
        reply: String(r.reply || ""),
        mutations: Array.isArray(r.mutations) ? (r.mutations as string[]).map(String) : [],
        state: r.stateRead,
      }));

      // ── KNOWN REGRESSIONS: the V1 rules, post-fix only, so this half of the brief means what
      // it says. Reusing the same rules rather than restating them keeps one definition.
      const known = COACH_HEALTH_RULES.map(rule => {
        const hits = shaped.filter(t =>
          rule.asks(t.input) && rule.failed({ reply: t.reply, mutations: t.mutations }));
        const since_ = hits.filter(t => isRegression(rule, t.row.createdAt as any));
        const exercised = shaped.filter(t =>
          (rule.trigger === "request" ? rule.asks(t.input) : true) && isRegression(rule, t.row.createdAt as any)).length;
        return { id: rule.id, label: rule.label, fixRef: rule.fixRef, regressions: since_.length, exercised };
      });

      // ── CANDIDATES: an invariant that did not hold, clustered by the shape of the message.
      // NEVER called a defect. The queue is evidence, and adjudication stays with a person.
      const clusters = new Map<string, { invariant: Invariant; signature: string; turns: typeof shaped }>();
      for (const t of shaped) {
        for (const inv of COACH_HEALTH_INVARIANTS) {
          if (inv.holds({ input: t.input, reply: t.reply, mutations: t.mutations, state: t.state })) continue;
          const signature = candidateSignature(t.input);
          const key = `${inv.id}::${signature}`;
          const bucket = clusters.get(key) || { invariant: inv, signature, turns: [] };
          bucket.turns.push(t);
          clusters.set(key, bucket);
        }
      }

      const candidates = [...clusters.values()]
        .map(c => {
          const clients = new Set(c.turns.map(t => t.row.userId)).size;
          const triaged = c.turns.filter(t => !!t.row.failureCategory);
          const withFix = c.turns.filter(t => !!t.row.fixRef);
          const lifecycles = new Set(c.turns.map(t => String(t.row.lifecycleStatus || "")).filter(Boolean));
          return {
          // A STABLE HANDLE, so a candidate can be referred to in a brief, a commit message or a
          // conversation and still be the same thing tomorrow. Derived from what defines the
          // cluster rather than stored, so it survives without a table and cannot drift from its
          // own contents.
          id: `CH-${candidateRef(c.invariant.id, c.signature)}`,
          invariant: c.invariant.id,
          label: c.invariant.label,
          layer: c.invariant.layer,
          expected: c.invariant.expected,
          pattern: c.signature,
          turns: c.turns.length,
          clients,
          firstSeen: c.turns[c.turns.length - 1]?.row.createdAt,
          lastSeen: c.turns[0]?.row.createdAt,
          triaged: triaged.length,
          // THE STATUS IS DERIVED, NOT DECLARED. The per-turn lifecycle already exists and is
          // already editable through PATCH /api/admin/turns/:id — the verdict machinery this file
          // has had since 2026-08-25. A candidate's status is what its turns say, so triaging a
          // turn moves the candidate and there is no second source of truth to fall out of step.
          //
          //   candidate    nobody has ruled on any of these turns yet
          //   adjudicated  a human recorded a failure category
          //   engineering  a fix is claimed against them (fix_ref)
          //   deployed     a build carrying the fix has been recorded
          //   resolved     replayed against that build and behaved
          status: lifecycles.has("revalidated") ? "resolved"
            : lifecycles.has("deployed") ? "deployed"
            : withFix.length ? "engineering"
            : triaged.length ? "adjudicated"
            : "candidate",
          // RANK, SAID OUT LOUD. Breadth beats frequency: nine clients hitting something once is
          // the product misbehaving; one client hitting it nine times is one conversation.
          priority: clients >= 5 ? "high" : clients >= 2 ? "medium" : "low",
          // THE EVIDENCE PACKET — the message and the reply, not a summary of them. Whoever picks
          // this up traces from the client's own words; a paraphrase would be the screenshot
          // problem again, one layer further in.
          examples: c.turns.slice(0, 5).map(t => ({
            turnId: t.row.id, at: t.row.createdAt, version: t.row.version,
            input: t.input.slice(0, 300),
            reply: t.reply.replace(/\n/g, " ").slice(0, 300),
            status: t.row.lifecycleStatus,
          })),
        }; })
        // RANKED BY HOW MANY PEOPLE IT HAPPENED TO, then by how often. One client hitting the same
        // thing nine times is a story about one client; nine clients hitting it once is the product.
        .sort((a, b) => (b.clients - a.clients) || (b.turns - a.turns))
        .slice(0, 40);

      // ── BUILDS: attribution here is merge-time, so a window served by more than one build is
      // the case where a "regression" may just be a turn that ran the old code. Surfaced rather
      // than assumed away.
      const byVersion = new Map<string, number>();
      for (const t of shaped) byVersion.set(String(t.row.version || "?"), (byVersion.get(String(t.row.version || "?")) || 0) + 1);
      const builds = [...byVersion.entries()].map(([version, turns]) => ({ version, turns }))
        .sort((a, b) => b.turns - a.turns);

      await auditRead("coach_health_brief", { days, turns: rows.length });
      res.json({
        windowDays: days,
        turns: rows.length,
        clients: new Set(shaped.map(t => t.row.userId)).size,
        known,
        knownRegressions: known.reduce((s, k) => s + k.regressions, 0),
        unexercised: known.filter(k => k.exercised === 0).map(k => k.fixRef),
        candidates,
        candidateTurns: candidates.reduce((s, c) => s + c.turns, 0),
        builds,
        buildWarning: builds.length > 1
          ? `${builds.length} builds served turns in this window — a regression may be a turn that ran the old code`
          : null,
        // The queue is evidence. It is not a defect list, and the page must not render it as one.
        disclaimer: "Candidates are unadjudicated: a property did not hold on these turns. Confirm before treating any of them as a defect.",
      });
    } catch (e: any) {
      console.error("[COACH_HEALTH] brief failed:", e?.message);
      res.status(500).json({ message: "Failed to build the brief" });
    }
  });

  app.get("/api/admin/coach-health", requireAdminKey, async (req: any, res) => {
    try {
      const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || "1"))));
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await db.select({
        id: turnLedger.id, userId: turnLedger.userId, createdAt: turnLedger.createdAt,
        inputText: turnLedger.inputText, reply: turnLedger.reply,
        mutations: turnLedger.mutations, version: turnLedger.version,
        lifecycleStatus: turnLedger.lifecycleStatus,
      })
        .from(turnLedger)
        .where(gte(turnLedger.createdAt, since))
        .orderBy(desc(turnLedger.createdAt))
        .limit(5000);

      const clusters = COACH_HEALTH_RULES.map(rule => {
        const hits = rows.filter(r => {
          const input = String(r.inputText || "");
          const muts = Array.isArray(r.mutations) ? (r.mutations as string[]).map(String) : [];
          if (!rule.asks(input)) return false;
          return rule.failed({ reply: String(r.reply || ""), mutations: muts });
        });
        // BEFORE THE FIX IS NOT A REGRESSION. A hit older than the merge is the failure behaving
        // exactly as it did when we found it — evidence the cut was real, not evidence it is
        // broken now. Only the after bucket may be called a regression, and the two are never summed.
        const after = hits.filter(h => isRegression(rule, h.createdAt as any));
        const before = hits.filter(h => !isRegression(rule, h.createdAt as any));
        // THE DENOMINATOR MEANS DIFFERENT THINGS FOR THE TWO TRIGGERS, so it is not one number
        // wearing one label: a request rule counts people who asked, a mutation rule counts turns
        // scanned. Calling 88 scanned turns "88 asked" would be a false operator statistic.
        //
        // AND IT MUST BE SCOPED TO THE SAME SIDE OF THE FIX AS THE NUMERATOR (2026-08-27, first
        // live reading). It was not, and the panel said:
        //
        //     Distance question answered without the distance   0 of 1 matching request · 1 before the fix
        //
        // which reads as "one client asked since the fix and got it right". Not true: that one
        // request was the pre-fix one, and NOTHING has exercised the rule since. A ratio whose top
        // excludes pre-fix hits and whose bottom includes pre-fix asks is not a ratio, and it fails
        // in the flattering direction — untested looks like verified.
        const matches = (r: typeof rows[number]) =>
          rule.trigger === "request" ? rule.asks(String(r.inputText || "")) : true;
        const candidates = rows.filter(r => matches(r) && isRegression(rule, r.createdAt as any)).length;
        const historicalCandidates = rows.filter(r => matches(r) && !isRegression(rule, r.createdAt as any)).length;
        return {
          id: rule.id, label: rule.label, layer: rule.layer, fixRef: rule.fixRef,
          expected: rule.expected, fixedAt: rule.fixedAt, trigger: rule.trigger,
          occurrences: after.length,
          historical: before.length,
          clients: new Set(after.map(h => h.userId)).size,
          candidates,
          historicalCandidates,
          examples: after.slice(0, 5).map(h => ({
            turnId: h.id, at: h.createdAt, version: h.version,
            input: String(h.inputText || "").slice(0, 140),
            reply: String(h.reply || "").replace(/\n/g, " ").slice(0, 160),
            status: h.lifecycleStatus,
          })),
          historicalExamples: before.slice(0, 3).map(h => ({
            turnId: h.id, at: h.createdAt, version: h.version,
            input: String(h.inputText || "").slice(0, 140),
            reply: String(h.reply || "").replace(/\n/g, " ").slice(0, 160),
            status: h.lifecycleStatus,
          })),
        };
      }).sort((a, b) => b.occurrences - a.occurrences);

      await auditRead("coach_health", { days, turns: rows.length });
      res.json({
        windowDays: days,
        turns: rows.length,
        flagged: clusters.reduce((s, c) => s + c.occurrences, 0),
        historical: clusters.reduce((s, c) => s + c.historical, 0),
        unresolved: clusters.filter(c => c.occurrences > 0).length,
        clusters,
        cannotSurface: CANNOT_SURFACE,
        // ATTRIBUTION IS BY MERGE TIME, NOT BY VERIFIED DEPLOYMENT — said in the payload so the
        // page cannot quietly overstate it. turn_ledger stores the build SHA that served each
        // turn, but nothing here knows which SHAs contain a given fix: that is git ancestry, and
        // there is no deployments table to ask. A turn shortly after a merge may still have run
        // the old build, so a fresh regression should be read against the build on the example
        // before it is believed. Building that mapping is a separate cut, not a caveat to bury.
        attribution: "merge-time",
      });
    } catch (e: any) {
      console.error("[COACH_HEALTH] failed:", e?.message);
      res.status(500).json({ message: "Failed to load coach health" });
    }
  });

  // ── THE LIST ────────────────────────────────────────────────────────────────────────────────
  app.get("/api/admin/turns", requireAdminKey, async (req: any, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"))));
      const offset = Math.max(0, parseInt(String(req.query.offset || "0")));
      const where: any[] = [];

      if (req.query.userId) where.push(eq(turnLedger.userId, String(req.query.userId)));
      if (req.query.version) where.push(eq(turnLedger.version, String(req.query.version)));
      if (req.query.category) where.push(eq(turnLedger.failureCategory, String(req.query.category)));
      if (req.query.status) where.push(eq(turnLedger.lifecycleStatus, String(req.query.status)));
      if (req.query.since) {
        const d = new Date(String(req.query.since));
        if (!Number.isNaN(d.getTime())) where.push(gte(turnLedger.createdAt, d));
      }
      // "Show me only the turns a human has judged" — the working queue.
      if (String(req.query.triagedOnly || "") === "1") {
        where.push(inArray(turnLedger.failureCategory, [...FAILURE_CATEGORIES]));
      }

      const rows = await db.select({
        id: turnLedger.id, userId: turnLedger.userId, createdAt: turnLedger.createdAt,
        inputType: turnLedger.inputType, inputText: turnLedger.inputText,
        reply: turnLedger.reply, replyMs: turnLedger.replyMs, version: turnLedger.version,
        resolvedDay: turnLedger.resolvedDay,
        failureCategory: turnLedger.failureCategory, lifecycleStatus: turnLedger.lifecycleStatus,
        fixRef: turnLedger.fixRef,
        name: users.name,
      })
        .from(turnLedger)
        .leftJoin(users, eq(users.id, turnLedger.userId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(turnLedger.createdAt))
        .limit(limit).offset(offset);

      await auditRead("turns_list", { count: rows.length, filters: req.query });
      res.json({ turns: rows, limit, offset });
    } catch (e: any) {
      console.error("[TURN_TRIAGE] list failed:", e?.message);
      res.status(500).json({ message: "Failed to load turns" });
    }
  });

  // ── ONE TURN, WITH THE MECHANISM ────────────────────────────────────────────────────────────
  app.get("/api/admin/turns/:id", requireAdminKey, async (req: any, res) => {
    try {
      const [row] = await db.select().from(turnLedger).where(eq(turnLedger.id, req.params.id)).limit(1);
      if (!row) return res.status(404).json({ message: "No such turn" });
      await auditRead("turn_detail", { turnId: row.id, userId: row.userId });
      res.json(row);
    } catch (e: any) {
      console.error("[TURN_TRIAGE] detail failed:", e?.message);
      res.status(500).json({ message: "Failed to load turn" });
    }
  });

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  // Validated against the two closed vocabularies. A free-text category would make the whole
  // point of the table — a countable failure distribution — unmeasurable within a week.
  app.patch("/api/admin/turns/:id", requireAdminKey, async (req: any, res) => {
    try {
      const verdict = validateVerdict(req.body);
      if (!verdict.ok) return res.status(400).json({ message: verdict.message });
      const patch = verdict.patch;

      const [updated] = await db.update(turnLedger).set(patch)
        .where(eq(turnLedger.id, req.params.id))
        .returning({ id: turnLedger.id, userId: turnLedger.userId });
      if (!updated) return res.status(404).json({ message: "No such turn" });

      await auditRead("turn_triaged", { turnId: updated.id, userId: updated.userId, ...patch });
      res.json({ ok: true, id: updated.id });
    } catch (e: any) {
      console.error("[TURN_TRIAGE] verdict failed:", e?.message);
      res.status(500).json({ message: "Failed to record verdict" });
    }
  });

  // ── THE FAILURE DISTRIBUTION ────────────────────────────────────────────────────────────────
  // The number the de-bloat phase is supposed to be chosen from: not "this file has 300
  // duplicated lines" but "this failure happened 14 times". Also reports which builds served
  // real turns, which answers "what SHA are the testers actually on" from the data itself.
  app.get("/api/admin/turns-summary", requireAdminKey, async (_req, res) => {
    try {
      const [byCategory, byBuild, byStatus] = await Promise.all([
        db.select({ category: turnLedger.failureCategory, n: sql<number>`COUNT(*)::int` })
          .from(turnLedger).groupBy(turnLedger.failureCategory),
        db.select({
          version: turnLedger.version, n: sql<number>`COUNT(*)::int`,
          last: sql<string>`MAX(${turnLedger.createdAt})`,
        }).from(turnLedger).groupBy(turnLedger.version)
          .orderBy(sql`MAX(${turnLedger.createdAt}) DESC`).limit(10),
        db.select({ status: turnLedger.lifecycleStatus, n: sql<number>`COUNT(*)::int` })
          .from(turnLedger).groupBy(turnLedger.lifecycleStatus),
      ]);
      res.json({ byCategory, byBuild, byStatus, retentionDays: RETENTION_DAYS });
    } catch (e: any) {
      console.error("[TURN_TRIAGE] summary failed:", e?.message);
      res.status(500).json({ message: "Failed to load summary" });
    }
  });

  // ── THE PAGE ────────────────────────────────────────────────────────────────────────────────
  app.get("/admin/turns", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>KamLife — Turn Triage</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262b36; --ink:#e7eaf0; --dim:#9aa3b2; --accent:#5aa9ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .note { color:var(--dim); font-size:12px; }
  main { padding:20px; display:grid; grid-template-columns:minmax(320px,1fr) minmax(320px,1.2fr); gap:20px; align-items:start; }
  @media (max-width:900px) { main { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .row { padding:10px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; cursor:pointer; }
  .row:hover { border-color:var(--accent); }
  .row.sel { border-color:var(--accent); background:#1b2130; }
  .meta { color:var(--dim); font-size:12px; display:flex; gap:8px; flex-wrap:wrap; }
  .msg { margin:6px 0; }
  pre { background:#0c0e12; border:1px solid var(--line); border-radius:8px; padding:10px; overflow-x:auto; font-size:12px; max-height:320px; }
  label { display:block; font-size:12px; color:var(--dim); margin:10px 0 4px; }
  select, input, textarea, button { background:#0c0e12; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; width:100%; }
  button { background:var(--accent); color:#04101f; font-weight:600; cursor:pointer; border:0; margin-top:12px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:99px; border:1px solid var(--line); font-size:11px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .filters > * { width:auto; flex:0 0 auto; }
  .empty { color:var(--dim); padding:24px 8px; text-align:center; }
</style></head>
<body>
<header>
  <h1>Turn Triage</h1>
  <span class="note">the mechanism behind each reply · reads are audited · ${RETENTION_DAYS}-day retention</span>
</header>
<main>
  <section class="card">
    <div class="filters">
      <select id="fCat"><option value="">every category</option>${FAILURE_CATEGORIES.map(c => `<option>${c}</option>`).join("")}</select>
      <select id="fStatus"><option value="">every status</option>${LIFECYCLE.map(s => `<option>${s}</option>`).join("")}</select>
      <input id="fBuild" placeholder="build SHA" />
      <input id="fSince" type="date" />
      <button id="reload" style="width:auto;margin:0;padding:8px 14px">Load</button>
    </div>
    <div id="list"><div class="empty">Loading…</div></div>
  </section>
  <section class="card" id="detail"><div class="empty">Pick a turn to see what the system actually did.</div></section>
</main>
<script>
const $ = s => document.querySelector(s);
let selected = null;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function load() {
  const p = new URLSearchParams();
  if ($("#fCat").value) p.set("category", $("#fCat").value);
  if ($("#fStatus").value) p.set("status", $("#fStatus").value);
  if ($("#fBuild").value) p.set("version", $("#fBuild").value.trim());
  if ($("#fSince").value) p.set("since", $("#fSince").value);
  const r = await fetch("/api/admin/turns?" + p.toString(), { credentials: "same-origin" });
  if (!r.ok) { $("#list").innerHTML = '<div class="empty">Not authorised, or nothing to show.</div>'; return; }
  const { turns } = await r.json();
  if (!turns.length) { $("#list").innerHTML = '<div class="empty">No turns match that.</div>'; return; }
  $("#list").innerHTML = turns.map(t => \`
    <div class="row" data-id="\${t.id}">
      <div class="meta">
        <span>\${new Date(t.createdAt).toLocaleString("en-ZA")}</span>
        <span class="pill">\${esc(t.inputType || "text")}</span>
        <span class="pill">\${esc(t.version || "?")}</span>
        \${t.failureCategory ? \`<span class="pill">\${esc(t.failureCategory)}</span>\` : ""}
        \${t.lifecycleStatus ? \`<span class="pill">\${esc(t.lifecycleStatus)}</span>\` : ""}
        <span>\${t.replyMs ?? "?"}ms</span>
      </div>
      <div class="msg"><strong>\${esc(t.name || "client")}:</strong> \${esc((t.inputText || "").slice(0, 160))}</div>
      <div class="msg" style="color:var(--dim)">→ \${esc((t.reply || "").slice(0, 160))}</div>
    </div>\`).join("");
  document.querySelectorAll(".row").forEach(el => el.onclick = () => open(el.dataset.id, el));
}

async function open(id, el) {
  document.querySelectorAll(".row").forEach(r => r.classList.remove("sel"));
  el.classList.add("sel");
  const r = await fetch("/api/admin/turns/" + id, { credentials: "same-origin" });
  if (!r.ok) return;
  const t = await r.json(); selected = t.id;
  $("#detail").innerHTML = \`
    <div class="meta">
      <span class="pill">build \${esc(t.version || "?")}</span>
      <span class="pill">\${esc(t.inputType || "text")}</span>
      <span class="pill">day \${esc(t.resolvedDay || "?")}</span>
      <span>\${t.replyMs ?? "?"}ms</span>
    </div>
    <label>Client said</label><pre>\${esc(t.inputText)}</pre>
    <label>Coach replied</label><pre>\${esc(t.reply)}</pre>
    <label>State read before deciding</label><pre>\${esc(JSON.stringify(t.stateRead, null, 2))}</pre>
    <label>Mutations, in order</label><pre>\${esc(JSON.stringify(t.mutations, null, 2))}</pre>
    <label>Which layer failed</label>
    <select id="vCat"><option value="">— not judged —</option>${FAILURE_CATEGORIES.map(c => `<option>${c}</option>`).join("")}</select>
    <label>Lifecycle</label>
    <select id="vStatus"><option value="">— none —</option>${LIFECYCLE.map(s => `<option>${s}</option>`).join("")}</select>
    <label>Fix reference (PR or commit)</label><input id="vFix" placeholder="#62" />
    <label>Note</label><textarea id="vNote" rows="3" placeholder="Why this classification?"></textarea>
    <button id="save">Record verdict</button>\`;
  $("#vCat").value = t.failureCategory || "";
  $("#vStatus").value = t.lifecycleStatus || "";
  $("#vFix").value = t.fixRef || "";
  $("#vNote").value = t.triageNote || "";
  $("#save").onclick = save;
}

async function save() {
  const r = await fetch("/api/admin/turns/" + selected, {
    method: "PATCH", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      failureCategory: $("#vCat").value || null,
      lifecycleStatus: $("#vStatus").value || null,
      fixRef: $("#vFix").value || null,
      triageNote: $("#vNote").value || null,
    }),
  });
  $("#save").textContent = r.ok ? "Recorded ✓" : "Failed";
  if (r.ok) load();
}

$("#reload").onclick = load;
load();
</script>
</body></html>`);
  });
}
