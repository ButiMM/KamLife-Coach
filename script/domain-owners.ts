/**
 * WHO OWNS A CUSTOMER QUESTION — the declarative map (2026-08-20).
 *
 * THE DISEASE THIS EXISTS TO END: we consolidated modules and never consolidated AUTHORITY. Every
 * cut created an island of correctness while an older route kept the ability to answer the same
 * question. `progress` had three authorities at once — the day ledger behind "today's progress",
 * four `users` columns behind "my progress", and the model behind "this week", which no handler
 * owned at all despite the product telling clients to type it.
 *
 * A module test cannot catch that. `report-card` converged perfectly and the client never touched
 * it. So the check has to be about DOORS, not files: given the words a person actually sends, is
 * there exactly one piece of code that can answer?
 *
 * This is deliberately small. It is not an ontology, and it does not try to describe the whole
 * product. It covers the domains where a second claimant has already cost us a customer-visible
 * failure, and it grows only when another one does.
 */

export interface DomainOwnership {
  /** The customer question, in one phrase. */
  domain: string;
  /** Words that mean a client is asking THIS. Matched against source, not against messages. */
  vocabulary: RegExp;
  /** The files permitted to answer it. Anything else matching the vocabulary fails the build. */
  owners: string[];
  /** Where the answer's numbers must come from. One source per domain, always. */
  truthSource: string;
  /**
   * The model path. It may DISCUSS a domain — its prompts name these phrases — but it must never
   * be the first claimant, and the guard proves that structurally: every owner must sit earlier in
   * the handler chain than handleGptBlock, so a declared question can never reach the model.
   *
   * Listed rather than ignored, because "deterministic handler vs model fallback" is exactly the
   * authority conflict that produced "this week": no owner, so the model answered, invented
   * averages and handed the next move back to the client.
   */
  engineSurface: string[];
  /** Why this domain is here — the failure that earned it a place. */
  earnedBy: string;
}

export const DOMAIN_OWNERS: DomainOwnership[] = [
  {
    domain: "progress",
    // The literal command forms only. Prose ABOUT progress is not a claim on the intent — the
    // vocabulary has to be narrow enough that a comment or a coaching sentence does not read as
    // a second owner, or the guard cries wolf and gets switched off.
    // Extended 2026-08-20 with the weekly cousins. A fourth calculator owned them — "weekly
    // stats", "progress card", "weekly progress", "progress this week" — and disagreed with
    // "this week" on the same seven days. The guard covers them so a second owner cannot come
    // back under a synonym.
    //
    // NOT in this vocabulary, deliberately: "my week", "week report", "week card", "weekly card".
    // Those reach the shareable REPORT CARD in early-commands.ts:135, which answers with an image
    // rather than the text breakdown. That is a second answer to the same customer question and
    // it is recorded in `earnedBy` below — but it is a product decision, not a refactor, so the
    // vocabulary describes what is true today instead of asserting a convergence nobody made.
    vocabulary: /["'`\[]\s*(?:my progress|this week|how am i doing|today'?s progress|progress today|daily progress)\s*["'`,\]]|\b(?:weekly stats|progress card|weekly progress|my stats this week|progress this week)\b/i,
    owners: [
      "server/handlers/misc-commands.ts",   // "my progress", "this week" — reads getProgressTruth
      "server/handlers/early-commands.ts",  // "today's progress" — reads getDayLedger
    ],
    engineSurface: [
      "server/brain/coach-brain.ts",              // prompt names "how am I doing"
      "server/understanding/meaning-engine.ts",
      "server/understanding/action-router.ts",
    ],
    truthSource: "server/day-ledger.ts",
    earnedBy: "2026-08-20: three authorities at once; 'this week' had none and fell to the model, "
      + "which invented averages and asked the client to choose the next action. A fourth (the "
      + "WEEKLY PROGRESS CARD) was deleted in the follow-up. STILL OPEN, reported not fixed: the "
      + "shareable report card answers 'my week' with an image while 'this week' answers with "
      + "text, and the all-time block at misc-commands.ts:622 computes its own journey totals.",
  },
];

/**
 * Files that may mention a domain's vocabulary without owning it: the tests that assert this
 * contract, the manifest itself, and the scheduler jobs, which speak proactively and never claim
 * an inbound intent.
 */
export const NON_CLAIMANTS = [
  "script/",
  "server/scheduler/",
  "server/weekly-recap.ts",
  "server/agents.ts",          // admin keyword list, never a client reply path
];
