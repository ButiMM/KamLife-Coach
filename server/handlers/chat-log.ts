import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import { users, chatHistory, escalations, turnLedger, workoutLogs, stepLogs, weightLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA, isSyntheticTestClient } from "../safety-detection";
import { currentRuntimeDecision } from "../understanding/state";
import { verifyBrainReply } from "../brain/reply-verifier";
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
    if (normPhone(clientPhone) === normPhone(process.env.COACH_ALERT_PHONE) || isSyntheticTestClient(clientPhone)) return;
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

function safeReplacementFor(violation: string): string {
  return /medication|medical|cure|reverse|heal|diagnos/i.test(violation) ? CLINICAL_REFERRAL : WITHHOLD;
}

async function reconcileTurnReply(scope: TurnScope, reply: string): Promise<string> {
  if (process.env.NODE_ENV === "test" || !scope.userId || !reply) return reply;
  const draft = String(reply).trim();
  const verifier = verifyBrainReply(draft, { clientMessage: scope.inputText });

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
    const safe = safeReplacementFor(verifier.violation || "");
    // The row keeps what actually went out. A blocked reply is an escalation, not a log line.
    await db.insert(escalations).values({
      userId: scope.userId, reason: "reply_blocked_by_verifier", status: "open",
      triggerMessage: `${(verifier.violation || "").slice(0, 300)} || draft: ${draft.slice(0, 200)}`,
      priority: "high", slaDeadline: new Date(Date.now() + 24 * 3_600_000),
    }).catch(() => {});
    return safe;
  }

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
    const recheck = verifyBrainReply(corrected, { clientMessage: scope.inputText });
    if (!recheck.ok) {
      console.error(`[REPLY_BLOCKED] ...${scope.userId.slice(-6)} — correction failed re-verification: ${recheck.violation}`);
      return safeReplacementFor(recheck.violation || "");
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
export function turnMutation(note: string, logPrefix?: string): void { const t = turnStore.getStore(); if (t && t.mutations.length < 40) t.mutations.push(note); if (logPrefix) console.log(`${logPrefix} ${note}`); }
export function turnState(facts: Record<string, unknown>, resolvedDay?: string | null): void { const t = turnStore.getStore(); if (!t) return; Object.assign(t.stateRead, facts); if (resolvedDay) t.resolvedDay = resolvedDay; }

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
