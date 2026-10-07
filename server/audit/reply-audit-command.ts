/**
 * COACH COMMAND "audit" — the reply defect scanner, over WhatsApp.
 *
 * (2026-07-27.) The CLI (script/reply-audit.ts) needs a shell and DATABASE_URL, which is no
 * use to a founder holding a phone. This is the same scan, textable: send *audit* and get back
 * what is actually wrong with the last few thousand replies the coach sent real clients.
 *
 * The point is to end the pattern where defects are found one at a time by reading
 * screenshots. Numbers here are counts of real replies — nothing is estimated or sampled.
 */

import { desc, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { chatHistory } from "../../shared/schema";
import { summarise, scanReply } from "./reply-defects";
import { guardStatsLine } from "../malformed-guard";
import { assessJobs, jobHealthLines } from "../job-health";
import { replyPathLines } from "../self-check";
import { provenanceStatsLine } from "../verifiers/response-gate";
import { jobSnapshots, schedulerStartedAt } from "../scheduler/shared";

/** Plain-language name for each detector, so the report reads like coaching, not like a log. */
const LABELS: Record<string, string> = {
  "invented-food": "Logged a food the client never said",
  "meal-offered-after-logging": "Offered a meal they had just logged",
  "protein-contradiction": "Said protein was done AND still owing",
  "removal-nonsequitur": "Answered a deletion nobody asked for",
  "menu-dump": "Sent the whole help menu instead of an answer",
  "therapy-speak-to-reaction": "Answered a one-word reaction with feelings-talk",
  "train-after-session": "Told them to train after they said they trained",
  "capability-lie": "Claimed it cannot read photos",
  "dead-promise": "Promised a follow-up that never comes",
  "duplicate-claim": "Printed the same claim twice",
  "food-not-in-database": "Food missing from the database (coach handled it correctly)",
  "wall-of-text": "Sent a wall of text with no line breaks",
  "listicle": "Answered with a numbered list instead of coaching",
  "generic-advice": "Advice that would fit any client — nothing about them",
};

export async function replyAuditCommand(message: string, _user?: unknown): Promise<string> {
  const asked = parseInt((message.match(/(\d{2,5})/) || [])[1] || "2000", 10);
  const limit = Math.max(100, Math.min(20000, asked));

  const rows = await db
    .select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
    .from(chatHistory)
    .where(isNotNull(chatHistory.messageOut))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);

  const turns = rows
    .filter(r => (r.messageOut || "").trim() && !/^\s*\[/.test(r.messageOut || ""))
    .map(r => ({ messageIn: r.messageIn || "", messageOut: r.messageOut || "", intent: r.intent }));

  if (turns.length === 0) return "No replies found to audit yet.";

  const s = summarise(turns);
  const pct = ((s.defects / s.scanned) * 100).toFixed(1);

  // TREND (2026-07-27): the founder ran this and saw 55 protein contradictions — all from
  // BEFORE the fix shipped that afternoon. A single lifetime number can't show whether a fix
  // worked, so the newest slice is reported separately. Rows arrive newest-first.
  const recent = turns.slice(0, Math.min(200, turns.length));
  const rs = summarise(recent);
  const recentPct = rs.scanned ? ((rs.defects / rs.scanned) * 100).toFixed(1) : "0.0";
  // WHICH defects are still happening, not just how many (2026-07-29). The lifetime breakdown
  // said 43 of 56 defects were one class — but the code that caused it was fixed on 27 July, so
  // most of those were dead history. Reporting a total without naming the live classes sends you
  // to fix a ghost. A defect that appears lifetime but NOT here is already dead; leave it alone.
  const recentLines = rs.byCode.length
    ? `\n${rs.byCode.map(r => `  • *${r.count}×* ${LABELS[r.code] || r.code}`).join("\n")}`
    : `\n  ✅ None of the known patterns — every lifetime defect is history.`;
  const trend = `\n\n📈 *Last ${rs.scanned} replies:* ${rs.defects} defective (${recentPct}%) — vs ${pct}% lifetime.${recentLines}\n\n_Only the list directly above is still happening. Anything in the lifetime list but not here is already fixed._`;

  // Don't invite a wider scan once every stored reply has been read.
  const hitCeiling = turns.length < limit;
  const wider = hitCeiling
    ? `\n\nThat's every reply on record — nothing further back to scan.`
    : `\n\nSend *audit ${Math.min(20000, limit * 2)}* to scan wider.`;

  // The scheduler block rides along: the founder asks "is it working" once, not three times, and
  // an overdue job is invisible until a client says the messages stopped (2026-07-28 review).
  // Computed BEFORE the clean-replies early return — a quiet audit is exactly when a stalled
  // job is the only bad news there is.
  const snaps = jobSnapshots();
  const jobs = jobHealthLines(assessJobs(snaps, Date.now(), Date.now() - schedulerStartedAt), snaps.length);

  if (s.byCode.length === 0) {
    return `🔍 *Reply audit*\n\nScanned *${s.scanned}* real replies.\n\n✅ No defects detected.\n\nThat means none of the ${Object.keys(LABELS).length} known failure patterns appear. It does not mean the coach is perfect — it means these specific bugs are not recurring.\n\n${guardStatsLine()}\n\n${await replyPathLines()}\n\n${provenanceStatsLine()}\n\n${jobs}`;
  }

  const lines = s.byCode.map(r => {
    const label = LABELS[r.code] || r.code;
    return `*${r.count}×* ${label}`;
  }).join("\n");

  // Show a LIVE example, not a fossil. The lifetime worst class can be one that was fixed weeks
  // ago, and pasting its example under a "worst one" heading sends someone hunting a bug that no
  // longer exists — which is exactly what happened on 27 July and again today. Recent first.
  const worst = rs.byCode[0] || s.byCode[0];
  const ex = worst.examples[0];
  const stillLive = !!rs.byCode[0];
  const example = ex
    ? `\n\n*${stillLive ? "Still happening" : "Worst on record (not seen recently)"} — ${LABELS[worst.code] || worst.code}:*\nThey said: _"${ex.in || "(nothing)"}"_\nCoach said: _"${ex.out.replace(/\n/g, " ").slice(0, 160)}"_`
    : "";

  return `🔍 *Reply audit*\n\nScanned *${s.scanned}* real replies — *${s.defects}* carry a defect (${pct}%).\n\n${lines}${trend}${example}\n\n${guardStatsLine()}\n\n${await replyPathLines()}\n\n${provenanceStatsLine()}\n\n${jobs}${wider}`;
}

/**
 * TESTER TRUTH (CTO, 7 Oct). What testers actually received, measured every day with no model call:
 * each delivered reply (turn_ledger) is run through the same defect scanner as *audit*, and
 * attributed to the handler that produced it (decision.source, the tag the turn already records).
 * The founder gets the day's numbers and the five worst replies at 07:00; the aggregate-only
 * version (no client words) is what docs/TESTER-TRUTH.md is built from.
 */
export type TruthTurn = { id: string; at: Date; userId: string; phone3: string; input: string; reply: string; source: string };
export type TruthReport = {
  scanned: number; defects: number;
  byDetector: Array<{ code: string; label: string; count: number }>;
  bySource: Array<{ source: string; replies: number; share: number; defects: number }>;
  worst: Array<TruthTurn & { why: string[] }>;
};
export function testerTruth(turns: TruthTurn[], since: Date, signalWorst: Array<{ id: string; why: string[] }> = []): TruthReport {
  const byDetector = new Map<string, number>(), bySource = new Map<string, { replies: number; defects: number }>();
  const flagged: Array<TruthTurn & { why: string[] }> = [];
  let defects = 0;
  for (const t of turns) {
    const hits = scanReply({ messageIn: t.input, messageOut: t.reply });
    const src = bySource.get(t.source) ?? { replies: 0, defects: 0 };
    src.replies++;
    if (hits.length) { defects++; src.defects++; for (const h of hits) byDetector.set(h.code, (byDetector.get(h.code) ?? 0) + 1); }
    bySource.set(t.source, src);
    if (hits.length && t.at >= since) flagged.push({ ...t, why: hits.map(h => LABELS[h.code] || h.code) });
  }
  // The worst five: defective replies first (most defects, newest), then the turns the client
  // reacted badly to (D7's signals), so a bad reply no detector names still shows.
  flagged.sort((a, b) => b.why.length - a.why.length || b.at.getTime() - a.at.getTime());
  const byId = new Map(turns.map(t => [t.id, t]));
  for (const s of signalWorst) {
    if (flagged.length >= 5) break;
    const t = byId.get(s.id);
    if (t && t.at >= since && !flagged.some(f => f.id === t.id)) flagged.push({ ...t, why: s.why });
  }
  const total = turns.length || 1;
  return {
    scanned: turns.length, defects,
    byDetector: [...byDetector].map(([code, count]) => ({ code, label: LABELS[code] || code, count })).sort((a, b) => b.count - a.count),
    bySource: [...bySource].map(([source, v]) => ({ source, replies: v.replies, share: Math.round(v.replies / total * 100), defects: v.defects })).sort((a, b) => b.replies - a.replies),
    worst: flagged.slice(0, 5),
  };
}

const clip = (t: string, n: number) => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
/** The founder's 07:00 message: today's numbers, the handlers, and the five worst replies quoted (last 3 digits only). */
export function truthDigest(r: TruthReport): string {
  const pct = r.scanned ? Math.round(r.defects / r.scanned * 100) : 0;
  const head = `🔍 *Tester truth, last 24h:* ${r.scanned} replies, ${r.defects} with a known defect (${pct}%).`;
  const handlers = r.bySource.slice(0, 6).map(s => `• ${s.source}: ${s.share}% of replies${s.defects ? `, ${s.defects} defective` : ""}`).join("\n");
  const kinds = r.byDetector.slice(0, 5).map(d => `• ${d.count}× ${d.label}`).join("\n");
  const worst = r.worst.map((t, i) => `${i + 1}. …${t.phone3} · ${t.source} · ${t.why.join(", ")}\n   Them: «${clip(t.input, 90)}»\n   Coach: «${clip(t.reply, 160)}»`).join("\n\n");
  return [head, handlers && `*Who answered:*\n${handlers}`, kinds && `*Defects:*\n${kinds}`, worst ? `*Worst ${r.worst.length}:*\n${worst}` : "*Worst:* nothing flagged."].filter(Boolean).join("\n\n");
}
/** The same report with no client words and no numbers that identify anyone: what docs/TESTER-TRUTH.md holds. */
export function truthMarkdown(r: TruthReport, days: number, at = new Date()): string {
  const pct = r.scanned ? (r.defects / r.scanned * 100).toFixed(1) : "0.0";
  return [`# Tester truth: the last ${days} days`, `Generated ${at.toISOString().slice(0, 16).replace("T", " ")} UTC from turn_ledger. ${r.scanned} delivered replies, ${r.defects} with a known defect (${pct}%).`,
    "## Who answered (handler → share of replies)", "| Handler | Share | Replies | Defective |", "|---|---|---|---|",
    ...r.bySource.map(s => `| ${s.source} | ${s.share}% | ${s.replies} | ${s.defects} |`),
    "## Defects by detector", "| Detector | Count |", "|---|---|", ...r.byDetector.map(d => `| ${d.label} | ${d.count} |`)].join("\n");
}

/** Delivered replies since `days` ago, with the handler that produced each. */
export async function loadTruthTurns(days: number, now = Date.now()): Promise<TruthTurn[]> {
  const { sql } = await import("drizzle-orm");
  const r = await db.execute(sql`SELECT t.id::text id, t.created_at at, t.user_id::text u, right(u.phone_number, 3) p3, coalesce(t.input_text, '') i,
      coalesce(t.delivered_body, t.reply) b, coalesce(t.decision->>'source', 'unknown') s
    FROM turn_ledger t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.created_at >= ${new Date(now - days * 86_400_000)} AND coalesce(t.delivered_body, t.reply) IS NOT NULL`);
  return (r.rows as any[]).map(x => ({ id: x.id, at: new Date(x.at), userId: x.u, phone3: x.p3 || "???", input: x.i, reply: String(x.b), source: x.s }));
}

/** Media failures grouped by step and error, newest error text kept: "3× photo_vision: The model `gpt-4o` does not exist…". */
export function mediaFailures(rows: Array<{ stage: string; detail: string }>): string {
  const by = new Map<string, number>();
  for (const r of rows) { const k = `${r.stage.replace(/^\[MEDIA_FAIL:|\]$/g, "")}: ${(r.detail.split(" err=")[1] || r.detail).slice(0, 140)}`; by.set(k, (by.get(k) ?? 0) + 1); }
  return by.size ? `📸 *Media failures, last 24h:* ${rows.length}\n${[...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `• ${n}× ${k}`).join("\n")}` : "";
}

/** The 07:00 send: today's truth plus who went quiet after a reply, to the founder's ops number. */
export async function sendTesterTruth(now = Date.now()): Promise<boolean> {
  const turns = await loadTruthTurns(1, now);
  const { scoreLiveTurns } = await import("../friction");
  const { isMemoryGrievance } = await import("../understanding/actions");
  const signals = (await db.execute((await import("drizzle-orm")).sql`SELECT user_id::text u, created_at at, kind FROM quality_signals
      WHERE created_at >= ${new Date(now - 86_400_000)} AND kind LIKE 'friction_%' AND user_id IS NOT NULL`)).rows as any[];
  const scored = scoreLiveTurns(turns.map(t => ({ id: t.id, userId: t.userId, at: t.at, input: t.input, reply: t.reply })),
    signals.map(s => ({ userId: String(s.u), at: new Date(s.at), kind: String(s.kind) })), isMemoryGrievance, now);
  const { adminEvents } = await import("../../shared/schema");
  await db.insert(adminEvents).values({ action: "tester_truth", meta: { turns: turns.length }, reason: "turn triage" }).catch(() => {}); // a read of client turns is audited
  // #596: what broke on photos and voice notes, with the stored error, so a live failure is seen the next morning.
  const media = (await db.execute((await import("drizzle-orm")).sql`SELECT message_in s, message_out o FROM chat_history
      WHERE intent = 'MEDIA_FAILURE' AND created_at >= ${new Date(now - 86_400_000)} ORDER BY created_at DESC LIMIT 50`)).rows as any[];
  const failures = mediaFailures(media.map(m => ({ stage: String(m.s), detail: String(m.o) })));
  const text = `${truthDigest(testerTruth(turns, new Date(now - 86_400_000), scored))}${failures ? `\n\n${failures}` : ""}\n\n${await (await import("./engagement-command")).engagementCommand()}`;
  return (await import("../scheduler/jobs/balance-check")).alertOps(text);
}
