/**
 * JOIN-QR RENDERER — the shareable "scan to start" card (2026-07-22, Kam: QR codes like
 * the government app, with the explanation of what it is + the code to join).
 *
 * Draws a branded, print-ready PNG: what KamLife is (plain, StoryBrand — no jargon), the
 * QR that opens WhatsApp with the coach's number and a prefilled join message, and a small
 * source label so Kam can tell his posters/flyers/IG apart. Same native-canvas pipeline as
 * the macro card (no headless browser), so it renders in milliseconds on any host.
 *
 * The QR encodes a wa.me deep link carrying a source tag (see signup-source.ts) — so every
 * scan is also acquisition attribution.
 */

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "fs";
import { join } from "path";
import qrcode from "qrcode-generator";
import { buildJoinLink, sanitiseSourceTag } from "./signup-source";
import { PRICING } from "../shared/pricing";

const FONT = "KamLife Sans";
let fontReady = false;
(() => {
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
      fontReady = true;
      break;
    } catch { /* try next; never crash */ }
  }
})();

const ORANGE = "#f2681f";
const INK = "#14151a";
const MUTED = "#6b7280";
const PAPER = "#ffffff";
const SOFT = "#fff3ec"; // warm tint behind the QR frame

// The QR module grid for a string, as a boolean matrix (true = dark). Error-correction M
// gives a good scan/robustness balance and tolerates a bit of print smudge.
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const grid: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    grid.push(row);
  }
  return grid;
}

// Draw the QR into a square of `box` px at (ox, oy). Modules are snapped to integers so the
// code stays crisp (blurred modules fail to scan). A white quiet-zone border is included.
export function drawQr(ctx: SKRSContext2D, text: string, ox: number, oy: number, box: number): void {
  const grid = qrMatrix(text);
  const n = grid.length;
  const quiet = 4; // modules of quiet zone each side (spec minimum)
  const cells = n + quiet * 2;
  const cell = Math.floor(box / cells);
  const drawn = cell * cells;
  const pad = Math.floor((box - drawn) / 2);
  // White field (quiet zone).
  ctx.fillStyle = PAPER;
  ctx.fillRect(ox + pad, oy + pad, drawn, drawn);
  ctx.fillStyle = INK;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) {
        ctx.fillRect(ox + pad + (c + quiet) * cell, oy + pad + (r + quiet) * cell, cell, cell);
      }
    }
  }
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

export interface JoinCardOpts {
  sourceTag?: string | null; // gym / flyer / ig — labelled small on the card, encoded in the QR
  link?: string;             // override the encoded link (defaults to the wa.me join link)
  priceLabel?: string;       // e.g. "R199/month" — pulled from pricing by the caller
}

// The standalone QR as a PNG (no card chrome) — for embedding elsewhere.
export function renderQrPng(text: string, size = 600): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, size, size);
  drawQr(ctx, text, 0, 0, size);
  return canvas.toBuffer("image/png");
}

// The full branded join card.
export function renderJoinCard(opts: JoinCardOpts = {}): Buffer {
  const W = 1080, H = 1350;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const tag = sanitiseSourceTag(opts.sourceTag);
  const link = opts.link || buildJoinLink(tag);
  // Per-day framing hits harder than the monthly for a mass market — derived from pricing,
  // never hardcoded. ceil(199/30) = "less than R7 a day".
  const price = opts.priceLabel || `less than R${Math.ceil(PRICING.monthlyPriceZAR / 30)} a day`;

  // Background.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  // Orange top band.
  ctx.fillStyle = ORANGE;
  ctx.fillRect(0, 0, W, 200);

  // Brand badge "K" + wordmark in the band.
  ctx.fillStyle = PAPER;
  roundRect(ctx, 80, 58, 84, 84, 22); ctx.fill();
  ctx.fillStyle = ORANGE;
  ctx.font = `bold 54px "${FONT}"`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("K", 122, 102);
  ctx.fillStyle = PAPER;
  ctx.textAlign = "left";
  ctx.font = `bold 52px "${FONT}"`;
  ctx.fillText("KamLife Coach", 190, 90);
  ctx.font = `28px "${FONT}"`;
  ctx.fillText("The coach in your pocket · WhatsApp", 192, 132);

  // Headline — lead with the DESIRE in the customer's own words, then the accountability hook
  // ("for real this time" = the thing they've always been missing). Outcome, not the tool.
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.font = `bold 74px "${FONT}"`;
  ctx.fillText("Lose the weight.", W / 2, 302);
  ctx.fillStyle = ORANGE;
  ctx.font = `bold 74px "${FONT}"`;
  ctx.fillText("For real this time.", W / 2, 380);

  // Three benefit lines — each ties the OUTCOME (burn fat / finish) to the coach, first-person.
  ctx.textAlign = "left";
  ctx.font = `34px "${FONT}"`;
  const benefits = [
    "Snap your food — I keep you burning fat",
    "Workouts for your life — home, gym or travel",
    "I check in every day, so you actually finish",
  ];
  let by = 470;
  for (const b of benefits) {
    ctx.fillStyle = ORANGE;
    ctx.beginPath(); ctx.arc(150, by - 10, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = INK;
    ctx.fillText(b, 180, by);
    by += 66;
  }

  // QR frame (warm tint card + white QR). Kept compact so the caption + footer clear it.
  const frameW = 452, frameX = (W - frameW) / 2, frameY = 690;
  const frameH = frameW + 34;
  ctx.fillStyle = SOFT;
  roundRect(ctx, frameX, frameY, frameW, frameH, 40); ctx.fill();
  drawQr(ctx, link, frameX + 26, frameY + 26, frameW - 52);

  // Scan caption, below the frame.
  const capY = frameY + frameH + 58;
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.font = `bold 42px "${FONT}"`;
  ctx.fillText("Scan to meet your coach", W / 2, capY);
  ctx.fillStyle = MUTED;
  ctx.font = `29px "${FONT}"`;
  ctx.fillText(`Opens in WhatsApp · ${price}`, W / 2, capY + 46);

  // Footer row — guarantee left, source label right (source is for Kam's own tracking).
  ctx.fillStyle = ORANGE;
  ctx.textAlign = "left";
  ctx.font = `bold 26px "${FONT}"`;
  ctx.fillText("7-day money-back guarantee", 40, H - 34);
  if (tag) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.font = `22px "${FONT}"`;
    ctx.fillText(`ref: ${tag}`, W - 40, H - 34);
  }

  return canvas.toBuffer("image/png");
}

export const joinQrFontReady = () => fontReady;
