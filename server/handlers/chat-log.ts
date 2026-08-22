import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import { users, chatHistory, escalations, turnLedger, workoutLogs, stepLogs, weightLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA, isSyntheticTestClient } from "../safety-detection";
import { currentRuntimeDecision } from "../understanding/state";
import { verifyBrainReply, mentionsForbidden, stripForbidden, HONOURED_SILENCE } from "../brain/reply-verifier";
import { looksLikeQuestion, sessionCountsIn } from "../utils";
import { sastDayStart } from "../utils";

export async function checkEscalation(userId: string, messageIn: string): Promise<void> {
  if (!messageIn || messageIn.length <= 2) return;
  const esc = detectEscalation(messageIn);
  if (!esc.should) return;
  try {
    const recent = await db.select({ id: escalations.id }).from(escalations)
      .where(and(eq(escalations.userId, userId), eq(escalations.status, "open")))
      .limit(1);
    if (recent.length !== 0) return;
    await db.insert(escalations).values({
      userId, reason: esc.reason, triggerMessage: messageIn.slice(0, 500),
      priority: esc.priority, slaDeadline: escalationSLA(esc.priority),
    });
    console.log(`[ESCALATION] Auto-created: ${esc.reason} (${esc.priority}) for user ${userId}`);
    if (!(esc.priority === "urgent" || esc.priority === "high")
      || !process.env.COACH_ALERT_PHONE || !process.env.TWILIO_ACCOUNT_SID
      || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_NUMBER) return;
    const [client] = await db.select({ name: users.name, phoneNumber: users.phoneNumber })
      .from(users).where(eq(users.id, userId)).limit(1);
    const clientName = client?.name || "Client";
    const clientPhone = client?.phoneNumber || "unknown";
    const normPhone = (p: string) => p.replace(/^whatsapp:/, "").replace(/\D/g, "");
    // THE ROW IS WRITTEN, THE PAGE IS WITHHELD — AND IT SAYS WHY. Two reasons were collapsed
    // into one silent return, so an escalation that never paged looked identical to a broken
    // alerter. The row above is already committed; only the outbound page is skipped here.
    if (normPhone(clientPhone) === normPhone(process.env.COACH_ALERT_PHONE)) {
      console.log(`[ESCALATION] Skipping coach alert — the client IS the coach alert number (${esc.reason})`);
      return;
    }
    if (isSyntheticTestClient(clientPhone)) {
      console.log(`[ESCALATION] Skipping coach alert — synthetic test client ${clientPhone} (${esc.reason})`);
      return;
    }
    const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNum = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:")
      ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
    const emoji = esc.priority === "urgent" ? "🚨" : "⚠️";
    const alertBody = `${emoji} ${esc.priority.toUpperCase()} ESCALATION\nReason: ${esc.reason}\nClient: ${clientName} (${clientPhone})\nMessage: "${messageIn.slice(0, 200)}"\n\nOpen the dashboard inbox to claim and respond.`;
    const delays = [0, 2000, 5000, 10000];
    let sent = false;
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      try {
        await alertClient.messages.create({ from: fromNum, to: `whatsapp:${process.env.COACH_ALERT_PHONE}`, body: alertBody });
        console.log(`[ESCALATION] Founder alert sent (${esc.priority}/${esc.reason}${delay > 0 ? ` after ${delay}ms retry` : ""})`);
        sent = true; break;
      } catch (alertErr) {
        console.error(`[ESCALATION] Alert attempt failed (delay=${delay}ms):`, (alertErr as Error)?.message);
      }
    }
    if (!sent) console.error(`[ESCALATION] All alert attempts failed (${esc.priority}/${esc.reason}) — escalation remains in inbox`);
  } catch (err) { console.error("[checkEscalation] error:", err); }
}

export async function logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<void> {
  try { await db.insert(chatHistory).values({ userId, messageIn, messageOut, intent }); await checkEscalation(userId, messageIn); }
  catch (err) { console.error("Chat log error:", err); }
}

export async function logMediaFailure(userId: string, stage: string, rawError?: unknown, latencyMs?: number): Promise<void> {
  const code = classifyMediaFailure(stage, rawError);
  const payload = latencyMs !== undefined ? `${code} latency=${latencyMs}ms` : code;
  try { await logChat(userId, `[MEDIA_FAIL:${stage}]`, payload, "MEDIA_FAILURE"); }
  catch (e) { console.warn("[media-failure-log]", e); }
}

export async function logMediaSuccess(userId: string, flow: string, totalMs: number): Promise<void> {
  try { await logChat(userId, `[MEDIA_OK:${flow}]`, `total_ms=${totalMs}`, "MEDIA_SUCCESS"); }
  catch (e) { console.warn("[media-success-log]", e); }
}

export function buildMediaTrace(phone: string, mediaType: string): string {
  const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "").slice(-4) || "unknown";
  return `m_${Date.now().toString(36)}_${cleanPhone}_${(mediaType || "unknown").replace(/[^\w]/g, "").slice(0, 12)}`;
}

export async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

interface TurnScope {
  userId: string | null;
  inputType: string;
  inputText: string;
  resolvedDay: string | null;
  stateRead: Record<string, unknown>;
  mutations: string[];
  startedAt: number;
  finalReplyPromise: Promise<string>;
  /** Values an authoritative source produced this turn — see turnEvidence. */
  evidence?: {
    stepsToday?: number | null;
    /** Domains this turn durably WROTE, from turnMutation. The mouth no longer has to guess
     *  whether a log happened by looking for the word "logged" in its own prose. */
    writtenDomains?: string[];
    /** Training sessions counted from workoutLogs this turn, and the window they cover. The same
     *  contract as stepsToday: a count we HOLD, so the mouth can be checked against it. */
    sessionsWindow?: number | null;
    sessionsWindowDays?: number | null;
    /**
     * PRESCRIPTION PROVENANCE (2026-08-21). The canonical action this turn decided, if any, and
     * whether the reply was authored by a model path. A behaviour-changing directive in
     * model prose must correspond to `canonicalKind`; without one it has no provenance and
     * must not ship. See verifyPrescriptionProvenance.
     */
    canonicalKind?: string | null;
    canonicalTodo?: string | null;
    /**
     * THE WHOLE REPLY for a decision turn, rendered deterministically from chooseAction. On a
     * decision turn this REPLACES the model's prose — the model is not the author of a turn that
     * carries an instruction.
     */
    canonicalReply?: string | null;
    modelAuthored?: boolean;
    /**
     * This turn is a CLARIFICATION or a de-escalation, not a coaching turn. It still gets its
     * directives stripped — the model may not instruct from any path — but it must not have a
     * coaching instruction appended to it. "Did you mean 500g or 50g?" followed by "Log one meal
     * today" is the coach talking over the question it just asked.
     */
    conversationalOnly?: boolean;
    /** The CoachAction the meaning engine emitted this turn, when it emitted one. Structured
     *  provenance — checked BEFORE the prose backstop. */
    structuredAction?: string | null;
  };
}

const turnStore = new AsyncLocalStorage<TurnScope>();
const PURE_REACTION_INPUTS = new Set([
  "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "lekker", "cool", "aight",
  "thanks", "thank you", "thanks coach", "thank you coach", "thanks a lot", "thank u", "ty",
  "dankie", "baie dankie", "ngiyabonga", "siyabonga", "ngiyabonga coach", "enkosi",
  "ke a leboha", "ke a leboga", "kea leboha", "ndza khensa",
]);
const ACK_PREFIX = /^(?:noted|sharp|good|great|perfect|nice|awesome|lekker|got it|understood|well done|keep it up|good choice|great job)\b/i;
const GENERIC_COACH_REPLY = /(?:if you need anything else|keep building on those meals|keep that momentum going|focus on your next meal|try something different like|make that meal count|let'?s keep working|keep fuelling|keep it balanced)/i;
const MISSED_TRAINING_CLAIM = /\b(?:missed|didn'?t|did not|haven'?t|have not)\b[^.\n]{0,35}\b(?:train|training|workout|session|gym)\b|\b(?:monday|today)\s+is\s+(?:still\s+)?a\s+training\s+day\b/i;
const NO_CURRENT_STEPS_CLAIM = /\b(?:haven'?t|have not|no|zero)\b[^.\n]{0,30}\b(?:steps|walk(?:ed|ing)?)\b/i;
const CONTRADICTORY_WEIGHT_TREND = /\b(?:not|won'?t|will not|can'?t|cannot)\b[^.\n]{0,50}\btrend\b[^.\n]{0,80}\b(?:scale|weight)\s+(?:is\s+)?going\s+up\b/i;
const EXPLICIT_STEP_QUERY = /\b(?:how many steps|what (?:are|is) my steps?|what'?s my step count|what is my step count|my steps|step progress|step total)\b/i;
const EXPLICIT_WEIGHT_QUERY = /\b(?:what(?:'s| is) my (?:current )?weight|how much do i weigh|what weight am i|my weight today|weight trend)\b/i;

function isMeaningfulClientMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m || PURE_REACTION_INPUTS.has(m)) return false;
  return /[?]/.test(m)
    || /\b(?:i did|i had|i ate|i trained|i worked out|workout|training|steps?|walked|weighed|weight|scale|calories?|protein|meal|dinner|lunch|breakfast|today|trend|goal|target|kota|done|finished|completed)\b/i.test(m)
    || m.length > 18;
}

function extractStepNumbers(text: string): number[] {
  const matches = text.match(/\b\d{1,3}(?:,\d{3})*\s*steps?\b/gi) || [];
  return [...new Set(matches.map(v => Number(v.replace(/\D/g, ""))).filter(n => Number.isFinite(n)))];
}

/**
 * Swap one wrong figure for the authoritative one, keeping the client's own formatting.
 *
 * Deliberately narrow: it only touches a number the extractors already located, and only where
 * that number is written as a standalone figure (with or without thousands separators). Prose is
 * never re-worded here — a correction that rewrites a sentence is the second mouth again.
 */
function replaceNumberToken(text: string, wrong: number, right: number): string {
  const grouped = wrong.toLocaleString("en-US");
  const decimals = String(right).includes(".") || String(wrong).includes(".");
  const out = decimals ? String(right) : right.toLocaleString("en-US");
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternatives = [...new Set([grouped, String(wrong)])].map(escape).join("|");
  // NOT \b on either side. "83.4kg" has no word boundary between the 4 and the k, so \b would
  // silently fail to correct exactly the weight case this exists for. Guard on digits instead:
  // do not start mid-number, do not stop mid-number.
  return text.replace(new RegExp(`(?<![\\d.])(?:${alternatives})(?![\\d.])`, "g"), out);
}

/** Test seam for the deterministic correction — the function itself stays private. */
export const __testReplaceNumberToken = replaceNumberToken;

function extractWeightNumbers(text: string): number[] {
  const matches = text.match(/\b(?:\d{2,3}(?:\.\d+)?)\s*kg\b/gi) || [];
  return [...new Set(matches.map(v => Number(v.replace(/[^0-9.]/g, ""))).filter(n => Number.isFinite(n)))];
}

/**
 * A REPLY THE VERIFIER REJECTED MUST NOT REACH A CLIENT.
 *
 * Deterministic, because the reason this function exists is that the model already produced
 * something we refused to send — asking it again is not a safety control. Medication and medical
 * claims get the scope boundary the doctrine already owns; everything else falls back to the
 * smallest honest thing a coach can say.
 */
const CLINICAL_REFERRAL = "That one's for a doctor or pharmacist, not me — I'm your coach, not your clinician. "
  + "Speak to them about it, and I'll keep helping you with the food, training and habits around it.";
const WITHHOLD = "Let me not guess on that one. Tell me what happened in your own words and I'll pick it up from there.";

/**
 * HUMILITY IS NOT STARVATION (2026-08-20, phone P0).
 *
 * WITHHOLD asks the client to "tell me what happened in your own words". That is the right thing
 * to say when a REPORT could not be trusted. It is the wrong thing to say to somebody who asked a
 * question: the founder asked how his daily step count affects his progress, the verifier blocked
 * the answer, and he was told to describe the event — an event that never happened, because he
 * was asking, not reporting.
 *
 * So a blocked reply to a question answers the part we KNOW and declines only the inference. That
 * is the evidence doctrine applied to our own repair path: known → say it, unknown → don't invent
 * it, and never hand the work back for something they did not do.
 */
/** Test seam — the repair path is where a blocked reply becomes what the client actually reads. */
export const __testSafeReplacementFor = (v: string, scope: any) => safeReplacementFor(v, scope);

async function safeReplacementFor(violation: string, scope: TurnScope): Promise<string> {
  if (/medication|medical|cure|reverse|heal|diagnos/i.test(violation)) return CLINICAL_REFERRAL;
  if (!looksLikeQuestion(scope.inputText || "")) return WITHHOLD;
  try {
    const { getDayLedger } = await import("../day-ledger");
    const ledger = await getDayLedger(scope.userId!, {});
    const known: string[] = [];
    if (ledger.steps > 0) known.push(`${ledger.steps.toLocaleString()} steps`);
    if (ledger.kcal > 0) known.push(`${ledger.kcal} kcal`);
    if (ledger.protein > 0) known.push(`${ledger.protein}g protein`);
    if (known.length > 0) {
      return `Today I've got ${known.join(", ")} on your ledger — that part I'm sure of. The rest of what you asked I'd be guessing at, and I won't do that. Ask me the piece you want and I'll answer it straight.`;
    }
  } catch (e) { console.warn("[REPLY_BLOCKED] ledger unavailable for the honest answer:", (e as any)?.message || e); }
  return `I don't have enough on today to answer that properly yet — log a meal or your steps and ask me again, and you'll get a real number instead of a guess.`;
}

async function reconcileTurnReply(scope: TurnScope, reply: string): Promise<string> {
  if (process.env.NODE_ENV === "test" || !scope.userId || !reply) return reply;
  let draft = String(reply).trim();

  // ════════════════════════════════════════════════════════════════════════════════════════
  // THE BEHAVIOURAL INSTRUCTION COMES FROM THE CANONICAL RENDERER, NOT FROM THE MODEL.
  // (2026-08-21, final authority boundary.)
  //
  // Stating the decision in the prompt is guidance, and guidance is not enforcement. Worse, only
  // three of the TEN model exits ever saw that guidance: the four specialist agents and the
  // punct / short / frustration replies all return early, so they carried no canonical
  // instruction at all and nothing removed a directive of their own.
  //
  // This is the one place every reply crosses, so it is where the boundary belongs:
  //
  //     GPT prose  →  strip any instruction it issued  →  append the canonical instruction
  //
  // The model still supplies empathy, context and explanation — that is what it is for, and it
  // survives untouched. What it no longer supplies is the thing the client is told to DO.
  //
  // HONEST BOUND, stated here rather than in a report: the STRIP depends on recognising a
  // directive in prose, which is ~89% of plausible phrasings. What that buys is that the
  // canonical instruction is ALWAYS the one appended; what it does not buy is structural
  // impossibility of a stray model directive surviving. That would require the model to emit
  // structured fields instead of prose across all ten exits — a larger change than this one.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // P0-A — WRITE INTEGRITY. The coach may not confirm a write that did not happen.
  //
  // 2026-08-21, handset:
  //     client 14:36 "I did all four workouts this week / Take note"
  //     coach  14:36 "That's impressive — all four workouts done this week! Noted 👌"
  //     card   14:38  WORKOUTS 1
  //
  // Two minutes apart. The client gave us a fact, we confirmed it as recorded, and nothing was
  // written. That is not a phrasing defect — it is the continuity promise being false, and a
  // general assistant that stays vague about memory is more honest than a coach that does this.
  //
  // The check is structural on the half that matters: `scope.mutations` is appended by every
  // durable writer (food, corrections, workouts, steps, weight, engine actions), so the turn
  // KNOWS whether anything was committed. A model-authored reply on a turn that wrote nothing
  // may not claim it wrote something.
  //
  // The confirmation vocabulary is short, closed, and specified rather than discovered — these
  // are the words the CTO enumerated. It is not a phrase hunt: any word here is a claim about
  // state, and a claim about state is checkable against state.
  if (scope.evidence?.modelAuthored && scope.mutations.length === 0) {
    const CLAIMS_A_WRITE = /\b(?:logged|noted|saved|recorded|updated|tracked|added (?:it|that)|got (?:it|that) down|put (?:it|that) down|marked (?:it|that))\b/i;
    if (CLAIMS_A_WRITE.test(draft)) {
      console.log(`[WRITE_INTEGRITY] blocked a confirmation with no write on the turn: ${draft.slice(0, 90)}`);
      const { recordFalseConfirmation } = await import("../self-check");
      recordFalseConfirmation();
      // The honest reply: we heard them, and we are asking for what we can actually record.
      draft = "I've got that — but I haven't written it down yet, and I won't say I have when I "
        + "haven't. Send it the way you'd log it and I'll put it on your record properly.";
    }
  }

  if (scope.evidence?.modelAuthored) {
    const { stripModelDirectives } = await import("../brain/reply-verifier");
    const { renderActionLine } = await import("../one-action");
    const { recordDirectiveStripped } = await import("../self-check");

    // CLARIFICATION IS NOT A COACHING TURN. It gets its directives stripped like every model
    // path — no path may instruct — but it never receives an action line. "Did you mean 500g?"
    // followed by "Log one meal today" is the coach talking over its own question.
    const clarifying = !!scope.evidence.conversationalOnly;
    const todo = clarifying ? "" : String(scope.evidence.canonicalTodo || "").trim();
    const decisionTurn = todo.length > 0;

    const { kept, removed } = stripModelDirectives(draft, scope.evidence);
    if (removed.length > 0) {
      // COUNTED, NOT ARGUED. On a no-decision turn this is the model trying to instruct where the
      // coach decided to change nothing — the residual the beta is meant to measure.
      recordDirectiveStripped(decisionTurn);
      console.log(`[ACTION_LINE] removed ${removed.length} model instruction(s) on a ${decisionTurn ? "decision" : "hold"} turn: ${removed[0].slice(0, 70)}`);
      draft = kept;
    }

    if (decisionTurn) {
      // STRICT BOUNDARY (2026-08-21, live acceptance failure). Stripping recognised directives was
      // not enough, and the handset proved it:
      //
      //     canonical REST → "Today's a chest day."  →  "Rest today…"
      //
      // "Today's a chest day" has no imperative verb and no advisory shape, so nothing matched it
      // and it shipped directly above the opposite instruction. Every version of this that keeps
      // free model prose on a decision turn has the same hole, because recognising an instruction
      // in arbitrary English is the thing that cannot be done.
      //
      // So on a turn that carries a decision, the customer sees the DETERMINISTIC reply and
      // nothing the model wrote. Not stripped — not authored. There is exactly one behavioural
      // instruction because there is exactly one sentence that could be one, and code wrote it.
      //
      // The model still runs, still reads state, still shapes the NONE turns, and every scanner,
      // writer and safety rail is untouched. What it no longer does is talk over a decision.
      const rendered = String(scope.evidence.canonicalReply || "").trim();
      if (rendered) {
        if (draft && draft !== rendered) {
          console.log(`[DECISION_TURN] model prose withheld (${draft.length} chars) — the turn carries a decision`);
        }
        draft = rendered;
      } else {
        // No rendered reply (the decision was read but formatting failed): fall back to the one
        // line rather than shipping prose that could contradict it.
        draft = renderActionLine(todo);
      }
    } else if (!draft) {
      draft = "I'm here — tell me what's going on and we'll take it from there.";
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // P0-A — THE CHECK MUST HAVE THE STATE IT CHECKS AGAINST (2026-08-22).
  //
  // The training-count rule was correct and could be walked around by ROUTE. `sessionsWindow`
  // arrived on the turn only because getProgressTruth happened to run, and most model paths
  // never call it — the specialist agents, the short/punct replies, a plain conversational
  // turn. On any of those the boundary held no count, and the fallback was "a figure the client
  // put in their own message may be echoed", which is precisely the 21 August sentence:
  //
  //     client "I did all four workouts this week"   →   coach "all four workouts done"
  //
  // Both halves said four, so the echo rule passed it, with a log holding one. A rule that
  // depends on an unrelated read having happened is not a boundary.
  //
  // So the boundary FETCHES what it needs, and only when it needs it: a model-authored draft
  // that actually asserts a session count triggers one COUNT(*) — the same query getProgressTruth
  // runs, through the same owner. Nothing else on the turn pays for it. If the read fails the
  // evidence stays absent and the verifier refuses the claim, which is the correct direction:
  // an unevidenced training history is never worth saying.
  if (scope.evidence?.modelAuthored
      && scope.evidence.sessionsWindow == null
      && sessionCountsIn(draft).length > 0) {
    const { sessionsSince } = await import("../day-ledger");
    // Seven days — getProgressTruth's default, and the window every weekly surface already uses.
    // NOT a progress door: this reads a count to REFUSE a sentence, and the client is never shown
    // a number from here. The refusal path emits no total, which is why the reply below says what
    // it cannot confirm rather than answering with the figure.
    const days = 7;
    try {
      turnEvidence({ sessionsWindow: await sessionsSince(scope.userId, days), sessionsWindowDays: days });
    } catch (e: any) {
      console.error(`[SESSION_EVIDENCE] could not read the training count, refusing the claim: ${e?.message || e}`);
    }
  }

  // WHAT THIS TURN WROTE, handed to the verifier (2026-08-22). Its meal-macro rule carried the
  // note "VerifierFacts does not yet carry mealLoggedThisTurn — treat unanchored precision as
  // unsafe", and so it refused an honest confirmation of a meal that HAD just been committed,
  // purely because the sentence did not contain the word "logged". The turn knows. Ask it.
  const { durableDomains } = await import("../understanding/messy-intake");
  const verifier = verifyBrainReply(draft, {
    clientMessage: scope.inputText,
    evidence: { ...(scope.evidence || {}), writtenDomains: durableDomains(scope.mutations) },
  });

  // ════════════════════════════════════════════════════════════════════════════════════════
  // CUT 3 — THE VERDICT BINDS THE MOUTH, AND THE MOUTH IS DETERMINISTIC.
  //
  // This guard used to read `if (!verifier.ok || …) return reply;` — so a reply the verifier
  // REJECTED was returned to the client untouched, including a medication-safety violation, and
  // the `VERIFIER REJECTION` repair reason further down was unreachable dead code. Backwards in
  // the one direction that matters.
  //
  // And a reply the verifier PASSED could be handed to a second askCoachK call whose output went
  // out unverified — after every gate had run — and overwrote chatHistory.messageOut, destroying
  // the record of what the deterministic pipeline actually said.
  //
  // Doctrine: deterministic commit + compose wins. Repair does not get a second mouth.
  // ════════════════════════════════════════════════════════════════════════════════════════
  if (!verifier.ok) {
    console.error(`[REPLY_BLOCKED] ...${scope.userId.slice(-6)} — ${verifier.violation}`);
    const safe = await safeReplacementFor(verifier.violation || "", scope);
    // The row keeps what actually went out. A blocked reply is an escalation, not a log line.
    await db.insert(escalations).values({
      userId: scope.userId, reason: "reply_blocked_by_verifier", status: "open",
      triggerMessage: `${(verifier.violation || "").slice(0, 300)} || draft: ${draft.slice(0, 200)}`,
      priority: "high", slaDeadline: new Date(Date.now() + 24 * 3_600_000),
    }).catch(() => {});
    return safe;
  }

  // ── CUT 8 — WHAT THEY ASKED US NOT TO SAY ────────────────────────────────────────────────
  //
  // Placed HERE, above the `!meaningful` early return below, because a client who asked us to
  // drop the scale is owed that whether or not this particular turn was "meaningful". The check
  // that follows only runs for messages worth reconciling; this one runs for every reply.
  //
  // COSTS ONE COLUMN. A primary-key lookup returning users.do_not_mention on every reply — stated
  // rather than buried, because the alternative was moving the full row read above the early
  // return and paying for every column instead of one.
  try {
    const [banned] = await db.select({ doNotMention: users.doNotMention })
      .from(users).where(eq(users.id, scope.userId)).limit(1);
    if (banned?.doNotMention) {
      // THEY MAY RAISE IT THEMSELVES. "Don't mention my weight" is not "refuse to tell me my
      // weight when I ask" — the request is about us bringing it up, and a coach who won't answer
      // a direct question is not honouring anything, it is sulking. Same trap as the step TARGET
      // that read as an attribution in the P0: the rule has to know who started it.
      if (!mentionsForbidden(scope.inputText, banned.doNotMention)) {
        const held = stripForbidden(draft, banned.doNotMention);
        if (held.stripped) {
          console.warn(`[DO_NOT_MENTION] ...${scope.userId.slice(-6)} — held "${banned.doNotMention}"${held.text ? "" : " (whole reply)"}`);
          return held.text || HONOURED_SILENCE;
        }
      }
    }
  } catch (e) { console.warn("[DO_NOT_MENTION] non-fatal:", (e as any)?.message || e); }

  const likelyGeneric = (ACK_PREFIX.test(draft) && draft.length <= 180) || GENERIC_COACH_REPLY.test(draft);
  const suspiciousStateLanguage = MISSED_TRAINING_CLAIM.test(draft) || NO_CURRENT_STEPS_CLAIM.test(draft) || CONTRADICTORY_WEIGHT_TREND.test(draft);
  const meaningful = isMeaningfulClientMessage(scope.inputText);
  // A GENERIC REPLY IS A QUALITY GAP, NOT A SAFETY ONE. It used to trigger the second model call.
  // It no longer does anything here: making a thin reply better is the deterministic composer's
  // job, and Cut 1 moved that work to where the facts are. Counted, not rewritten.
  if (likelyGeneric && meaningful && !suspiciousStateLanguage) {
    console.log(`[REPLY_THIN] ...${scope.userId.slice(-6)} — generic reply to a meaningful message`);
  }
  if (!suspiciousStateLanguage && !meaningful) return reply;

  try {
    const [user] = await db.select().from(users).where(eq(users.id, scope.userId)).limit(1);
    if (!user) return reply;
    const dayStart = sastDayStart(new Date());
    const [todayWorkouts, todaySteps, latestWeightRow] = await Promise.all([
      db.select({ id: workoutLogs.id, loggedAt: workoutLogs.loggedAt }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, scope.userId), gte(workoutLogs.loggedAt, dayStart))).limit(5),
      db.select({ steps: stepLogs.steps }).from(stepLogs)
        .where(and(eq(stepLogs.userId, scope.userId), gte(stepLogs.loggedAt, dayStart)))
        .orderBy(desc(stepLogs.loggedAt)).limit(10),
      db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs)
        .where(eq(weightLogs.userId, scope.userId)).orderBy(desc(weightLogs.loggedAt)).limit(1),
    ]);
    const latestLoggedSteps = Number(todaySteps[0]?.steps || 0);
    const replyStepNumbers = extractStepNumbers(draft);
    const staleStepQuery = EXPLICIT_STEP_QUERY.test(scope.inputText)
      && replyStepNumbers.length > 0
      && latestLoggedSteps > 0
      && replyStepNumbers.some(n => n !== latestLoggedSteps);
    const latestWeight = latestWeightRow[0]?.weight == null ? null : Number(latestWeightRow[0].weight);
    const replyWeightNumbers = extractWeightNumbers(draft);
    const staleWeightQuery = EXPLICIT_WEIGHT_QUERY.test(scope.inputText)
      && replyWeightNumbers.length > 0
      && latestWeight != null
      && Number.isFinite(latestWeight)
      && replyWeightNumbers.some(n => Math.abs(n - latestWeight) > 0.1);
    // ── STALE NUMBERS ARE CORRECTED FROM THE LEDGER, NOT BY A SECOND MODEL CALL ──────────────
    // We already hold the authoritative row. Asking a model to "rewrite using the latest step
    // count" was strictly worse than substituting it: slower, billed, and its output went out
    // unverified. A number we can read is a number we can fix.
    let corrected = draft;
    if (staleStepQuery) {
      for (const wrong of replyStepNumbers) {
        if (wrong === latestLoggedSteps) continue;
        corrected = replaceNumberToken(corrected, wrong, latestLoggedSteps);
      }
      console.warn(`[POST_TURN_FIX] ...${scope.userId.slice(-6)} steps ${replyStepNumbers.join(",")} → ${latestLoggedSteps}`);
    }
    if (staleWeightQuery && latestWeight != null) {
      for (const wrong of replyWeightNumbers) {
        if (Math.abs(wrong - latestWeight) <= 0.1) continue;
        corrected = replaceNumberToken(corrected, wrong, latestWeight);
      }
      console.warn(`[POST_TURN_FIX] ...${scope.userId.slice(-6)} weight ${replyWeightNumbers.join(",")} → ${latestWeight}`);
    }
    if (corrected === draft) return reply;

    // A CORRECTION IS RE-VERIFIED BEFORE IT CAN BE SENT. The old path had no such discipline —
    // whatever the second model returned went straight out.
    const recheck = verifyBrainReply(corrected, { clientMessage: scope.inputText, evidence: scope.evidence });
    if (!recheck.ok) {
      console.error(`[REPLY_BLOCKED] ...${scope.userId.slice(-6)} — correction failed re-verification: ${recheck.violation}`);
      return await safeReplacementFor(recheck.violation || "", scope);
    }
    try {
      const [lastLog] = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, scope.userId), eq(chatHistory.messageIn, scope.inputText)))
        .orderBy(desc(chatHistory.createdAt)).limit(1);
      if (lastLog) await db.update(chatHistory).set({ messageOut: corrected }).where(eq(chatHistory.id, lastLog.id));
    } catch (logErr) { console.warn("[POST_TURN_FIX] chatHistory update non-fatal:", (logErr as any)?.message || logErr); }
    return corrected;
  } catch (e) {
    console.warn("[POST_TURN_RECONCILE] non-fatal:", (e as any)?.message || e);
    return reply;
  }
}

export async function inTurn<T>(inputType: string, inputText: string, fn: () => Promise<T>): Promise<T> {
  let resolveFinalReply!: (reply: string) => void;
  const finalReplyPromise = new Promise<string>(resolve => { resolveFinalReply = resolve; });
  return turnStore.run({ userId: null, inputType, inputText: (inputText || "").slice(0, 2000), resolvedDay: null, stateRead: {}, mutations: [], startedAt: Date.now(), finalReplyPromise }, async () => {
    try {
      const result = await fn();
      if (typeof result !== "string") {
        resolveFinalReply(String(result ?? ""));
        return result;
      }
      const finalReply = await reconcileTurnReply(turnStore.getStore()!, result);
      resolveFinalReply(finalReply);
      return finalReply as T;
    } catch (err) {
      resolveFinalReply("");
      throw err;
    }
  });
}

export function turnUser(userId: string): void { const t = turnStore.getStore(); if (t) t.userId = userId; }
/**
 * WHAT THIS TURN HAS ACTUALLY WRITTEN, so far (2026-08-22).
 *
 * turnMutation has been recording durable writes since the write-integrity cut; nothing could
 * READ them mid-turn, so the router had no way to ask "has the fact this client stated been
 * committed yet?" and resolveTurn invented its own answer from an in-memory object. This is the
 * reader. It is the same list the write-integrity boundary already trusts.
 */
export function turnMutations(): string[] { return turnStore.getStore()?.mutations ?? []; }
export function turnMutation(note: string, logPrefix?: string): void { const t = turnStore.getStore(); if (t && t.mutations.length < 40) t.mutations.push(note); if (logPrefix) console.log(`${logPrefix} ${note}`); }
export function turnState(facts: Record<string, unknown>, resolvedDay?: string | null): void { const t = turnStore.getStore(); if (!t) return; Object.assign(t.stateRead, facts); if (resolvedDay) t.resolvedDay = resolvedDay; }

/**
 * THE TRUTH SOURCE RECORDS WHAT IT HANDED OUT (2026-08-20, response-graph audit).
 *
 * The verifier used to infer a number's provenance from the client's WORDING, so a step count
 * read straight from the day ledger was rejected as an invention. The fix is not a wider phrase
 * list — it is for the mouth to check the claim against the value we actually hold.
 *
 * getDayLedger calls this when it computes a day. No extra query: the one read that already
 * happened leaves its value on the turn, and reconcileTurnReply validates against it. A turn where
 * nothing read the ledger records nothing, and every rule behaves exactly as it did before.
 */
export function turnEvidence(facts: NonNullable<TurnScope["evidence"]>): void {
  const t = turnStore.getStore();
  if (!t) return;
  t.evidence = { ...(t.evidence || {}), ...facts };
}

export async function recordTurn(reply: string): Promise<void> {
  const t = turnStore.getStore();
  if (!t?.userId) return;
  try {
    const recordedReply = await Promise.race([
      t.finalReplyPromise,
      new Promise<string>(resolve => setTimeout(() => resolve(reply || ""), 20000)),
    ]);
    const decision = currentRuntimeDecision();
    const evidenceRefs = decision?.focus === "safety" ? ["safety_gate"] : decision?.focus === "hunger" ? ["hunger_evidence"] : decision?.focus === "intake" ? ["deficit_evidence"] : [];
    const stateRead = decision ? { ...t.stateRead, decisionState: decision.state, decisionEvidence: decision.evidence, decisionFocus: decision.focus, decisionEvidenceRefs: evidenceRefs, meaningfulProblem: decision.meaningfulProblem, hasMinimumUsefulQuestion: decision.hasMinimumUsefulQuestion } : t.stateRead;
    await db.insert(turnLedger).values({
      userId: t.userId, inputType: t.inputType, inputText: t.inputText, resolvedDay: t.resolvedDay,
      stateRead: Object.keys(stateRead).length ? stateRead : null, mutations: t.mutations.length ? t.mutations : null,
      reply: recordedReply.slice(0, 4000), replyMs: Date.now() - t.startedAt,
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || process.env.APP_VERSION || "dev",
    });
  } catch (e) { console.warn("[TURN_LEDGER] non-fatal:", (e as any)?.message); }
}
