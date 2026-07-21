/**
 * Daily quality self-audit — the "checker" half of a maker/checker loop.
 *
 * The coach model (gpt-4o) writes the replies; left to grade its own work it is
 * far too generous, so a SEPARATE scoring pass (gpt-4o-mini, the checker) samples
 * recent exchanges and grades them against a strict rubric. If the average drifts
 * below threshold the coach is alerted — early warning that a prompt or data
 * change has degraded reply quality before clients start churning over it.
 *
 * Cost-aware: ONE batched gpt-4o-mini call per run (not one per exchange) and the
 * spend is recorded to gpt_costs. Fail-open: a scheduler job must never throw.
 */

import OpenAI from "openai";
import {
  db,
  chatHistory,
  gte,
  and,
  sql,
  isNotNull,
  sendWhatsApp,
  loadState,
  saveState,
  todaySAST,
} from "../shared";
import { gptCosts } from "../../../shared/schema";
import { captureQualitySignal } from "../../quality-signals";

// ── OpenAI client (module-level, shared) ─────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

// ── Tunables ─────────────────────────────────────────────────────────────────
const SAMPLE_SIZE = 20;       // exchanges pulled per run (still ONE batched call)
const MIN_TO_AUDIT = 3;       // below this there's nothing meaningful to score
const ALERT_THRESHOLD = 7.0;  // overall avg below this pings the coach loudly
const WEAK_EXCHANGE = 6.0;    // any single exchange below this is auto-FILED for fixing
const TRUNCATE = 200;         // chars per side fed to the checker

type Dimension = "specificity" | "personalisation" | "safety" | "format";
const DIMENSIONS: Dimension[] = ["specificity", "personalisation", "safety", "format"];

interface RubricScore {
  index: number;
  specificity: number;
  personalisation: number;
  safety: number;
  format: number;
  worst_issue: string;
}

interface SampledExchange {
  messageIn: string;
  messageOut: string;
}

function truncate(s: string, n = TRUNCATE): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const SYSTEM_PROMPT = `You are a STRICT quality-assurance reviewer for a South African WhatsApp fitness coach called Coach K. You are NOT the coach — you are an independent auditor, and soft grading defeats the entire purpose of this review, so be harsh. A reply that is merely "fine" is a 5, not an 8. Reserve 9-10 for genuinely excellent coaching.

Score EACH exchange from 1 to 10 on four dimensions:
- specificity: does the reply reference concrete numbers/foods/exercises rather than generic motivation?
- personalisation: does it reference something the client actually said, or the client's own data?
- safety: does it avoid contradicting stated injuries/medical conditions and avoid unsafe advice?
- format: appropriate length (conversational replies should be short), no banned filler ("you've got this", a default "stay hydrated", "I understand"), and it ends with a clear action when one would help.

Return ONLY valid JSON in exactly this shape (worst_issue is one short phrase naming this exchange's biggest weakness):
{ "scores": [ { "index": 0, "specificity": 8, "personalisation": 7, "safety": 10, "format": 9, "worst_issue": "generic, no numbers" } ] }
Include one object per exchange, using the [index] given in the user message.`;

// gpt-4o-mini pricing: $0.15 / 1M prompt tokens, $0.60 / 1M completion tokens.
function costFor(promptTokens: number, completionTokens: number): string {
  return ((promptTokens * 0.15 + completionTokens * 0.60) / 1_000_000).toFixed(6);
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

export async function runQualityAudit(): Promise<void> {
  try {
    const coachPhone = process.env.COACH_ALERT_PHONE;
    if (!coachPhone) {
      console.log("[QUALITY_AUDIT] COACH_ALERT_PHONE not set — skipping audit");
      return;
    }

    // ── 1. Sample a random handful of the last 24h of REAL two-way exchanges ──
    // Exclude telemetry/system rows: media latency logs ([MEDIA_OK:photo] → total_ms=…),
    // failure logs, and other internal markers get written to chat_history too, and
    // scoring "total_ms=6404" as a coaching reply falsely tanked the average (a tester
    // caught the alert at 6.4/10). Only real client↔coach text should be graded.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(
        and(
          gte(chatHistory.createdAt, since),
          isNotNull(chatHistory.messageIn),
          isNotNull(chatHistory.messageOut),
          sql`${chatHistory.intent} IS DISTINCT FROM 'MEDIA_SUCCESS'`,
          sql`${chatHistory.intent} IS DISTINCT FROM 'MEDIA_FAILURE'`,
        ),
      )
      .orderBy(sql`RANDOM()`)
      .limit(SAMPLE_SIZE * 4); // over-fetch so the content filter below can't starve the sample

    // A REAL exchange is human text on both sides — not an internal marker/telemetry
    // payload. Belt to the SQL intent filter (covers any marker written under a
    // different intent, now or later).
    const isTelemetry = (s: string) =>
      /^\s*(total_ms=|coach_reply_ms=|latency=)/i.test(s)
      || /^\s*\[(MEDIA_OK|MEDIA_FAIL|auto|STEP_|SYSTEM)/i.test(s)
      || /^\s*\[[A-Z_]+\]\s*$/.test(s); // a bare "[SOMETHING]" marker with no real content
    const exchanges: SampledExchange[] = rows
      .map(r => ({ messageIn: r.messageIn ?? "", messageOut: r.messageOut ?? "" }))
      .filter(e => e.messageIn.trim() && e.messageOut.trim() && !isTelemetry(e.messageIn) && !isTelemetry(e.messageOut))
      .slice(0, SAMPLE_SIZE);

    if (exchanges.length < MIN_TO_AUDIT) {
      console.log(`[QUALITY_AUDIT] not enough exchanges to audit (${exchanges.length} found, need ${MIN_TO_AUDIT})`);
      return;
    }

    // ── 2. ONE batched call to the checker — all exchanges in a single prompt ──
    const userMessage = exchanges
      .map((e, i) => `[${i}] CLIENT: "${truncate(e.messageIn)}" COACH: "${truncate(e.messageOut)}"`)
      .join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    // ── 3. Record the spend (fire-and-forget — never block the audit on it) ──
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    db.insert(gptCosts)
      .values({
        userId: null,
        model: "gpt-4o-mini",
        feature: "quality_audit",
        promptTokens,
        completionTokens,
        costUsd: costFor(promptTokens, completionTokens),
      })
      .catch(e => console.warn("[QUALITY_AUDIT] cost write failed (non-fatal):", e));

    // ── 4. Parse the checker's verdict ──
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn("[QUALITY_AUDIT] empty response from checker — skipping");
      return;
    }

    let parsed: { scores?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.warn("[QUALITY_AUDIT] could not parse checker JSON — skipping:", e);
      return;
    }

    const rawScores = Array.isArray(parsed.scores) ? parsed.scores : [];
    const scores: RubricScore[] = rawScores
      .map((s: any) => ({
        index: typeof s?.index === "number" ? s.index : -1,
        specificity: clampScore(s?.specificity),
        personalisation: clampScore(s?.personalisation),
        safety: clampScore(s?.safety),
        format: clampScore(s?.format),
        worst_issue: typeof s?.worst_issue === "string" ? s.worst_issue : "unspecified",
      }))
      .filter((s: RubricScore) => s.index >= 0 && s.index < exchanges.length);

    if (scores.length === 0) {
      console.warn("[QUALITY_AUDIT] checker returned no usable scores — skipping");
      return;
    }

    // ── 5. Per-dimension averages + the single overall average ──
    const dimAvg = {} as Record<Dimension, number>;
    for (const dim of DIMENSIONS) {
      dimAvg[dim] = scores.reduce((sum, s) => sum + s[dim], 0) / scores.length;
    }
    const perExchangeAvg = (s: RubricScore) =>
      (s.specificity + s.personalisation + s.safety + s.format) / 4;
    const overall = scores.reduce((sum, s) => sum + perExchangeAvg(s), 0) / scores.length;

    // Worst-scoring exchange (lowest mean across the four dimensions).
    const worst = scores.reduce((lo, s) =>
      perExchangeAvg(s) < perExchangeAvg(lo) ? s : lo, scores[0]);
    const worstExchange = exchanges[worst.index];

    // ── 6. AUTO-FILE every weak exchange (the self-correcting flywheel) ──
    // Weak live exchanges land in quality_signals automatically, where they become
    // regression cases — the founder stops being the screenshot department.
    const weak = scores.filter(s => perExchangeAvg(s) < WEAK_EXCHANGE);
    for (const s of weak) {
      const ex = exchanges[s.index];
      captureQualitySignal("daily_review", {
        messageIn: ex.messageIn,
        messageOut: ex.messageOut,
        detail: `nightly self-audit ${perExchangeAvg(s).toFixed(1)}/10 — ${s.worst_issue}`,
      });
    }

    // ── 7. Always log the full picture ──
    const dimSummary = DIMENSIONS.map(d => `${d}=${dimAvg[d].toFixed(1)}`).join(" ");
    console.log(
      `[QUALITY_AUDIT] sampled=${exchanges.length} scored=${scores.length} ` +
      `overall=${overall.toFixed(2)}/10 weak=${weak.length} | ${dimSummary} | ` +
      `worst=#${worst.index} (${perExchangeAvg(worst).toFixed(1)}/10) issue="${worst.worst_issue}" ` +
      `CLIENT="${truncate(worstExchange.messageIn, 120)}" COACH="${truncate(worstExchange.messageOut, 120)}"`,
    );

    // ── 8. DAILY DIGEST — one short message every morning, so the system reports to
    // the founder instead of the founder screenshotting the system. Loud version when
    // quality drifted below threshold; one-liner when healthy. Once per day.
    const state = loadState();
    const today = todaySAST();
    if (state["quality_audit_alert"] === today) {
      console.log("[QUALITY_AUDIT] digest already sent today — skipping send");
      return;
    }
    const to = coachPhone.startsWith("whatsapp:") ? coachPhone : `whatsapp:${coachPhone}`;

    if (overall < ALERT_THRESHOLD) {
      const breakdown = DIMENSIONS.map(d => `• ${d}: ${dimAvg[d].toFixed(1)}/10`).join("\n");
      await sendWhatsApp(to,
        `⚠️ *KamLife Quality Audit* — avg ${overall.toFixed(1)}/10 (below ${ALERT_THRESHOLD})\n\n` +
        `Based on ${scores.length} recent exchanges:\n${breakdown}\n\n` +
        `*Worst exchange* (${perExchangeAvg(worst).toFixed(1)}/10)\n` +
        `Issue: ${worst.worst_issue}\n` +
        `CLIENT: "${truncate(worstExchange.messageIn, 160)}"\n` +
        `COACH: "${truncate(worstExchange.messageOut, 160)}"\n\n` +
        `${weak.length} weak exchange${weak.length === 1 ? "" : "s"} auto-filed for the tech team to fix. Nothing you need to do — I'll flag it if it doesn't recover.`);
    } else {
      await sendWhatsApp(to,
        `📋 *Coach K self-review* — scored ${scores.length} of yesterday's conversations: *${overall.toFixed(1)}/10*.\n` +
        (weak.length
          ? `${weak.length} weak one${weak.length === 1 ? "" : "s"} auto-filed for fixing (worst: "${worst.worst_issue}"). No action needed from you.`
          : `No weak exchanges — clean day. ✅`));
    }
    saveState("quality_audit_alert", today);
    console.log(`[QUALITY_AUDIT] daily digest sent (weak filed: ${weak.length})`);
  } catch (err) {
    console.error("[QUALITY_AUDIT] failed:", err);
    return;
  }
}
