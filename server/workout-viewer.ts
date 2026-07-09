/**
 * FRICTIONLESS WORKOUT VIEWER — one link on today's workout opens a swipeable,
 * full-screen page of the exercises: swipe left/right through each move, watch the
 * demo, see the "no machine?" alternative. No wall of text, no message-per-exercise
 * (2026-07-09: the model was hallucinating a DIFFERENT workout when asked to "show
 * the exercises", and dumping broken markdown link soup). This page is server-rendered
 * from getCurrentDayExercises() — the SAME source of truth buildDayWorkout uses — so it
 * can only ever show the exact workout that was prescribed. The model never touches it.
 *
 * Media per card: a real looping GIF once uploaded (getExerciseGifUrl), otherwise a
 * clean "Watch the move" button to the demo video. Swapping video → GIF is a data
 * change (upload + register slug), never a rebuild.
 */
import crypto from "crypto";
import { getCurrentDayExercises, getYoutubeLinkForExercise } from "./programme";
import { getExerciseGifUrl } from "./exercise-media";

export type ViewerCard = {
  name: string;
  sets: string;
  gifUrl: string | null;
  videoUrl: string | null;
  alt: string; // the "no machine / can't do it" alternative, one line
};

// ── Signed token so a viewer link identifies the client without exposing the raw
// user id or requiring a login. Only ever gates workout GIFs/videos (no PII), but a
// signature stops anyone enumerating other clients' plans by guessing ids. Reuses the
// dashboard secret so there is no new secret to provision.
function tokenSecret(): string {
  return process.env.COACH_DASHBOARD_KEY || "";
}

export function signWorkoutToken(userId: string): string | null {
  const secret = tokenSecret();
  if (!secret || !userId) return null;
  const sig = crypto.createHmac("sha256", secret).update(userId).digest("hex").slice(0, 24);
  return `${Buffer.from(userId).toString("base64url")}.${sig}`;
}

export function verifyWorkoutToken(token: string): string | null {
  const secret = tokenSecret();
  if (!secret || !token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  let userId: string;
  try { userId = Buffer.from(b64, "base64url").toString("utf8"); } catch { return null; }
  if (!userId) return null;
  const expected = crypto.createHmac("sha256", secret).update(userId).digest("hex").slice(0, 24);
  // constant-time compare — both hex strings of equal length
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return userId;
}

export function buildWorkoutViewerUrl(userId: string): string | null {
  const token = signWorkoutToken(userId);
  if (!token) return null;
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/w/${token}`;
}

/**
 * Pure: turn the user's real current-day exercises into viewer cards (name, sets, the
 * demo media, the alternative). Returns null for walk-only clients (no exercises to
 * show). No DB, no network — unit-tested so the card shape never silently drifts.
 */
export function buildViewerCards(user: any): { label: string; week: number; cards: ViewerCard[] } | null {
  const day = getCurrentDayExercises(user);
  if (!day || day.exercises.length === 0) return null;
  const cards: ViewerCard[] = day.exercises.map((ex) => ({
    name: ex.name,
    sets: ex.setsDisplay,
    gifUrl: getExerciseGifUrl(ex.name),
    videoUrl: getYoutubeLinkForExercise(ex.name) || null,
    alt: (ex.modification || "").trim(),
  }));
  return { label: day.label, week: user.programmeWeek || 1, cards };
}

function esc(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

/**
 * Self-contained clean swipe page. One full-screen card per exercise, horizontal
 * scroll-snap so it slides. Deliberately minimal text — name, sets, one media action,
 * a small alternative line. No branding clutter, no paragraphs to read.
 */
export function renderWorkoutViewerHtml(
  data: { label: string; week: number; cards: ViewerCard[] },
  firstName: string,
): string {
  const { label, week, cards } = data;
  const cardsHtml = cards.map((c, i) => {
    const media = c.gifUrl
      ? `<img class="gif" src="${esc(c.gifUrl)}" alt="${esc(c.name)} demo" loading="lazy">`
      : c.videoUrl
        ? `<a class="watch" href="${esc(c.videoUrl)}" target="_blank" rel="noopener">▶ Watch the move</a>`
        : `<div class="nomedia">Demo coming soon</div>`;
    const alt = c.alt ? `<div class="alt">No machine? ${esc(c.alt)}</div>` : "";
    return `<section class="card">
      <div class="num">${i + 1} / ${cards.length}</div>
      <h1>${esc(c.name)}</h1>
      <div class="sets">${esc(c.sets)}</div>
      <div class="media">${media}</div>
      ${alt}
    </section>`;
  }).join("");
  const dots = cards.map((_, i) => `<span class="dot${i === 0 ? " on" : ""}" data-i="${i}"></span>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(firstName ? firstName + "'s" : "Your")} workout</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body { background:#0c0d10; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; overflow:hidden; }
  header { position:fixed; top:0; left:0; right:0; z-index:5; padding:14px 18px calc(14px + env(safe-area-inset-top)); text-align:center; font-size:13px; letter-spacing:.04em; text-transform:uppercase; color:#9aa0aa; background:linear-gradient(#0c0d10ee,#0c0d1000); }
  .rail { display:flex; height:100vh; height:100dvh; overflow-x:auto; scroll-snap-type:x mandatory; scrollbar-width:none; }
  .rail::-webkit-scrollbar { display:none; }
  .card { min-width:100vw; height:100dvh; scroll-snap-align:center; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:64px 24px 96px; text-align:center; gap:16px; }
  .num { font-size:13px; color:#6b7280; letter-spacing:.1em; }
  h1 { font-size:30px; line-height:1.15; font-weight:700; max-width:16ch; }
  .sets { font-size:19px; color:#22c55e; font-weight:600; }
  .media { margin:8px 0; width:100%; max-width:420px; display:flex; align-items:center; justify-content:center; }
  .gif { width:100%; border-radius:18px; }
  .watch { display:inline-block; padding:16px 30px; border-radius:999px; background:#22c55e; color:#04140a; font-weight:700; font-size:18px; text-decoration:none; }
  .nomedia { color:#6b7280; font-size:15px; padding:28px; }
  .alt { font-size:14px; color:#9aa0aa; max-width:26ch; }
  footer { position:fixed; bottom:0; left:0; right:0; z-index:5; display:flex; flex-direction:column; align-items:center; gap:10px; padding:16px 0 calc(20px + env(safe-area-inset-bottom)); background:linear-gradient(#0c0d1000,#0c0d10ee); }
  .dots { display:flex; gap:7px; }
  .dot { width:7px; height:7px; border-radius:50%; background:#3a3d44; transition:background .2s,transform .2s; }
  .dot.on { background:#22c55e; transform:scale(1.35); }
  .hint { font-size:12px; color:#6b7280; }
</style>
</head>
<body>
<header>Week ${week} · ${esc(label)}</header>
<div class="rail" id="rail">${cardsHtml}</div>
<footer>
  <div class="dots" id="dots">${dots}</div>
  <div class="hint">swipe →</div>
</footer>
<script>
  var rail = document.getElementById('rail');
  var dots = [].slice.call(document.querySelectorAll('.dot'));
  var hint = document.querySelector('.hint');
  rail.addEventListener('scroll', function () {
    var i = Math.round(rail.scrollLeft / rail.clientWidth);
    dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
    if (hint) hint.style.opacity = i === 0 ? '1' : '0';
  }, { passive: true });
  dots.forEach(function (d) {
    d.addEventListener('click', function () {
      rail.scrollTo({ left: (+d.dataset.i) * rail.clientWidth, behavior: 'smooth' });
    });
  });
</script>
</body>
</html>`;
}
