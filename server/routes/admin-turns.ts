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

export function registerAdminTurns(app: Express) {
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
