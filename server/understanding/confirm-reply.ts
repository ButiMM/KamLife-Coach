/**
 * CONFIRM-REPLY classifier — pure, dependency-free, unit-tested.
 *
 * A confirmation reply is ONLY a clean yes or a clean no — the WHOLE message is the word.
 * "Not 2 viennas but half a vienna" is NEITHER: it's a fresh correction and must flow on to
 * normal understanding, never silently cancel or mis-fire the parked action (2026-07-23 live:
 * the "yes/no" confirm loop never closed). Kept out of live.ts so tests import it without the
 * engine's heavy module graph.
 */
export function classifyConfirmReply(message: string): "yes" | "no" | "other" {
  const t = (message || "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (/^(yes|yep|yeah|yah|yup|ya|yebo|ja|sure|ok|okay|correct|do it|log it|please do|go ahead|👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|✅)$/.test(t)) return "yes";
  if (/^(no|nope|nah|cancel|leave it|skip|skip it|forget it|never mind|nevermind|nvm|don'?t|stop)$/.test(t)) return "no";
  return "other";
}
