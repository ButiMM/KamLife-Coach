/**
 * MACRO CARD RENDERER — the crisp, branded image the bot sends on a meal log.
 *
 * (2026-07-21, founder: the marketing promises the graphic — "those orange things, protein,
 * carbs, fats" — so the real log must deliver it.) WhatsApp has no card UI, so we draw the
 * card to a PNG server-side and send it as a media message (the same channel the exercise
 * GIFs already use). No headless browser — a lightweight native canvas draws it in a few
 * milliseconds. Everything is drawn as SHAPES (bars, tick, avatar) so it never depends on a
 * colour-emoji font being present on the host.
 *
 * Pure: data in, PNG Buffer out. Rendered goal-aware by the caller (macro goals only; wellness
 * clients keep their plain, no-numbers reply).
 */

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "fs";
import { join } from "path";

// BUNDLE THE FONT (2026-07-22): the Railway container has NO system fonts — the first live
// card came out with shapes but no text. Liberation Sans (OFL-licensed) is committed under
// server/assets and registered here at load, so text renders on ANY host. Family name is
// unique so it can only resolve via this registration, never a coincidental system font.
const FONT = "KamLife Sans";
/** True once the bundled font is registered — surfaced by the `version` command so the
 *  coach can confirm on the LIVE server that cards will have text, not take it on faith. */
export let cardFontLoaded = false;
(() => {
  // Try several roots so it resolves whichever way the process is started (repo-root cwd,
  // or the bundled file under dist/). typeof guard: __dirname is undefined under ESM/tsx.
  const dirs = [join(process.cwd(), "server", "assets")];
  if (typeof __dirname !== "undefined") {
    dirs.push(join(__dirname, "..", "server", "assets"), join(__dirname, "server", "assets"));
  }
  for (const dir of dirs) {
    try {
      const reg = join(dir, "LiberationSans-Regular.ttf");
      if (!existsSync(reg)) continue;
      GlobalFonts.registerFromPath(reg, FONT);
      const bold = join(dir, "LiberationSans-Bold.ttf");
      if (existsSync(bold)) GlobalFonts.registerFromPath(bold, FONT);
      cardFontLoaded = true;
      break;
    } catch { /* try the next candidate; never crash the render */ }
  }
})();
const ORANGE = "#f2681f";
const ORANGE_LT = "#ff8a3d";
const INK = "#14151a";
const MUTED = "#8a8f9a";
const TRACK = "#eef0f2";
const GREEN = "#22b04b";
const GREEN_LT = "#3ccb63";
const RED = "#e0533a";
const RED_LT = "#ff7a5c";

/**
 * Word-wrap to at most `maxLines`, ellipsing only if even that overflows.
 *
 * (2026-07-29.) The next-move band clipped its text to ONE line: every client whose instruction
 * ran long read "Make your next meal a proper protein m…". That band is the largest type on the
 * card and carries the only thing the client is asked to do — truncating it mid-word is the
 * product failing at the exact point it is supposed to be clearest. A second line costs 44px.
 *
 * Takes a `measure` function rather than a canvas context so it is pure and unit-testable.
 */
export function wrapLines(measure: (s: string) => number, text: string, maxW: number, maxLines: number): string[] {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > maxW) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  // Everything fitted — done.
  const consumed = lines.join(" ");
  if (consumed.replace(/\s+/g, " ") === words.join(" ")) return lines;

  // It did not fit in maxLines. Ellipsis on the LAST line only, so the client still reads the
  // start of the instruction rather than a cut-off word with no terminator.
  let last = lines[lines.length - 1] || "";
  while (last.length > 1 && measure(`${last}…`) > maxW) last = last.slice(0, -1);
  lines[lines.length - 1] = last.replace(/[\s,–-]+$/, "") + "…";
  return lines;
}

export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Shared with the achievement card so both speak the same visual language. */
export const CARD_FONT = FONT;
export const CARD_COLOURS = { ORANGE, ORANGE_LT, INK, MUTED, GREEN };

export function renderWelcomeCard(opts: { name?: string; tagline?: string } = {}): Buffer {
  const W = 1080, H = 720, M = 40, cardX = M, cardW = W - M * 2, cardH = H - M * 2;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0c0c0f"; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 80, 0, W / 2, 80, W * 0.9);
  glow.addColorStop(0, "rgba(242,104,31,0.30)"); glow.addColorStop(1, "rgba(242,104,31,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 70; ctx.shadowOffsetY = 28;
  ctx.fillStyle = "#ffffff"; roundRect(ctx, cardX, M, cardW, cardH, 52); ctx.fill();
  ctx.restore();

  // Big avatar badge — the K, in a fitness-orange gradient ring with a subtle "dumbbell" accent.
  const cx = W / 2, avY = M + 120, av = 200;
  const ring = ctx.createLinearGradient(cx - av / 2, avY, cx + av / 2, avY + av);
  ring.addColorStop(0, ORANGE_LT); ring.addColorStop(1, ORANGE);
  ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(cx, avY + av / 2, av / 2, 0, Math.PI * 2); ctx.fill();
  // subtle inner highlight
  ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.beginPath(); ctx.arc(cx, avY + av / 2 - 18, av / 2 - 26, Math.PI, 0); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = `bold 120px "${FONT}"`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("K", cx, avY + av / 2 + 6);

  ctx.fillStyle = INK; ctx.font = `bold 62px "${FONT}"`;
  ctx.fillText(opts.name || "Coach K", cx, avY + av + 78);
  ctx.fillStyle = MUTED; ctx.font = `500 34px "${FONT}"`;
  ctx.fillText(opts.tagline || "Your fitness coach — right here on WhatsApp", cx, avY + av + 138);

  // KamLife wordmark, centered near the bottom.
  ctx.font = `bold 40px "${FONT}"`;
  const kamW = ctx.measureText("KAM").width, lifeW = ctx.measureText("LIFE").width;
  const startX = cx - (kamW + lifeW) / 2, wy = M + cardH - 56;
  ctx.textAlign = "left"; ctx.fillStyle = INK; ctx.fillText("KAM", startX, wy);
  ctx.fillStyle = ORANGE; ctx.fillText("LIFE", startX + kamW, wy);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  return canvas.toBuffer("image/png");
}

// ── WEEKLY / MONTHLY REPORT CARD (2026-07-22, founder: "a weekly and a monthly scorecard — the
// monthly is the shareable overall report card, accurate macros, everything for the month, without
// overwhelming, plus a small coaching line"). Same premium visual language as the meal card, but a
// SUMMARY: a grid of a few big stat tiles, not a wall of numbers. Pure: data in, PNG out. ──
export interface ReportStat { label: string; value: string; sub?: string; tone?: "good" | "warn" | "normal" }
export interface ReportCardData {
  title: string;       // "Koketso's month"
  subtitle?: string;   // period, e.g. "1–31 July" — shown under Coach K
  pill?: string;       // e.g. "31 days"
  stats: ReportStat[]; // 4–6 tiles — keep it uncluttered
  hint?: string;       // one short coaching line
}

export function renderReportCard(d: ReportCardData): Buffer {
  const W = 1080, M = 40, cardX = M, cardW = W - M * 2, P = 60, innerW = cardW - P * 2;
  const headerH = 118, titleH = 96, footerH = 108;
  const cols = 2, gap = 22, tileH = 148;
  const rows = Math.ceil(d.stats.length / cols);
  const tilesH = rows * tileH + (rows - 1) * gap;
  const cardH = P + headerH + titleH + tilesH + 30 + footerH + P - 20;
  const H = cardH + M * 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0c0c0f"; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -60, 0, W / 2, -60, W * 0.95);
  glow.addColorStop(0, "rgba(242,104,31,0.24)"); glow.addColorStop(1, "rgba(242,104,31,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 70; ctx.shadowOffsetY = 28;
  ctx.fillStyle = "#ffffff"; roundRect(ctx, cardX, M, cardW, cardH, 52); ctx.fill();
  ctx.restore();

  const x = cardX + P;
  let y = M + P;
  // Header: avatar + Coach K + period
  const av = 96;
  const ag = ctx.createLinearGradient(x, y, x + av, y + av);
  ag.addColorStop(0, ORANGE_LT); ag.addColorStop(1, ORANGE);
  ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(x + av / 2, y + av / 2, av / 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = `bold 50px "${FONT}"`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("K", x + av / 2, y + av / 2 + 3);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const tx = x + av + 30;
  ctx.fillStyle = INK; ctx.font = `bold 44px "${FONT}"`; ctx.fillText("Coach K", tx, y + 44);
  ctx.fillStyle = MUTED; ctx.font = `600 30px "${FONT}"`; ctx.fillText(d.subtitle || "Your report", tx, y + 88);
  y += headerH;

  // Title + pill
  ctx.fillStyle = INK; ctx.font = `700 44px "${FONT}"`;
  const pillTxt = (d.pill || "").trim();
  let pillW = 0; if (pillTxt) { ctx.font = `bold 30px "${FONT}"`; pillW = ctx.measureText(pillTxt).width + 52; }
  const titleMaxW = innerW - (pillTxt ? pillW + 26 : 0);
  ctx.font = `700 44px "${FONT}"`;
  let t = d.title || "";
  if (ctx.measureText(t).width > titleMaxW) { while (t.length > 1 && ctx.measureText(t + "…").width > titleMaxW) t = t.slice(0, -1); t = t.replace(/\s+$/, "") + "…"; }
  ctx.fillText(t, x, y + 44);
  if (pillTxt) {
    const pillX = x + innerW - pillW, pillH = 58;
    ctx.font = `bold 30px "${FONT}"`; ctx.fillStyle = "rgba(242,104,31,0.10)";
    roundRect(ctx, pillX, y + 8, pillW, pillH, pillH / 2); ctx.fill();
    ctx.fillStyle = ORANGE; ctx.textAlign = "center"; ctx.fillText(pillTxt, pillX + pillW / 2, y + 8 + pillH / 2 + 10); ctx.textAlign = "left";
  }
  y += titleH;

  // Stat tiles
  const tileW = (innerW - gap) / cols;
  d.stats.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const tx0 = x + col * (tileW + gap), ty0 = y + row * (tileH + gap);
    ctx.fillStyle = "#f6f7f9"; roundRect(ctx, tx0, ty0, tileW, tileH, 26); ctx.fill();
    ctx.fillStyle = MUTED; ctx.font = `600 26px "${FONT}"`;
    ctx.fillText((s.label || "").toUpperCase(), tx0 + 28, ty0 + 44);
    ctx.fillStyle = s.tone === "good" ? GREEN : s.tone === "warn" ? ORANGE : INK;
    ctx.font = `bold 52px "${FONT}"`; ctx.fillText(s.value, tx0 + 28, ty0 + 100);
    if (s.sub) { ctx.fillStyle = MUTED; ctx.font = `500 24px "${FONT}"`; ctx.fillText(s.sub, tx0 + 28, ty0 + 132); }
  });
  y += tilesH + 30;

  // Footer
  ctx.strokeStyle = "#eceef1"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + innerW, y); ctx.stroke();
  y += 52;
  ctx.font = `bold 32px "${FONT}"`; ctx.fillStyle = INK; ctx.fillText("KAM", x, y);
  const kamW = ctx.measureText("KAM").width; ctx.fillStyle = ORANGE; ctx.fillText("LIFE", x + kamW, y);
  if (d.hint) {
    ctx.font = `500 27px "${FONT}"`; ctx.fillStyle = MUTED; ctx.textAlign = "right";
    const maxHintW = innerW - kamW - 60; let h = d.hint;
    if (ctx.measureText(h).width > maxHintW) { while (h.length > 1 && ctx.measureText(h + "…").width > maxHintW) h = h.slice(0, -1); h = h.replace(/\s+$/, "") + "…"; }
    ctx.fillText(h, x + innerW, y); ctx.textAlign = "left";
  }
  return canvas.toBuffer("image/png");
}
