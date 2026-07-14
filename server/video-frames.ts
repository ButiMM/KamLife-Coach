/**
 * Video frame extraction — pulls still frames from a short clip (e.g. a TikTok/Instagram
 * workout the client downloaded and forwarded over WhatsApp) so they can be sent to a vision
 * model for exercise identification. OpenAI's vision models don't accept video, so we sample
 * frames with ffmpeg first.
 *
 * Uses the ffmpeg-static binary (a self-contained Linux binary that ships with the package and
 * deploys cleanly on Railway). Every failure path returns an empty array so callers degrade
 * gracefully to "send me a screenshot or list the moves" rather than erroring.
 */

import { tmpdir } from "os";
import { existsSync } from "fs";
import { writeFile, unlink, readFile, readdir, mkdir, rm } from "fs/promises";
import { join as pathJoin } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import ffmpegPath from "ffmpeg-static";

const execFileP = promisify(execFile);

// The package resolving is NOT the binary existing — ffmpeg-static downloads the
// binary in a postinstall step that can fail (network, proxy) while the import
// still succeeds. Without this check a broken build would quietly degrade EVERY
// video to the fallback reply forever. Scream once at load so it's in the deploy
// logs, and let extractVideoFrames degrade per-call as before.
export const FFMPEG_AVAILABLE = !!ffmpegPath && existsSync(ffmpegPath);
if (!FFMPEG_AVAILABLE) {
  console.error("[video-frames] ffmpeg binary MISSING from this build — every video will fall back to 'send a screenshot'. Re-run npm install / check the ffmpeg-static postinstall.");
}

/**
 * Extract up to `maxFrames` evenly-spaced JPEG frames from a video buffer.
 * Returns base64-encoded JPEGs (no data: prefix). Empty array on any failure.
 */
export async function extractVideoFrames(
  videoBuffer: ArrayBuffer,
  ext: string,
  maxFrames = 8,
): Promise<string[]> {
  if (!FFMPEG_AVAILABLE || !ffmpegPath) {
    console.warn("[video-frames] ffmpeg binary unavailable — skipping extraction");
    return [];
  }
  const id = crypto.randomUUID();
  const tmpIn = pathJoin(tmpdir(), `vid_${id}.${ext}`);
  const outDir = pathJoin(tmpdir(), `frames_${id}`);
  try {
    await writeFile(tmpIn, Buffer.from(videoBuffer));
    await mkdir(outDir, { recursive: true });

    // Best-effort duration probe so frames spread across the WHOLE clip, not just the start.
    // `ffmpeg -i <file>` with no output exits non-zero by design; the Duration line is on stderr.
    let durationSec = 0;
    try {
      await execFileP(ffmpegPath, ["-i", tmpIn], { timeout: 15000 });
    } catch (probeErr: any) {
      const stderr = String(probeErr?.stderr || "");
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    }

    // fps chosen so we land ~maxFrames evenly across the clip; default to 1 frame / 3s.
    const fps = durationSec > 1 ? Math.min(1, maxFrames / durationSec) : 1 / 3;
    await execFileP(ffmpegPath, [
      "-i", tmpIn,
      "-vf", `fps=${fps.toFixed(4)},scale=512:-1`,
      "-frames:v", String(maxFrames),
      "-q:v", "5",
      pathJoin(outDir, "f_%02d.jpg"),
    ], { timeout: 30000 });

    const files = (await readdir(outDir)).filter(f => f.endsWith(".jpg")).sort();
    const frames: string[] = [];
    for (const f of files.slice(0, maxFrames)) {
      const buf = await readFile(pathJoin(outDir, f));
      if (buf.byteLength > 0) frames.push(buf.toString("base64"));
    }
    console.log(`[video-frames] extracted ${frames.length} frame(s) durationSec=${durationSec.toFixed(1)}`);
    return frames;
  } catch (e) {
    console.warn("[video-frames] extraction failed:", e);
    return [];
  } finally {
    unlink(tmpIn).catch(() => {});
    rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
