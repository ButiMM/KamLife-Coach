/**
 * ADMIN — JOIN QR GENERATOR + ACQUISITION ATTRIBUTION (2026-07-22, Kam: "QR codes, like
 * the government app — the explanation of what it is, and the code to join.")
 *
 *   • /admin/qr           — a page where Kam types a source tag (gym, flyer, ig) and gets a
 *                           print-ready branded join card to download, plus a live breakdown
 *                           of which tags have actually brought clients in.
 *   • /admin/qr.png?ref=  — the branded card PNG (add &plain=1 for a bare QR). Public by
 *                           design — the join link it encodes is meant to be shared.
 *   • /api/admin/sources  — signups grouped by source tag (dashboard-key protected).
 *
 * The QR encodes a wa.me deep link with the source tag baked in (see signup-source.ts), so
 * every scan is captured as attribution on the new client's record.
 */

import type { Express } from "express";
import { db } from "../db";
import { users } from "../../shared/schema";
import { sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";
import { renderJoinCard, renderQrPng } from "../join-qr";
import { buildJoinLink, sanitiseSourceTag } from "../signup-source";

export function registerAdminQr(app: Express) {
  // ── The join card / QR image (public marketing asset) ──
  app.get("/admin/qr.png", (req, res) => {
    try {
      const tag = sanitiseSourceTag(String(req.query.ref || ""));
      const plain = String(req.query.plain || "") === "1";
      const png = plain ? renderQrPng(buildJoinLink(tag), 720) : renderJoinCard({ sourceTag: tag });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="kamlife-join${tag ? "-" + tag : ""}.png"`);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.end(png);
    } catch (err) {
      console.error("[ADMIN_QR_PNG]", err);
      res.status(500).send("QR render failed");
    }
  });

  // ── Signups grouped by acquisition source (dashboard-key protected) ──
  app.get("/api/admin/sources", requireAdminKey, async (_req, res) => {
    try {
      const rows = await db.select({
        src: users.signupSource,
        total: sql<number>`COUNT(*)::int`,
        active: sql<number>`COUNT(*) FILTER (WHERE ${users.subscriptionStatus} = 'active')::int`,
      }).from(users).groupBy(users.signupSource);
      const mapped = rows.map(r => ({ source: r.src || "(direct / untagged)", total: Number(r.total), active: Number(r.active) }))
        .sort((a, b) => b.total - a.total);
      res.json({ sources: mapped });
    } catch (err) {
      console.error("[ADMIN_SOURCES]", err);
      res.status(500).json({ message: "Failed to load sources" });
    }
  });

  // ── The generator page ──
  app.get("/admin/qr", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>KamLife — Join QR</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root{--bg:#0b0d10;--fg:#e8e8e8;--muted:#8a8f98;--card:#14171c;--row:#1a1e25;--line:#22262c;--accent:#f2681f;--green:#31d0aa}
  *{box-sizing:border-box}body{background:var(--bg);color:var(--fg);margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  a{color:var(--accent);text-decoration:none}.back{color:var(--muted)}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
  .wrap{max-width:900px;margin:0 auto;padding:20px 16px 60px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:720px){.wrap{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
  label{display:block;color:var(--muted);font-size:12px;margin:0 0 6px}
  input{width:100%;background:var(--row);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:10px 12px;font:inherit}
  .hint{color:var(--muted);font-size:12px;margin-top:8px}
  .btns{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
  .btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font:inherit;font-weight:600}
  .btn.ghost{background:transparent;color:var(--muted);border:1px solid #2a2f37}
  .preview{text-align:center}.preview img{max-width:100%;border-radius:10px;border:1px solid var(--line);background:#fff}
  .link{word-break:break-all;color:var(--muted);font-size:12px;margin-top:10px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  th,td{text-align:right;padding:8px 10px;border-bottom:1px solid #1d2026;font-variant-numeric:tabular-nums}
  th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .empty{color:var(--muted);padding:16px;text-align:center}
</style></head>
<body>
<header><a class="back" href="/admin/triage">← Triage</a><h1>📲 Join QR — make a poster, track the source</h1></header>
<div class="wrap">
  <div class="card">
    <h2>Make a code</h2>
    <label for="tag">Source tag (where you'll put it)</label>
    <input id="tag" placeholder="e.g. gym-sandton, flyer1, instagram" autocomplete="off" />
    <div class="hint">Lowercase letters, numbers, dashes. Each tag tells you where a client came from. Leave blank for a plain join code.</div>
    <div class="btns">
      <button class="btn" id="make">Generate</button>
      <a class="btn ghost" id="dl" download>Download PNG</a>
      <a class="btn ghost" id="dlplain" download>Plain QR only</a>
    </div>
    <div class="link" id="link"></div>
  </div>
  <div class="card preview"><h2>Preview</h2><img id="img" alt="Join card preview" /></div>
  <div class="card" style="grid-column:1/-1">
    <h2>Where clients are coming from</h2>
    <div id="sources"><div class="empty">Loading…</div></div>
  </div>
</div>
<script>
(function(){
  var KEY="kamlife-dashboard-key";
  function getKey(){var k=sessionStorage.getItem(KEY);if(!k){k=prompt("Dashboard key:");if(k)sessionStorage.setItem(KEY,k);}return k;}
  function esc(s){return String(s==null?"":s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
  function clean(t){return (t||"").toLowerCase().trim().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24);}
  var tag=document.getElementById("tag"),img=document.getElementById("img"),dl=document.getElementById("dl"),dlp=document.getElementById("dlplain"),linkEl=document.getElementById("link");
  function build(){
    var t=clean(tag.value);var q=t?("?ref="+encodeURIComponent(t)):"";
    var url="/admin/qr.png"+q+(q?"&":"?")+"_t="+Date.now();
    img.src=url;
    dl.href="/admin/qr.png"+q;dl.setAttribute("download","kamlife-join"+(t?"-"+t:"")+".png");
    dlp.href="/admin/qr.png"+(q?q+"&plain=1":"?plain=1");dlp.setAttribute("download","kamlife-qr"+(t?"-"+t:"")+".png");
    linkEl.textContent="Tag: "+(t||"(none)");
  }
  document.getElementById("make").onclick=build;
  tag.addEventListener("keydown",function(e){if(e.key==="Enter")build();});
  async function loadSources(){
    var box=document.getElementById("sources");var key=getKey();if(!key){box.innerHTML='<div class="empty">No key.</div>';return;}
    try{
      var r=await fetch("/api/admin/sources",{headers:{"x-dashboard-key":key}});
      if(r.status===401){sessionStorage.removeItem(KEY);box.innerHTML='<div class="empty">Unauthorized — refresh.</div>';return;}
      if(!r.ok){box.innerHTML='<div class="empty">HTTP '+r.status+'</div>';return;}
      var d=await r.json();var m=d.sources||[];
      if(!m.length){box.innerHTML='<div class="empty">No signups yet.</div>';return;}
      var h='<table><thead><tr><th>Source</th><th>Signups</th><th>Active</th></tr></thead><tbody>';
      m.forEach(function(s){h+='<tr><td>'+esc(s.source)+'</td><td>'+s.total+'</td><td>'+s.active+'</td></tr>';});
      box.innerHTML=h+'</tbody></table>';
    }catch(e){box.innerHTML='<div class="empty">Error: '+esc(e.message||e)+'</div>';}
  }
  build();loadSources();
})();
</script>
</body></html>`);
  });
}
