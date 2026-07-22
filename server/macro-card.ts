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

export interface MacroRow { label: string; current: number; target: number; unit: string }
export interface MacroCardData {
  mealName: string;   // "Pilchards + pap"
  mealKcal: number;   // this meal's calories
  rows: MacroRow[];   // Calories / Protein / Carbs / Fat (each with today's total vs target)
  hint?: string;      // one short line, e.g. "Protein first — you've got this today"
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function renderMacroCard(d: MacroCardData): Buffer {
  const W = 1080;
  const M = 40;                    // dark outer margin
  const cardX = M, cardW = W - M * 2;
  const P = 60;                    // card inner padding
  const headerH = 118;
  const mealH = 104;
  const rowH = 104;
  const footerH = 108;
  const cardH = P + headerH + mealH + d.rows.length * rowH + footerH + P - 20;
  const H = cardH + M * 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Backdrop: near-black with a soft orange glow from the top ──
  ctx.fillStyle = "#0c0c0f";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -60, 0, W / 2, -60, W * 0.95);
  glow.addColorStop(0, "rgba(242,104,31,0.24)");
  glow.addColorStop(1, "rgba(242,104,31,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── White card ──
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 28;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, cardX, M, cardW, cardH, 52);
  ctx.fill();
  ctx.restore();

  const x = cardX + P;
  const innerW = cardW - P * 2;
  let y = M + P;

  // ── Header: avatar + name + "Meal logged" with a drawn tick ──
  const av = 96;
  const ag = ctx.createLinearGradient(x, y, x + av, y + av);
  ag.addColorStop(0, ORANGE_LT);
  ag.addColorStop(1, ORANGE);
  ctx.fillStyle = ag;
  ctx.beginPath();
  ctx.arc(x + av / 2, y + av / 2, av / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold 50px "${FONT}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("K", x + av / 2, y + av / 2 + 3);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const tx = x + av + 30;
  ctx.fillStyle = INK;
  ctx.font = `bold 44px "${FONT}"`;
  ctx.fillText("Coach K", tx, y + 44);
  // drawn tick
  const tickX = tx + 4, tickY = y + 78;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(tickX, tickY);
  ctx.lineTo(tickX + 12, tickY + 12);
  ctx.lineTo(tickX + 32, tickY - 14);
  ctx.stroke();
  ctx.fillStyle = GREEN;
  ctx.font = `bold 30px "${FONT}"`;
  ctx.fillText("Meal logged", tickX + 46, y + 88);

  y += headerH;

  // ── Meal line: name + calorie pill ──
  ctx.fillStyle = INK;
  ctx.font = `600 38px "${FONT}"`;
  ctx.fillText(d.mealName, x, y + 44);
  const kcalTxt = `+${Math.round(d.mealKcal)} cal`;
  ctx.font = `bold 32px "${FONT}"`;
  const pillW = ctx.measureText(kcalTxt).width + 56;
  const pillH = 60;
  const pillX = x + innerW - pillW;
  ctx.fillStyle = "rgba(242,104,31,0.10)";
  roundRect(ctx, pillX, y + 6, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = ORANGE;
  ctx.textAlign = "center";
  ctx.fillText(kcalTxt, pillX + pillW / 2, y + 6 + pillH / 2 + 11);
  ctx.textAlign = "left";

  y += mealH;

  // ── Macro rows: label, value, bar (track + orange fill, rounded) ──
  for (const r of d.rows) {
    const pct = r.target > 0 ? Math.max(0, Math.min(1, r.current / r.target)) : 0;
    ctx.fillStyle = INK;
    ctx.font = `bold 34px "${FONT}"`;
    ctx.fillText(r.label, x, y + 34);

    const valTxt = `${Math.round(r.current)} / ${Math.round(r.target)}${r.unit}`;
    ctx.font = `600 30px "${FONT}"`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(valTxt, x + innerW, y + 34);
    ctx.textAlign = "left";

    const barY = y + 56, barH = 26;
    ctx.fillStyle = TRACK;
    roundRect(ctx, x, barY, innerW, barH, barH / 2);
    ctx.fill();
    if (pct > 0) {
      const fillW = Math.max(barH, innerW * pct);
      const fg = ctx.createLinearGradient(x, 0, x + fillW, 0);
      fg.addColorStop(0, ORANGE);
      fg.addColorStop(1, ORANGE_LT);
      ctx.fillStyle = fg;
      roundRect(ctx, x, barY, fillW, barH, barH / 2);
      ctx.fill();
    }
    y += rowH;
  }

  // ── Footer: divider, KamLife wordmark, hint ──
  y += 6;
  ctx.strokeStyle = "#eceef1";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + innerW, y);
  ctx.stroke();
  y += 52;
  ctx.font = `bold 32px "${FONT}"`;
  ctx.fillStyle = INK;
  ctx.fillText("KAM", x, y);
  const kamW = ctx.measureText("KAM").width;
  ctx.fillStyle = ORANGE;
  ctx.fillText("LIFE", x + kamW, y);
  if (d.hint) {
    ctx.font = `500 27px "${FONT}"`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(d.hint, x + innerW, y);
    ctx.textAlign = "left";
  }

  return canvas.toBuffer("image/png");
}
