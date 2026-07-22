/**
 * ADMIN — COMPREHENSIVE CLIENT VIEW (2026-07-22, founder: "when I click a client I need to see
 * everything — their foods, how they talk to the bot, and the struggles they're having. The
 * dashboard is too vague right now.").
 *
 * One page per client, built to be READ like a coach's file, not a data dump:
 *   • who they are + where they're at (goal, targets, streaks, a friction score)
 *   • their STRUGGLES up top — every fight with the bot (corrections, rejections, redirects,
 *     frustration) so a rough patch is obvious at a glance
 *   • their FOOD LOG — what they actually ate, grouped by day
 *   • their CONVERSATION — the real transcript, so the founder hears their voice
 *
 * Read-only. Reuses the same dashboard-key auth as the rest of /admin.
 */

import type { Express } from "express";
import { db } from "../db";
import { users, mealLogs, chatHistory, weightLogs, stepLogs, workoutLogs, qualitySignals, escalations } from "../../shared/schema";
import { eq, and, gte, desc, sql, inArray } from "drizzle-orm";
import { requireAdminKey } from "./auth";
import { getGoalProfile } from "../goal-profiles";
import { FRICTION_SIGNAL_KINDS } from "../friction";

const esc = (s: unknown) => String(s == null ? "" : s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// A meal-log row → a plain "what they ate" string, from the structured items or the raw message.
function foodsOf(row: { items: unknown; rawMessage: string | null }): string {
  if (Array.isArray(row.items)) {
    const names = row.items.map((i: any) => (i && typeof i.name === "string" ? i.name : "")).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  return (row.rawMessage || "").trim() || "—";
}

const sastTime = (d: Date | string | null) => d
  ? new Date(new Date(d).getTime() + 2 * 3_600_000).toISOString().replace("T", " ").slice(5, 16)
  : "";

export function registerAdminClient(app: Express) {
  // ── Comprehensive client payload — profile + struggles + food log + conversation ──
  app.get("/api/admin/client/:id", requireAdminKey, async (req, res) => {
    try {
      const id = req.params.id;
      const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!u) return res.status(404).json({ message: "Client not found" });

      const now = Date.now();
      const d14 = new Date(now - 14 * 86400000);
      const d7 = new Date(now - 7 * 86400000);

      const [meals, chats, frictionRows, w7, workouts7, workoutTotalRow, weightRows, escOpen] = await Promise.all([
        db.select({ loggedAt: mealLogs.loggedAt, label: mealLogs.mealLabel, kcal: mealLogs.kcalInt, protein: mealLogs.proteinInt, items: mealLogs.items, rawMessage: mealLogs.rawMessage })
          .from(mealLogs).where(and(eq(mealLogs.userId, id), gte(mealLogs.loggedAt, d14))).orderBy(desc(mealLogs.loggedAt)).limit(120),
        db.select({ createdAt: chatHistory.createdAt, inMsg: chatHistory.messageIn, outMsg: chatHistory.messageOut, intent: chatHistory.intent })
          .from(chatHistory).where(eq(chatHistory.userId, id)).orderBy(desc(chatHistory.createdAt)).limit(80),
        db.select({ kind: qualitySignals.kind, detail: qualitySignals.detail, messageIn: qualitySignals.messageIn, createdAt: qualitySignals.createdAt })
          .from(qualitySignals).where(and(eq(qualitySignals.userId, id), inArray(qualitySignals.kind, FRICTION_SIGNAL_KINDS), gte(qualitySignals.createdAt, d14)))
          .orderBy(desc(qualitySignals.createdAt)).limit(40),
        db.select({ avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int` }).from(stepLogs).where(and(eq(stepLogs.userId, id), gte(stepLogs.loggedAt, d7))),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(workoutLogs).where(and(eq(workoutLogs.userId, id), gte(workoutLogs.loggedAt, d7))),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(workoutLogs).where(eq(workoutLogs.userId, id)),
        db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(eq(weightLogs.userId, id)).orderBy(desc(weightLogs.loggedAt)).limit(2),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(escalations).where(and(eq(escalations.userId, id), eq(escalations.status, "open"))),
      ]);

      const byKind: Record<string, number> = { correction: 0, rejection: 0, redirect: 0, frustration: 0 };
      for (const r of frictionRows) { const k = r.kind.replace("friction_", ""); if (k in byKind) byKind[k]++; }
      const profile = getGoalProfile(u.goalType);

      res.json({
        profile: {
          id: u.id, name: u.name || "(no name)", phone: u.phoneNumber,
          waLink: `https://wa.me/${String(u.phoneNumber || "").replace(/[^\d]/g, "")}`,
          goal: profile.label, usesMacros: profile.usesMacros,
          calorieTarget: u.calorieTarget, proteinTarget: u.proteinTarget, stepsTarget: u.stepsTarget,
          subscription: u.subscriptionStatus, lastActive: u.lastActiveAt,
          startWeight: u.currentWeight, medical: u.medicalConditions || "",
        },
        struggles: {
          total: frictionRows.length, byKind,
          openEscalations: Number((escOpen[0] as any)?.n || 0),
          recent: frictionRows.slice(0, 12).map(r => ({ kind: r.kind.replace("friction_", ""), when: sastTime(r.createdAt), detail: r.detail || "", msg: r.messageIn || "" })),
        },
        stats: {
          workouts7: Number((workouts7[0] as any)?.n || 0),
          workoutsTotal: Number((workoutTotalRow[0] as any)?.n || 0),
          stepsAvg7: Number((w7[0] as any)?.avg || 0),
          mealsLogged14: meals.length,
          weightLatest: weightRows[0]?.weight ?? null,
          weightPrev: weightRows[1]?.weight ?? null,
        },
        meals: meals.map(m => ({ when: sastTime(m.loggedAt), label: m.label || "", kcal: m.kcal, protein: m.protein, foods: foodsOf(m) })),
        conversation: chats.reverse().map(c => ({ when: sastTime(c.createdAt), inMsg: c.inMsg || "", outMsg: c.outMsg || "", intent: c.intent || "" })),
      });
    } catch (err) {
      console.error("[ADMIN_CLIENT]", err);
      res.status(500).json({ message: "Failed to load client" });
    }
  });

  // ── The client file — an HTML page that reads like a coach's notes ──
  app.get("/admin/client/:id", (req, res) => {
    const id = esc(req.params.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>KamLife — Client</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root{--bg:#0b0d10;--fg:#e8e8e8;--muted:#8a8f98;--card:#14171c;--row:#1a1e25;--line:#22262c;
    --accent:#f2681f;--red:#e5484d;--yellow:#f0a500;--green:#31d0aa;--blue:#4c8dff}
  *{box-sizing:border-box}body{background:var(--bg);color:var(--fg);margin:0;
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  a{color:var(--accent);text-decoration:none}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header .back{color:var(--muted)}
  .wrap{max-width:960px;margin:0 auto;padding:18px 16px 60px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  h1{font-size:20px;margin:0}
  h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
  .who{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start}
  .facts{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;color:var(--muted);font-size:13px}
  .facts b{color:var(--fg);font-weight:600}
  .wa{border:1px solid #2a2f37;border-radius:8px;padding:7px 12px;color:var(--green);white-space:nowrap}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:600;background:var(--row);border:1px solid var(--line)}
  .chip b{font-variant-numeric:tabular-nums}
  .chip.red{color:var(--red)}.chip.yellow{color:var(--yellow)}.chip.green{color:var(--green)}.chip.blue{color:var(--blue)}
  .fr{border-left:2px solid var(--yellow);padding:6px 0 6px 12px;margin:8px 0;color:var(--muted);font-size:13px}
  .fr b{color:var(--fg)}.fr .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--yellow)}
  .day{color:var(--muted);font-size:12px;margin:14px 0 6px;letter-spacing:.04em;text-transform:uppercase}
  .meal{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--row)}
  .meal .f{color:var(--fg)} .meal .m{color:var(--muted);font-size:12px}
  .meal .kv{color:var(--muted);font-size:12.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .turn{margin:14px 0}
  .bubble{border-radius:12px;padding:9px 13px;max-width:82%;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .in{background:#20252d;margin-left:auto;border-bottom-right-radius:3px}
  .out{background:#15181d;border:1px solid var(--line);border-bottom-left-radius:3px}
  .turn .meta{font-size:11px;color:var(--muted);margin:3px 4px}
  .turn.inrow{display:flex;flex-direction:column;align-items:flex-end}
  .intent{font-size:10.5px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:1px 6px;margin-left:6px}
  .empty,.error{color:var(--muted);padding:28px;text-align:center}.error{color:var(--red)}
  button{background:transparent;color:var(--muted);border:1px solid #2a2f37;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
</style></head>
<body>
<header>
  <a class="back" href="/admin/triage">← Triage</a>
  <h1 id="name">Loading…</h1>
  <span style="flex:1"></span>
  <a class="wa" id="wa" target="_blank" rel="noopener" style="display:none">WhatsApp →</a>
  <button id="refresh">refresh</button>
</header>
<div class="wrap" id="content"><div class="empty">Loading…</div></div>
<script>
(function(){
  var ID=${JSON.stringify(id)};
  var KEY="kamlife-dashboard-key";
  function getKey(){var k=sessionStorage.getItem(KEY);if(!k){k=prompt("Dashboard key:");if(k)sessionStorage.setItem(KEY,k);}return k;}
  function esc(s){return String(s==null?"":s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
  var content=document.getElementById("content");
  async function load(){
    var key=getKey();if(!key){content.innerHTML='<div class="error">No key.</div>';return;}
    try{
      var r=await fetch("/api/admin/client/"+encodeURIComponent(ID),{headers:{"x-dashboard-key":key}});
      if(r.status===401){sessionStorage.removeItem(KEY);content.innerHTML='<div class="error">Unauthorized — refresh.</div>';return;}
      if(!r.ok){content.innerHTML='<div class="error">HTTP '+r.status+'</div>';return;}
      render(await r.json());
    }catch(e){content.innerHTML='<div class="error">Error: '+esc(e.message||e)+'</div>';}
  }
  function chip(cls,label,n){return '<span class="chip '+cls+'">'+label+' <b>'+n+'</b></span>';}
  function render(d){
    var p=d.profile,s=d.struggles,st=d.stats;
    document.getElementById("name").textContent=p.name;
    var wa=document.getElementById("wa");wa.href=p.waLink;wa.style.display="";
    var wChange="";
    if(st.weightLatest!=null&&st.weightPrev!=null){var diff=(st.weightLatest-st.weightPrev);wChange=(diff>0?"+":"")+diff.toFixed(1)+"kg";}
    var html="";
    // profile
    html+='<div class="card"><div class="who"><div>'
      +'<div class="facts"><span><b>'+esc(p.goal)+'</b></span>'
      +(p.usesMacros&&p.calorieTarget?'<span><b>'+p.calorieTarget+'</b> kcal</span><span><b>'+p.proteinTarget+'</b>g protein</span>':'<span>habit-led · no macro targets</span>')
      +'<span><b>'+(p.stepsTarget||0)+'</b> steps</span><span>Status: <b>'+esc(p.subscription||"—")+'</b></span></div>'
      +(p.medical?'<div class="facts" style="margin-top:6px;color:var(--yellow)">⚕ '+esc(p.medical)+'</div>':'')
      +'</div></div></div>';
    // struggles
    html+='<div class="card"><h2>Struggles · fighting the bot (14 days)</h2><div class="chips">';
    var totCls=s.total>=4?"red":s.total>=2?"yellow":"green";
    html+=chip(totCls,"Rough moments",s.total);
    html+=chip("blue","Corrections",s.byKind.correction);
    html+=chip("blue","Rejections",s.byKind.rejection);
    html+=chip("blue","Redirects",s.byKind.redirect);
    html+=chip("blue","Frustration",s.byKind.frustration);
    if(s.openEscalations>0)html+=chip("red","Open escalations",s.openEscalations);
    html+='</div>';
    if(s.recent.length){s.recent.forEach(function(f){html+='<div class="fr"><span class="k">'+esc(f.kind)+'</span> · '+esc(f.when)+(f.msg?'<br><b>"'+esc(f.msg)+'"</b>':'')+(f.detail?' <span style="color:var(--muted)">— '+esc(f.detail)+'</span>':'')+'</div>';});}
    else html+='<div class="empty" style="padding:12px">No friction — smooth sailing. 👌</div>';
    html+='</div>';
    // stats
    html+='<div class="card"><h2>Snapshot</h2><div class="chips">'
      +chip("","Workouts 7d",st.workouts7)+chip("","Total sessions",st.workoutsTotal)
      +chip("","Avg steps 7d",st.stepsAvg7.toLocaleString())+chip("","Meals 14d",st.mealsLogged14)
      +(st.weightLatest!=null?chip("","Weight",st.weightLatest+"kg"+(wChange?" ("+wChange+")":"")):"")
      +'</div></div>';
    // food log
    html+='<div class="card"><h2>Food log — what they actually ate</h2>';
    if(d.meals.length){var lastDay="";d.meals.forEach(function(m){var day=m.when.slice(0,5);if(day!==lastDay){html+='<div class="day">'+esc(day)+'</div>';lastDay=day;}html+='<div class="meal"><div><span class="f">'+esc(m.foods)+'</span> '+(m.label?'<span class="m">· '+esc(m.label)+'</span>':'')+'</div><div class="kv">'+m.kcal+' kcal · '+m.protein+'g</div></div>';});}
    else html+='<div class="empty" style="padding:12px">No meals logged in the last 14 days.</div>';
    html+='</div>';
    // conversation
    html+='<div class="card"><h2>Conversation — how they talk to the bot</h2>';
    if(d.conversation.length){d.conversation.forEach(function(t){
      if(t.inMsg)html+='<div class="turn inrow"><div class="bubble in">'+esc(t.inMsg)+'</div><div class="meta">'+esc(t.when)+'</div></div>';
      if(t.outMsg)html+='<div class="turn"><div class="bubble out">'+esc(t.outMsg)+'</div><div class="meta">Coach K'+(t.intent?'<span class="intent">'+esc(t.intent)+'</span>':'')+'</div></div>';
    });}
    else html+='<div class="empty" style="padding:12px">No messages yet.</div>';
    html+='</div>';
    content.innerHTML=html;
  }
  document.getElementById("refresh").onclick=load;
  load();
})();
</script>
</body></html>`);
  });
}
