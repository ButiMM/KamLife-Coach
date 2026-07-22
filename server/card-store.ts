/**
 * CARD STORE — a tiny in-memory hold for freshly-rendered macro-card PNGs.
 *
 * WhatsApp/Twilio fetches a media message by URL, so a generated card must live at a public
 * URL for the moment between "we send the reply" and "Twilio fetches the image". We don't
 * need durable storage — the app serves the bytes from here via GET /card/:token.png, then
 * they age out. Bounded (size + TTL) so it can never leak memory. Single-process — the same
 * app that renders also serves, so no external store is needed.
 */

import type { Express } from "express";

interface Entry { png: Buffer; at: number }

const store = new Map<string, Entry>();
const TTL_MS = 15 * 60_000; // Twilio fetches within seconds; 15 min is a generous safety margin
const MAX = 400;            // ~400 × ~80KB ≈ 32MB ceiling; evict oldest beyond this

export function putCard(png: Buffer): string {
  const token = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  store.set(token, { png, at: Date.now() });
  if (store.size > MAX) {
    let oldestKey: string | null = null, oldestAt = Infinity;
    for (const [k, v] of store) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) store.delete(oldestKey);
  }
  return token;
}

export function getCard(token: string): Buffer | null {
  const e = store.get(token);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(token); return null; }
  return e.png;
}

/** Public route Twilio fetches to load a meal-log card as a WhatsApp media message. */
export function registerCardRoute(app: Express): void {
  app.get("/card/:file", (req, res) => {
    const png = getCard(String(req.params.file || "").replace(/\.png$/i, ""));
    if (!png) return res.status(404).end();
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=900");
    return res.end(png);
  });
}
