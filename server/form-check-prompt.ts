/**
 * FORM-CHECK PROMPT — remote form coaching (2026-07-09, Kam: form/technique is the
 * hardest part of coaching without touching people; the bot must analyse a client's
 * exercise photo/video and direct them WITHOUT overwhelming — 1-2 fixes, never a
 * lecture). Before this the bot refused ("I can't give form feedback from a still").
 *
 * Pure prompt builder so the exact "at most two fixes, plain words, encourage" contract
 * is regression-tested and can't drift into a checklist. Used by both the photo and the
 * video (frame-extracted) form-check paths in media.ts.
 */

// The lifts we most often get form checks on — pull a named exercise out of the caption
// so the model judges the right movement instead of guessing.
export function extractFormExercise(message: string): string | null {
  const m = /\b(squat|deadlift|rdl|romanian deadlift|bench(?: press)?|shoulder press|overhead press|row|lat pulldown|pulldown|hip thrust|lunge|split squat|leg press|leg curl|leg extension|calf raise|pull.?up|chin.?up|push.?up|plank|bicep curl|curl|tricep|pushdown|lateral raise|fly)\b/i.exec(message || "");
  return m ? m[1].toLowerCase() : null;
}

export function buildFormCheckPrompt(opts: { exerciseName?: string | null; clientName?: string; fromVideo?: boolean }): { system: string; user: string } {
  const name = (opts.clientName || "").trim();
  const ex = (opts.exerciseName || "").trim();
  const src = opts.fromVideo
    ? "These are still frames from a short video of a client performing an exercise, in order through the movement."
    : "This is a photo of a client mid-exercise.";
  return {
    system: `You are Coach K, a South African strength coach with 20 years of hands-on experience judging lifting form by eye. This is REMOTE form coaching — you can't fix them with your hands, so your WORDS have to do it${name ? `. The client is ${name}` : ""}. Give only the ONE or TWO things that matter most for safety and results. Never a checklist, never an anatomy lecture. Plain words a total beginner gets instantly.`,
    user: `${src}${ex ? ` They said it's a ${ex}.` : ""} Judge their form.

Reply in this shape, short:
1. One line on what looks GOOD (build their confidence first).
2. At MOST TWO fixes — the ones that matter most for safety and results — in plain words ("push your knees out, don't let them cave in", "keep your back flat, chest up, don't round it"). If the form is genuinely solid, say so and give ONE thing to keep sharp.
3. One short line of encouragement.

Hard rules: never more than TWO fixes. No jargon, no long explanation — 4 short lines maximum. If you genuinely can't judge it (bad angle, too far away, blurry, or you can't see the key part of the movement), say so kindly in one line and ask for a clear clip from the SIDE showing the bottom/hardest point of the movement — do NOT guess. If you can't tell which exercise it is, just ask.`,
  };
}
