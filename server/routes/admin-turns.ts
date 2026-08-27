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

export const COACH_HEALTH_RULES: HealthRule[] = [
  {
    id: "plate-ask-routing",
    label: "Plate-ask reached the meal-plan owner",
    layer: "Claim", fixRef: "#86",
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
    expected: "kg to go, and the goal weight",
    asks: i => /\bhow far (?:am i|are we) (?:from|to)\b/i.test(i) && /\b(goal|target)\b/i.test(i),
    failed: t => !/\bto (?:go|gain)\b|at your goal weight/i.test(t.reply),
  },
  {
    id: "meal-for-calories-claim",
    label: "Meal request answered with a calorie readout",
    layer: "Claim", fixRef: "#81",
    expected: "a meal, not the day's totals",
    asks: i => /\b(?:give|send|show|suggest|recommend)\s+(?:me\s+)?(?:a|an|another|the)?\s*meal\b/i.test(i),
    failed: t => !/Next Meal Suggestion/i.test(t.reply) && /kcal\b.*\bleft\b|\d+\s*\/\s*\d+\s*kcal/i.test(t.reply),
  },
  {
    id: "step-raise-no-move",
    label: "Step raise ended in a receipt, no next move",
    layer: "Coaching", fixRef: "#84",
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

export function registerAdminTurns(app: Express) {
  // ── COACH HEALTH ────────────────────────────────────────────────────────────────────────────
  // Rule-based, no model, no new telemetry: it reads the turns the ledger already holds.
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
        // ASKED vs FAILED, both reported. A rule with 0 failures and 0 asks is untested in
        // production, which is a different statement from "this failure is not happening".
        const asked = rows.filter(r => rule.asks(String(r.inputText || ""))).length;
        return {
          id: rule.id, label: rule.label, layer: rule.layer, fixRef: rule.fixRef,
          expected: rule.expected,
          occurrences: hits.length,
          clients: new Set(hits.map(h => h.userId)).size,
          asked,
          examples: hits.slice(0, 5).map(h => ({
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
        unresolved: clusters.filter(c => c.occurrences > 0).length,
        clusters,
        cannotSurface: CANNOT_SURFACE,
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
