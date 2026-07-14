/**
 * VIDEO PATH VERIFICATION — box three of the stabilization contract.
 *
 * The 38-second form video failed SILENTLY in production (2026-07-12, Bonolo).
 * The never-silent guarantee now catches empty replies, but the processing
 * itself was never verified for real durations. This script builds REAL video
 * files (ffmpeg-static testsrc — the same binary production uses) at 10s, 30s
 * and 60s, runs them through the REAL extractVideoFrames, and asserts:
 *
 *   - every duration yields frames (the model has something to look at)
 *   - frames spread across the WHOLE clip, not just the first seconds
 *     (verified by burnt-in timestamps? no — by frame count vs fps math)
 *   - extraction finishes inside the handler's async budget
 *   - a corrupt buffer and an empty buffer return [] (graceful fallback path)
 *     rather than throwing
 *
 * Also asserts the media handler's fallback strings exist for every failure
 * branch (download fail, oversize, zero frames, model fail) — the reply-side
 * of "never silence".
 *
 * Offline: no Twilio, no OpenAI — this drills the frame pipeline, which is the
 * part that broke. Run: npm run test:video
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import crypto from "crypto";
import ffmpegPath from "ffmpeg-static";

const execFileP = promisify(execFile);
const { extractVideoFrames } = await import("../server/video-frames");

let failures = 0;
function fail(what: string): void { failures++; console.error(`✗ ${what}`); }
function ok(what: string): void { console.log(`✓ ${what}`); }

// ── Reply-side first (needs no binary): every failure branch in the video
//    handler must have a non-empty fallback string — "never silence" at source ──
const mediaSrc = await readFile(new URL("../server/handlers/media.ts", import.meta.url), "utf8");
const requiredFallbacks: Array<[string, RegExp]> = [
  ["workout-save fallback", /I couldn'?t pick out the exercises from that video/],
  ["workout-save oversize", /That clip'?s a bit large/],
  ["form-check fallback", /couldn'?t read it clearly/],
  ["form-check oversize", /That clip'?s a bit big/],
  ["form-check ack", /checking your form/],
  ["workout-save ack", /breaking down every exercise/],
];
for (const [name, re] of requiredFallbacks) {
  if (re.test(mediaSrc)) ok(`media handler carries the ${name} reply`);
  else fail(`media handler is missing the ${name} reply — a failure branch can go silent`);
}

// ── Binary presence — a build assertion. ffmpeg-static's postinstall can fail
//    while the import still resolves; production would degrade every video to
//    the fallback forever. CI is strict; sandboxes without release-download
//    network skip the extraction half loudly. ──
const binaryPresent = !!ffmpegPath && existsSync(ffmpegPath);
const strict = process.env.CI === "true" || process.env.VIDEO_VERIFY_STRICT === "1";
if (!binaryPresent) {
  if (strict) {
    fail("ffmpeg binary MISSING from this build — the entire video path is dead (postinstall failed?)");
    console.error(`\nvideo-path-verify: FAILED (${failures})`);
    process.exit(1);
  }
  if (failures > 0) { console.error(`\nvideo-path-verify: FAILED (${failures})`); process.exit(1); }
  console.warn("\nvideo-path-verify: ffmpeg binary not present in this sandbox — extraction half SKIPPED (CI runs it strictly). Reply-side checks passed.");
  process.exit(0);
}

async function makeTestClip(seconds: number): Promise<ArrayBuffer> {
  const out = join(tmpdir(), `vtest_${crypto.randomUUID()}.mp4`);
  try {
    await execFileP(ffmpegPath as string, [
      "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=320x240:rate=12`,
      "-pix_fmt", "yuv420p", "-y", out,
    ], { timeout: 60_000 });
    const buf = await readFile(out);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    unlink(out).catch(() => {});
  }
}

// ── Real durations through the real extractor (form-check uses 6 frames,
//    workout-save uses 8 — verify both budgets at every duration) ──
for (const seconds of [10, 30, 60]) {
  const clip = await makeTestClip(seconds);
  for (const maxFrames of [6, 8]) {
    const t0 = Date.now();
    const frames = await extractVideoFrames(clip, "mp4", maxFrames);
    const ms = Date.now() - t0;
    if (frames.length === 0) {
      fail(`${seconds}s clip (maxFrames=${maxFrames}): ZERO frames — this is the silent-failure class`);
      continue;
    }
    // The fps math targets ~maxFrames spread across the whole clip; at least
    // half of the budget must materialise or the model sees only the start.
    if (frames.length < Math.min(maxFrames, Math.max(3, Math.floor(maxFrames / 2)))) {
      fail(`${seconds}s clip (maxFrames=${maxFrames}): only ${frames.length} frames — coverage too thin`);
      continue;
    }
    // Every frame must be a real JPEG the vision model will accept.
    const badJpeg = frames.find(b => !Buffer.from(b, "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
    if (badJpeg !== undefined) { fail(`${seconds}s clip: non-JPEG frame in output`); continue; }
    if (ms > 45_000) { fail(`${seconds}s clip took ${ms}ms — beyond any reasonable async budget`); continue; }
    ok(`${seconds}s clip (maxFrames=${maxFrames}) → ${frames.length} frames in ${ms}ms`);
  }
}

// ── Garbage in → graceful [] out, never a throw ──
try {
  const junk = await extractVideoFrames(new Uint8Array([1, 2, 3, 4, 5]).buffer, "mp4", 6);
  if (junk.length !== 0) fail(`corrupt buffer should yield 0 frames, got ${junk.length}`);
  else ok("corrupt buffer → [] (graceful fallback path)");
} catch (e: any) {
  fail(`corrupt buffer THREW (${e?.message}) — media handler expects [] degradation`);
}
try {
  const empty = await extractVideoFrames(new ArrayBuffer(0), "mp4", 6);
  if (empty.length !== 0) fail(`empty buffer should yield 0 frames, got ${empty.length}`);
  else ok("empty buffer → [] (graceful fallback path)");
} catch (e: any) {
  fail(`empty buffer THREW (${e?.message})`);
}

if (failures > 0) {
  console.error(`\nvideo-path-verify: FAILED (${failures})`);
  process.exit(1);
}
console.log("\nvideo-path-verify: 10s/30s/60s clips all produce frames; garbage degrades gracefully; every failure branch has a reply");
process.exit(0);
