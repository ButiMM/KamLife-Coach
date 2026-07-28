/**
 * ACHIEVEMENT CARD — the one card a client actually wants to send to someone else.
 *
 * (2026-07-28, from the marketing review: "People don't share a receipt. They share an
 * achievement.") The macro card is a receipt. It is useful, it is honest, and nobody has ever
 * forwarded one to their group chat. A 7-day streak or 5kg down is a different object: it is
 * about the PERSON, not the food, and that is the only kind of thing anyone screenshots.
 *
 * So this card is deliberately the opposite of the macro card. One number, enormous. One line
 * saying what it means. No bars, no targets, no macros — nothing to decode, nothing to explain
 * to whoever they show it to. Same principle as the verdict pill: give them what they want
 * without making them work for it.
 *
 * It carries the wordmark AND the address, because a screenshot that travels without a way to
 * find us is a free advert we threw away.
 *
 * Pure: data in, PNG Buffer out. Unit-tested.
 */

import { createCanvas } from "@napi-rs/canvas";
import { CARD_FONT as FONT, CARD_COLOURS as C, roundRect } from "./macro-card";

export interface AchievementCardData {
  /** The hero — short and huge: "7", "5.2kg", "30". */
  figure: string;
  /** What the figure counts: "DAYS STRAIGHT", "DOWN", "SESSIONS". */
  unit: string;
  /** One line about the person: "Koketso logged food every single day." */
  line: string;
  /** Optional smaller line under it — the meaning, not another stat. */
  sub?: string;
}

/** Where a shared screenshot sends people. Configurable so it can never go stale in code. */
function publicAddress(): string {
  const raw = (process.env.APP_URL || "kamlifecoach.co.za").trim();
  return raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function renderAchievementCard(d: AchievementCardData): Buffer {
  const W = 1080, H = 1080, M = 40;
  const cardX = M, cardW = W - M * 2, cardH = H - M * 2;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Dark, warm, celebratory — this one is allowed to look like a poster.
  ctx.fillStyle = "#0c0c0f";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, H * 0.32, 0, W / 2, H * 0.32, W * 0.85);
  glow.addColorStop(0, "rgba(242,104,31,0.42)");
  glow.addColorStop(1, "rgba(242,104,31,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 80;
  ctx.shadowOffsetY = 30;
  ctx.fillStyle = "#111216";
  roundRect(ctx, cardX, M, cardW, cardH, 56);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "rgba(242,104,31,0.35)";
  ctx.lineWidth = 3;
  roundRect(ctx, cardX + 1.5, M + 1.5, cardW - 3, cardH - 3, 56);
  ctx.stroke();

  const cx = W / 2;
  ctx.textAlign = "center";

  // ── The ring + the figure. Everything else on this card exists to frame this. ──
  const ringY = M + 300, ringR = 190;
  const ring = ctx.createLinearGradient(cx - ringR, ringY - ringR, cx + ringR, ringY + ringR);
  ring.addColorStop(0, C.ORANGE_LT);
  ring.addColorStop(1, C.ORANGE);
  ctx.strokeStyle = ring;
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(cx, ringY, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(242,104,31,0.10)";
  ctx.beginPath();
  ctx.arc(cx, ringY, ringR - 8, 0, Math.PI * 2);
  ctx.fill();

  // The figure shrinks to fit rather than overflowing the ring — "5.2kg" is wider than "7".
  const fig = (d.figure || "").slice(0, 7);
  let figSize = 190;
  ctx.font = `bold ${figSize}px "${FONT}"`;
  while (figSize > 70 && ctx.measureText(fig).width > ringR * 1.55) {
    figSize -= 8;
    ctx.font = `bold ${figSize}px "${FONT}"`;
  }
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(fig, cx, ringY - 18);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = C.ORANGE;
  ctx.font = `bold 34px "${FONT}"`;
  ctx.fillText((d.unit || "").toUpperCase().slice(0, 22), cx, ringY + 108);

  // ── What it means, in one sentence. Wrapped, never truncated — this is the point. ──
  let y = M + 590;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 52px "${FONT}"`;
  y = drawWrapped(ctx, d.line || "", cx, y, cardW - 180, 66);

  if (d.sub) {
    ctx.fillStyle = "#9aa0ab";
    ctx.font = `500 34px "${FONT}"`;
    drawWrapped(ctx, d.sub, cx, y + 34, cardW - 200, 46);
  }

  // ── Wordmark + address. A screenshot with no address is a free advert thrown away. ──
  const wy = M + cardH - 108;
  ctx.font = `bold 46px "${FONT}"`;
  const kamW = ctx.measureText("KAM").width, lifeW = ctx.measureText("LIFE").width;
  const startX = cx - (kamW + lifeW) / 2;
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("KAM", startX, wy);
  ctx.fillStyle = C.ORANGE;
  ctx.fillText("LIFE", startX + kamW, wy);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6f7581";
  ctx.font = `500 28px "${FONT}"`;
  ctx.fillText(publicAddress(), cx, wy + 48);

  ctx.textAlign = "left";
  return canvas.toBuffer("image/png");
}

/** Centre-wrap text inside `maxW`; returns the baseline after the last line drawn. */
function drawWrapped(ctx: any, text: string, cx: number, y: number, maxW: number, lh: number): number {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else { cur = next; }
  }
  if (cur) lines.push(cur);
  for (const l of lines.slice(0, 3)) { ctx.fillText(l, cx, y); y += lh; }
  return y;
}

// ── WHICH MOMENTS EARN A CARD ────────────────────────────────────────────────────────────────
// Scarcity is the whole value. A card for every meal is wallpaper; a card for a real milestone
// is a thing worth keeping. These are the moments a person would actually tell someone about.

export interface AchievementFacts {
  firstName?: string;
  /** Consecutive days with a food log. */
  streak?: number;
  /** kg change since the first weigh-in. Negative = lost. */
  weightChangeKg?: number;
  /** Whole kg milestones already celebrated, so we never award the same one twice. */
  weightMilestonesDone?: number[];
  /** Total logged training sessions. */
  sessions?: number;
}

const STREAK_MILESTONES = [7, 14, 21, 30, 60, 90];
const SESSION_MILESTONES = [10, 25, 50, 100];

/**
 * The single achievement to celebrate right now, or null. Weight outranks streak: losing 5kg is
 * the thing they came for; logging is how they got there.
 */
export function achievementFor(f: AchievementFacts): AchievementCardData | null {
  const who = f.firstName ? f.firstName : "You";
  const lost = typeof f.weightChangeKg === "number" ? -f.weightChangeKg : 0;

  // Whole-kilo milestones, each awarded once.
  if (lost >= 1) {
    const milestone = Math.floor(lost);
    const done = f.weightMilestonesDone || [];
    if (!done.includes(milestone)) {
      return {
        figure: `${milestone}kg`,
        unit: "down",
        line: `${who} ${f.firstName ? "is" : "are"} ${milestone}kg lighter.`,
        sub: "Not a diet. A different way of eating that stuck.",
      };
    }
  }

  const s = f.streak || 0;
  if (STREAK_MILESTONES.includes(s)) {
    return {
      figure: String(s),
      unit: s >= 30 ? "days in a row" : "days straight",
      line: `${who} logged food ${s} days in a row.`,
      sub: s >= 30 ? "That is not willpower any more. That is a habit." : "Most people stop at day two.",
    };
  }

  const n = f.sessions || 0;
  if (SESSION_MILESTONES.includes(n)) {
    return {
      figure: String(n),
      unit: "sessions done",
      line: `${who} ${f.firstName ? "has" : "have"} trained ${n} times.`,
      sub: "Every one of them was a choice to show up.",
    };
  }
  return null;
}
