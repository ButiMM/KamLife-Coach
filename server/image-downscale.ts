/**
 * IMAGE DOWNSCALE — one place, before any vision call.
 *
 * (2026-07-28, from the CFO review: a modern phone camera sends a 3000-4000px photo. Vision
 * pricing is per image TILE, so that photo costs several times what a 1024px one costs, and it
 * reads a plate of pap no better. Every rand of that is pure waste at R199/month.)
 *
 * Deliberately placed at the DOWNLOAD, not at each vision call. The reviewers' recurring finding
 * about this codebase was the same rule implemented at one call site and missing at four others;
 * downscaling once, where the bytes arrive, means every downstream reader — food, form check,
 * scale, menu, equipment, physique — gets the cheap image without knowing this module exists.
 *
 * Fail-open in every branch: a decode error, an unsupported format, anything at all returns the
 * ORIGINAL image untouched. A cost optimisation must never be able to break a client's photo.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";

/** 1024px is the point where vision stops charging for extra tiles and still reads a plate. */
export const MAX_EDGE = 1024;

export interface Downscaled {
  b64: string;
  ct: string;
  /** True when we actually shrank it — for the log, so the saving is visible. */
  resized: boolean;
  fromEdge?: number;
  toEdge?: number;
}

/** The scale factor for a given source size, or null when it is already small enough. */
export function scaleFor(width: number, height: number, maxEdge = MAX_EDGE): number | null {
  const longest = Math.max(width || 0, height || 0);
  if (!(longest > maxEdge)) return null;
  return maxEdge / longest;
}

/**
 * Shrink an image so its longest edge is at most MAX_EDGE. Returns JPEG (vision does not care,
 * and JPEG of a photo is a fraction of the PNG). Animated or non-decodable input is passed
 * straight through.
 */
export async function downscaleForVision(b64: string, ct: string, maxEdge = MAX_EDGE): Promise<Downscaled> {
  const original: Downscaled = { b64, ct, resized: false };
  try {
    if (!b64 || /gif|svg/i.test(ct || "")) return original;
    const img = await loadImage(Buffer.from(b64, "base64"));
    const w = (img as any).width || 0, h = (img as any).height || 0;
    const scale = scaleFor(w, h, maxEdge);
    if (!scale) return original;

    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const canvas = createCanvas(nw, nh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img as any, 0, 0, nw, nh);
    const out = canvas.toBuffer("image/jpeg", 82);
    // Guard against the pathological case where the re-encode is somehow bigger.
    if (out.length >= Buffer.byteLength(b64, "base64")) return original;
    return { b64: out.toString("base64"), ct: "image/jpeg", resized: true, fromEdge: Math.max(w, h), toEdge: Math.max(nw, nh) };
  } catch {
    return original;
  }
}
