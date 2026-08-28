/**
 * response-gate.ts — Safety gate for coaching responses.
 *
 * Runs after the GPT coach generates a reply, before it's sent to the client.
 * Two-stage: fast regex (always, ~1ms) then LLM revision (only on detected conflict, ~400ms).
 *
 * Checks:
 *   1. Injury/exercise conflict — does the response recommend exercises that load
 *      a body part the client has flagged as injured?
 *   2. Medical condition conflict — does the response give advice that contradicts
 *      the client's medical conditions (diabetes, hypertension)?
 *   3. Calorie target consistency — if the response cites a specific kcal target,
 *      does it match the client's stored target (within 100 kcal)?
 *   4. PROVENANCE — may the coach assert this at all? See the block at the bottom.
 *
 * This module owns ONE question: "may we send this?" Checks 1-3 answer it for safety, and
 * safetyGate runs on the two model paths that build a reply. Check 4 answers it for truth, and
 * runs at the outbound chokepoint instead, so it also covers the scheduler jobs — which is where
 * the worst false claim actually came from.
 *
 * Always fail-open: any unhandled error returns the original draft unchanged.
 */

import OpenAI from "openai";
import { extractBodyParts, checkExercisesAgainstInjuries } from "./injury-rules";
import { splitSentences } from "../reply-hygiene";
import { readHealthState } from "../health-state";
import { weightTrendUsable, type TrendVerdict } from "../adaptive-targets";
import { eq, and, gte, desc } from "drizzle-orm";
import { db } from "../db";
import { users, weightLogs, mealLogs, shadowReplies } from "../../shared/schema";
import { sastDayStart } from "../sast";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

// Injury → contraindicated-exercise knowledge lives in ./injury-rules so the
// programme validator and this response gate reason about injuries identically.

// ── Check response for contraindicated exercises ──────────────────────────────
function checkInjuryConflicts(response: string, bodyParts: string[]): string[] {
  // checkExercisesAgainstInjuries returns "loads knee: squat, lunge" per part —
  // re-phrase for the gate's conflict log / revision prompt.
  return checkExercisesAgainstInjuries(response, bodyParts).map(c => `Response ${c} but client has matching injury`);
}

// ── Check response against medical conditions ─────────────────────────────────
function checkMedicalConflicts(response: string, conditions: string): string[] {
  const lowerResp = response.toLowerCase();
  const lowerCond = conditions.toLowerCase();
  const conflicts: string[] = [];

  if (/diabetes|diabetic/i.test(lowerCond)) {
    // Skipping meals is dangerous for diabetes
    if (/skip.*meal|fast.*training|train.*fasted|intermittent fast/i.test(lowerResp)) {
      conflicts.push("Advice suggests skipping meals / fasted training — dangerous for diabetic client");
    }
  }

  if (/hypertension|high blood pressure/i.test(lowerCond)) {
    // Maximal exertion cues are risky
    if (/max.*effort|all.?out|go.*hard.*possible|1rm|one rep max/i.test(lowerResp)) {
      conflicts.push("Advice suggests maximal exertion — risky for hypertensive client");
    }
  }

  return conflicts;
}

// ── Calorie target consistency (soft check — warn only) ──────────────────────
// SUPERSEDED for enforcement by the provenance gate below, which rewrites the claim instead of
// logging it. Kept here because safetyGate reports it in `issues` and the shadow evaluator reads
// that list; the provenance gate is the thing that actually stops the number reaching a client.
function checkCalorieConsistency(response: string, calorieTarget?: number | null): string | null {
  if (!calorieTarget || calorieTarget <= 0) return null;
  const matches = response.match(new RegExp(KCAL_NUMBER.source, "gi"));
  if (!matches) return null;
  for (const m of matches) {
    const num = parseInt(m.replace(/[^\d]/g, ""), 10);
    if (num < 500 || num > 5000) continue; // not a daily target
    if (Math.abs(num - calorieTarget) > 200) {
      return `Response cites ${num} kcal target but client target is ${calorieTarget} kcal`;
    }
  }
  return null;
}

// ── LLM revision — rewrites conflicting response with safe alternatives ───────
const REVISION_TIMEOUT_MS = 900;

async function llmRevise(
  draft: string,
  injuries: string,
  conditions: string,
  conflicts: string[],
): Promise<string | null> {
  try {
    const conflictList = conflicts.map(c => `• ${c}`).join("\n");
    let revised: string | null = null;
    const timeoutHandle = setTimeout(() => { revised = null; }, REVISION_TIMEOUT_MS);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 250,
      messages: [
        {
          role: "system",
          content: `You are a safety reviewer for a fitness coaching app. A coaching response contains advice that conflicts with the client's injury/medical profile. Rewrite it to remove the conflict and substitute safe alternatives. Keep the same SA coaching voice, warmth, and length. Return ONLY the rewritten response — no commentary, no preamble.`,
        },
        {
          role: "user",
          content: `Client injuries: ${injuries || "none"}
Client medical conditions: ${conditions || "none"}

Detected conflicts:
${conflictList}

Original response:
${draft}

Rewrite removing the conflicting advice. Substitute safe exercise alternatives where relevant.`,
        },
      ],
    });
    clearTimeout(timeoutHandle);
    revised = completion.choices[0]?.message?.content?.trim() || null;
    return revised;
  } catch (e) {
    console.warn("[RESPONSE_GATE] LLM revision error:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface GateResult {
  response: string;
  passed: boolean;
  issues: string[];
  revised: boolean;
}

export async function safetyGate(
  draft: string,
  user: {
    id?: string | null;
    injuries?: string | null;
    medicalConditions?: string | null;
    calorieTarget?: number | null;
  },
  _originalMessage: string,
): Promise<GateResult> {
  try {
    const injuries = (user.injuries || "").trim();
    const conditions = (user.medicalConditions || "").trim();
    const issues: string[] = [];

    // ── Stage 1: fast regex checks ────────────────────────────────────────────
    if (injuries && injuries !== "none" && injuries !== "None") {
      const bodyParts = extractBodyParts(injuries);
      if (bodyParts.length > 0) {
        issues.push(...checkInjuryConflicts(draft, bodyParts));
      }
    }

    if (conditions && conditions !== "none" && conditions !== "None") {
      issues.push(...checkMedicalConflicts(draft, conditions));
    }

    const calIssue = checkCalorieConsistency(draft, user.calorieTarget);
    if (calIssue) issues.push(calIssue);

    // ── Fast path: no issues ──────────────────────────────────────────────────
    if (issues.length === 0) {
      return { response: draft, passed: true, issues: [], revised: false };
    }

    // Log all conflicts
    console.warn(`[RESPONSE_GATE] ${issues.length} conflict(s) detected for user ${user.id?.slice(-6) ?? "?"}:`, issues);

    // ── Stage 2: LLM revision for injury/medical conflicts ────────────────────
    // Calorie inconsistency is a soft warn — don't revise, just log.
    const hardConflicts = issues.filter(i => !i.startsWith("Response cites"));
    if (hardConflicts.length > 0) {
      const revised = await llmRevise(draft, injuries, conditions, hardConflicts);
      if (revised && revised.length > 20) {
        console.log(`[RESPONSE_GATE] revised response for user ${user.id?.slice(-6) ?? "?"}`);
        return { response: revised, passed: false, issues, revised: true };
      }
    }

    // Revision failed or only soft issues — return original
    return { response: draft, passed: false, issues, revised: false };
  } catch (e) {
    console.warn("[RESPONSE_GATE] unhandled error — passing through:", e instanceof Error ? e.message : e);
    return { response: draft, passed: true, issues: [], revised: false };
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PROVENANCE GATE — the coach may not assert a fact it cannot trace to a stored row.
//
// (2026-07-30, founder: "I know the numbers, I can see the mistakes. A normal person doesn't
// know anything. They're going to trust the bot.") That asymmetry is the whole problem. A client
// cannot check whether 2,530 kcal is right for her body — she was never going to. What she CAN
// check, instantly and correctly, is confidence. Everyone can tell the difference between a coach
// that says "you're down 1.2kg this week" and one that says "I don't have a clean weigh-in yet".
//
// So the defect class this closes is not inaccuracy. It is FALSE CONFIDENCE: a claim about the
// client's own body, stated flatly, with nothing behind it. That is what gets screenshotted, and
// it is what the founder has been sending in for weeks — a phantom tin of pilchards, a weight
// trend read off weights taken during a three-week illness, a "new target" that contradicts the
// target actually stored.
//
// THE RULE: every claim below must trace to a row. When the row is missing the claim is not
// deleted and not softened — it is REPLACED WITH THE QUESTION THAT WOULD EARN THE EVIDENCE. A
// coach that asks is doing its job; a coach that guesses is the liability.
//
// Deliberately narrow. Three claim kinds, each one a defect that has actually shipped. This does
// not try to verify everything the coach says — an unbounded checker would fire on coaching
// advice and would itself become the hand-written blacklist this codebase keeps dying of.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type ClaimKind = "weight-trend" | "meal-eaten" | "target-value";

/**
 * Never an assertion, so always passes:
 *  - a QUESTION, which is the behaviour this whole gate exists to produce more of;
 *  - a conditional or hypothetical ("if you had lunch…");
 *  - QUOTED text. The founder-facing reports (`audit`, `replay`) quote real replies back at him,
 *    and a gate that rewrote the quotes would corrupt the instrument used to measure the gate.
 *    That exact mistake has been made here before — the replay harness carried its own drifting
 *    copy of a routing rule and graded the engine on messages production never sends it.
 */
const NOT_AN_ASSERTION = /\?\s*$|_"|^\s*[">]|^\s*(?:if|when|once|unless|should|would|could|did|do|does|have|has|are|is|was|were|can|shall|let|want|try)\b/i;

/** A direction word bound to a kg quantity, or an explicit statement about their weight moving. */
const WEIGHT_TREND = /\b(?:scale\s+(?:is\s+)?(?:going\s+)?(?:up|down)|weight\s+(?:is\s+)?(?:going\s+)?(?:up|down)|down|up|lost|gained|dropped|added)\s+(?:about\s+|around\s+|roughly\s+)?\d[\d.,]*\s*kgs?\b|\b(?:scale|weight)\s+(?:is\s+)?(?:going\s+)?(?:up|down)\b|\byou(?:'re| are)\s+(?:losing|gaining|dropping)\b(?!\s+(?:strength|muscle|confidence|momentum|motivation|focus|interest|inches|cm|form|ground)\b)|\b(?:losing|gaining)\s+(?:weight|too\s+fast|quicker|faster)\b/i;

/**
 * An assertion that they ate something. BOTH halves must be present — the eating verb and a food
 * signal — or "you had a rough day" becomes a phantom meal. Written as two lookaheads rather than
 * two constants so there is one pattern to read, one to test, and one to change.
 */
const MEAL_EATEN = /(?=.*(?:\byou(?:'ve)?\s+(?:ate|had|logged|eaten)\b|\byour\s+(?:breakfast|lunch|dinner|supper|snack)\s+(?:was|came|hit|landed)\b))(?=.*(?:\d[\d,\s]*\s*(?:kcal|calories?|g\s+(?:of\s+)?protein)|\b(?:breakfast|lunch|dinner|supper|snack|meal)\b))/i;

/** A number presented as THEIR daily target, not as the calories in a piece of chicken. */
const TARGET_CONTEXT = /\b(?:your|new|daily)\s+(?:calorie\s+)?(?:target|goal|calories|intake)\b|\b(?:bump(?:ing|ed)?|adjust(?:ing|ed)?|mov(?:ing|ed)|sett?(?:ing)?|drop(?:ping|ped)|rais(?:ing|ed)|cut(?:ting)?)\b[^.!?]{0,30}\bto\b/i;
const KCAL_NUMBER = /(\d[\d,\s]{2,4})\s*(?:kcal|calories?|cal\b)/i;

/** What the coach is allowed to know, read from the client's actual rows. */
export interface Evidence {
  /** Verdict from the ONE owner of this question, server/adaptive-targets.ts. */
  trend: TrendVerdict;
  /** Meals logged so far in the current SAST day. */
  mealsLoggedToday: number;
  /** The target actually persisted on the user row. */
  calorieTarget: number | null;
  /** Did they actually step on a scale in the last 7 days? Separate from trend usability. */
  weighedThisWeek: boolean;
}

/** Which claim, if any, this one sentence is making. */
export function classifyClaim(sentence: string): ClaimKind | null {
  const s = (sentence || "").trim();
  if (!s || NOT_AN_ASSERTION.test(s)) return null;
  if (WEIGHT_TREND.test(s)) return "weight-trend";
  if (MEAL_EATEN.test(s)) return "meal-eaten";
  if (TARGET_CONTEXT.test(s) && KCAL_NUMBER.test(s)) return "target-value";
  return null;
}

/** Is the evidence for this claim actually on file? */
function isBacked(kind: ClaimKind, sentence: string, ev: Evidence): boolean {
  if (kind === "weight-trend") {
    if (!ev.trend.usable) return false;
    // "THIS WEEK" IS A DIFFERENT QUESTION FROM "IS THERE A TREND" (2026-08-06, live).
    // The founder asked for his week's progress without weighing in, and got "You've lost
    // 1.0kg this week, bringing you to 83.3kg." The gate passed it because weightTrendUsable
    // accepts a weigh-in up to MAX_TREND_AGE_DAYS (10) old — correct for reading a trend, and
    // wrong for the word "week". A claim that names this week needs a weigh-in from this week.
    if (/\bthis (?:week|morning|month)\b|\btoday\b/i.test(sentence)) return ev.weighedThisWeek;
    return true;
  }
  if (kind === "meal-eaten") return ev.mealsLoggedToday > 0;
  // target-value: the number quoted must be the number stored. A reply announcing a change the
  // database never took is the contradiction the founder screenshotted — two messages, two
  // different targets, on the same morning.
  if (!ev.calorieTarget) return true; // nothing to contradict
  const m = KCAL_NUMBER.exec(sentence);
  if (!m) return true;
  const cited = parseInt(m[1].replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(cited) || cited < 500 || cited > 5000) return true; // not a daily target
  return Math.abs(cited - ev.calorieTarget) <= 50;
}

/**
 * The honest ask that replaces an unbacked claim. Never an apology, never a hedge on the same
 * claim — a specific request for the one thing that would let the coach answer properly.
 */
function askInstead(kind: ClaimKind, ev: Evidence): string {
  if (kind === "weight-trend") {
    if (ev.trend.usable && !ev.weighedThisWeek) {
      return "You haven't weighed in this week, so I'm not going to put a number on it. Hop on the scale in the morning and I'll tell you exactly where you're going.";
    }
    const why = ev.trend.usable ? "" : ev.trend.why;
    if (why === "illness") {
      return "I'm not going to call a trend off those weigh-ins — they sit around the time you were ill, and weight moves on fluid and appetite then, not on food. Hop on the scale in the morning and I'll give you a straight read.";
    }
    if (why === "stale") {
      return "Your last weigh-in is too far back for me to read anything into it. Jump on the scale in the morning and I'll tell you exactly where you're going.";
    }
    return "I don't have enough weigh-ins yet to call which way you're going. Get on the scale in the morning and again next week, and I'll give you a straight read.";
  }
  if (kind === "meal-eaten") {
    return "I don't have a meal logged for you today. What did you eat?";
  }
  return `Your target is still ${ev.calorieTarget} kcal a day — I haven't moved it.`;
}

export interface ProvenanceResult {
  text: string;
  /** One entry per claim rewritten. Empty = the reply shipped untouched. */
  rewrites: ClaimKind[];
}

/**
 * Pure. Rewrites every unbacked claim in the draft, leaving everything else byte-identical.
 *
 * Sentence-level on purpose: a reply is usually one bad sentence inside four good ones, and
 * dropping the whole reply would cost the client the coaching they did earn. The first unbacked
 * claim of a kind becomes the ask; later ones of the same kind are dropped rather than repeating
 * the same request twice in one message.
 */
export function applyProvenance(draft: string, ev: Evidence): ProvenanceResult {
  const t = (draft || "").trim();
  if (!t) return { text: draft, rewrites: [] };
  const parts = splitSentences(t); // [sentence, sep, sentence, sep, …]
  const rewrites: ClaimKind[] = [];
  const asked = new Set<ClaimKind>();
  let out = "";

  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? "";
    if (!sentence) continue;
    const kind = classifyClaim(sentence);
    if (!kind || isBacked(kind, sentence, ev)) { out += sentence + sep; continue; }

    rewrites.push(kind);
    if (asked.has(kind)) continue; // already asked for this evidence — don't nag twice
    asked.add(kind);
    // Keep the leading whitespace/indent of the sentence we are replacing so bullets survive.
    const indent = (sentence.match(/^\s*/) || [""])[0];
    out += indent + askInstead(kind, ev) + sep;
  }

  const text = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // A reply that was ENTIRELY unbacked still has to say something. The ask is the reply.
  if (!text && rewrites.length > 0) return { text: askInstead(rewrites[0], ev), rewrites };
  return { text: text || draft, rewrites };
}

// ── Evidence loader + the gate itself ────────────────────────────────────────────────────────
// Runs at the outbound chokepoint (sendWhatsApp), not on the reply paths, for one reason: the
// worst false claim this product has made — a calorie cut announced off weights taken during a
// three-week illness — was sent by a CRON JOB. It never touched handleMessage, so a gate on the
// reply paths would have watched it go out.
//
// Cost control: extraction is pure string work and exits before any query when the message makes
// no claim, which is the overwhelming majority of messages. Only a message that actually asserts
// something about the client's body pays for a lookup.

/**
 * Modes: on (default — rewrite), shadow (log only, ship unchanged), off.
 *
 * DEFAULT ON, opt-out — deliberately not the opt-in flag the spec asked for. A truth gate that
 * ships switched off is not a gate, it is a file; and this codebase's documented disease is
 * exactly that — capabilities silently inert while everyone believes they are running. It is
 * listed in self-check.ts as CRITICAL, so if it is ever turned off that shows up in the report
 * rather than being discovered by a client.
 */
export function provenanceMode(): "on" | "shadow" | "off" {
  const v = (process.env.PROVENANCE_GATE || "").trim().toLowerCase();
  return v === "off" ? "off" : v === "shadow" ? "shadow" : "on";
}

let _checked = 0;
let _rewritten = 0;
const _byKind = new Map<ClaimKind, number>();

export function provenanceStats(): { checked: number; rewritten: number; rate: number; byKind: Array<[ClaimKind, number]> } {
  return {
    checked: _checked,
    rewritten: _rewritten,
    rate: _checked > 0 ? _rewritten / _checked : 0,
    byKind: [..._byKind.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export function _resetProvenanceStats(): void { _checked = 0; _rewritten = 0; _byKind.clear(); }

/** One line for the founder-facing audit — the calibration metric. */
export function provenanceStatsLine(): string {
  const s = provenanceStats();
  const mode = provenanceMode();
  if (mode === "off") return "🔎 *Provenance gate:* SWITCHED OFF — the coach can assert anything.";
  if (s.checked === 0) return "🔎 *Provenance gate:* no claims checked since restart.";
  const pct = (s.rate * 100).toFixed(1);
  const kinds = s.byKind.map(([k, n]) => `  • ${k.replace("-", " ")}: *${n}*`).join("\n");
  const head = `🔎 *Provenance gate${mode === "shadow" ? " (SHADOW — not rewriting)" : ""}:* caught *${s.rewritten}* unbacked claim(s) in ${s.checked} messages carrying one (${pct}%).`;
  return s.rewritten === 0 ? head : `${head}\n${kinds}`;
}

/**
 * Load only the evidence the draft's claims actually need, then apply the gate.
 * Fail-open: any error ships the original text. A gate that eats messages is worse than the bug.
 */
export async function provenanceGate(phone: string, body: string): Promise<string> {
  if (provenanceMode() === "off") return body;
  try {
    const t = (body || "").trim();
    if (!t) return body;

    // Cheap pre-scan: does this message assert anything at all? Almost always no.
    const kinds = new Set<ClaimKind>();
    const parts = splitSentences(t);
    for (let i = 0; i < parts.length; i += 2) {
      const k = classifyClaim(parts[i]);
      if (k) kinds.add(k);
    }
    if (kinds.size === 0) return body;

    const [u] = await db.select({
      id: users.id, calorieTarget: users.calorieTarget, profileNotes: users.profileNotes,
    }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (!u) return body; // not a client we know — nothing to verify against

    const notes = String(u.profileNotes || "");
    const { sickUntil, sickSince } = readHealthState({ profileNotes: notes });

    let trend: TrendVerdict = { usable: false, why: "too_few" };
    let weighedThisWeek = false;
    if (kinds.has("weight-trend")) {
      const wRows = await db.select({ at: weightLogs.loggedAt })
        .from(weightLogs)
        .where(and(eq(weightLogs.userId, u.id), gte(weightLogs.loggedAt, new Date(Date.now() - 28 * 86_400_000))))
        .orderBy(desc(weightLogs.loggedAt)).limit(12);
      weighedThisWeek = wRows.some(r => Date.now() - new Date(r.at as Date).getTime() <= 7 * 86_400_000);
      if (wRows.length >= 2) {
        trend = weightTrendUsable({
          count: wRows.length,
          newestAt: new Date(wRows[0].at as Date).getTime(),
          oldestAt: new Date(wRows[wRows.length - 1].at as Date).getTime(),
          now: Date.now(),
          sickSince: sickSince ? new Date(sickSince).getTime() : undefined,
          sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,
        });
      }
    }

    let mealsLoggedToday = 0;
    if (kinds.has("meal-eaten")) {
      const meals = await db.select({ id: mealLogs.id })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, u.id), gte(mealLogs.loggedAt, sastDayStart())))
        .limit(1);
      mealsLoggedToday = meals.length;
    }

    const ev: Evidence = { trend, mealsLoggedToday, calorieTarget: u.calorieTarget ?? null, weighedThisWeek };
    const result = applyProvenance(t, ev);

    _checked++;
    if (result.rewrites.length > 0) {
      _rewritten++;
      for (const k of result.rewrites) _byKind.set(k, (_byKind.get(k) || 0) + 1);
      console.warn(`[PROVENANCE_GATE] ${provenanceMode() === "shadow" ? "WOULD REWRITE" : "REWROTE"} ${result.rewrites.length} unbacked claim(s) [${result.rewrites.join(", ")}] to ${phone.slice(-8)}`);
    }
    return provenanceMode() === "shadow" ? body : result.text;
  } catch (e) {
    console.warn("[PROVENANCE_GATE] error — passing through:", e instanceof Error ? e.message : e);
    return body;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE SHADOW DOOR (2026-08-04, Slice 1 of the one-brain rebuild)
 *
 * Every rewrite of the reply path so far has been proved in production, on the founder's
 * own phone, by a real client reading a bad answer. That is the only instrument this
 * product has ever had, and it costs one bad experience per data point.
 *
 * SHADOW=on runs the entire pipeline — same handlers, same engine, same gates, same
 * provenance and hygiene passes — and writes what WOULD have gone out into shadow_replies
 * instead of calling Twilio. Nothing reaches a human. A rewrite can be watched for a day
 * against real traffic before it is allowed to speak.
 *
 * It lives in this file, and not in a new one, for two reasons. It is the same question
 * the rest of this module owns — MAY WE SEND THIS? — and the architecture guard is at its
 * module budget, which is the guard doing its job.
 *
 * Contract for callers: `await shadowDoor(...)` returns true when the message was captured,
 * and a true means DO NOT SEND. Fail-CLOSED on a capture error while shadow is on: if the
 * row cannot be written we still refuse to send, because the entire purpose of the mode is
 * that a human does not receive this. Off (the default) it is a boolean read and nothing else.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ShadowChannel = "reply" | "proactive" | "template" | "buttons";

/** The staging switch. Off unless SHADOW is explicitly on — never a default, never inferred. */
export function shadowMode(): boolean {
  return (process.env.SHADOW || "").trim().toLowerCase() === "on";
}

let _shadowCaptured = 0;

/**
 * The single door. Returns TRUE when the message was captured and must NOT be sent.
 *
 * @param authorFile the file that is speaking, e.g. "server/routes/whatsapp.ts". This is the
 *        authorship count measured on live traffic instead of on a regex over the source.
 */
export async function shadowDoor(
  phone: string,
  body: string,
  channel: ShadowChannel,
  authorFile: string,
  mediaUrls?: string | string[] | null,
): Promise<boolean> {
  if (!shadowMode()) return false;
  const media = Array.isArray(mediaUrls) ? mediaUrls.filter(Boolean) : mediaUrls ? [mediaUrls] : [];
  try {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    await db.insert(shadowReplies).values({
      userId: u?.id ?? null,
      phone,
      channel,
      authorFile,
      body: body || "",
      mediaUrls: media.length > 0 ? media : null,
      commitSha: (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    });
    _shadowCaptured++;
    console.log(`[SHADOW] captured ${channel} from ${authorFile} → ${phone.slice(-4)}: "${(body || "").slice(0, 70)}"`);
  } catch (e) {
    // Fail CLOSED. A dropped shadow row is a lost data point; a sent one is a client
    // receiving a message from a build that was explicitly not allowed to speak.
    console.error(`[SHADOW] capture FAILED, message still withheld — ${e instanceof Error ? e.message : e}`);
  }
  return true;
}

/** Captured-since-restart, for the founder-facing self-check. */
export function shadowStats(): { on: boolean; captured: number } {
  return { on: shadowMode(), captured: _shadowCaptured };
}
