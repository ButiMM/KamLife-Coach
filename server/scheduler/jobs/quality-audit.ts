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

// ── OpenAI client (module-level, shared) ─────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

// ── Tunables ─────────────────────────────────────────────────────────────────
const SAMPLE_SIZE = 8;        // exchanges pulled per run (batched into one call)
const MIN_TO_AUDIT = 3;       // below this there's nothing meaningful to score
const ALERT_THRESHOLD = 7.0;  // overall avg below this pings the coach
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

    // ── 1. Sample a random handful of the last 24h of real two-way exchanges ──
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(
        and(
          gte(chatHistory.createdAt, since),
          isNotNull(chatHistory.messageIn),
          isNotNull(chatHistory.messageOut),
        ),
      )
      .orderBy(sql`RANDOM()`)
      .limit(SAMPLE_SIZE);

    const exchanges: SampledExchange[] = rows
      .map(r => ({ messageIn: r.messageIn ?? "", messageOut: r.messageOut ?? "" }))
      .filter(e => e.messageIn.trim() && e.messageOut.trim());

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

    // ── 6. Always log the full picture ──
    const dimSummary = DIMENSIONS.map(d => `${d}=${dimAvg[d].toFixed(1)}`).join(" ");
    console.log(
      `[QUALITY_AUDIT] sampled=${exchanges.length} scored=${scores.length} ` +
      `overall=${overall.toFixed(2)}/10 | ${dimSummary} | ` +
      `worst=#${worst.index} (${perExchangeAvg(worst).toFixed(1)}/10) issue="${worst.worst_issue}" ` +
      `CLIENT="${truncate(worstExchange.messageIn, 120)}" COACH="${truncate(worstExchange.messageOut, 120)}"`,
    );

    // ── 7. Alert the coach only when quality has actually drifted ──
    if (overall < ALERT_THRESHOLD) {
      const state = loadState();
      const today = todaySAST();
      if (state["quality_audit_alert"] === today) {
        console.log("[QUALITY_AUDIT] below threshold but already alerted today — skipping send");
        return;
      }

      const breakdown = DIMENSIONS.map(d => `• ${d}: ${dimAvg[d].toFixed(1)}/10`).join("\n");
      const body =
        `⚠️ *KamLife Quality Audit* — avg ${overall.toFixed(1)}/10 (below ${ALERT_THRESHOLD})\n\n` +
        `Based on ${scores.length} recent exchanges:\n${breakdown}\n\n` +
        `*Worst exchange* (${perExchangeAvg(worst).toFixed(1)}/10)\n` +
        `Issue: ${worst.worst_issue}\n` +
        `CLIENT: "${truncate(worstExchange.messageIn, 160)}"\n` +
        `COACH: "${truncate(worstExchange.messageOut, 160)}"\n\n` +
        `Check recent prompt or data changes — reply quality has slipped.`;

      const to = coachPhone.startsWith("whatsapp:") ? coachPhone : `whatsapp:${coachPhone}`;
      await sendWhatsApp(to, body);
      saveState("quality_audit_alert", today);
      console.log("[QUALITY_AUDIT] alert sent to coach");
    }
  } catch (err) {
    console.error("[QUALITY_AUDIT] failed:", err);
    return;
  }
}
