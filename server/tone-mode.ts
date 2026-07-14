/**
 * TONE MODE — the second adaptive axis (2026-07-14, Kam: "the tone should be
 * different across the board for every single client").
 *
 * Same durable, migration-free pattern as numbers-mode: a profileNotes token
 * (tone:gentle | tone:direct | tone:hype) that flexes the coaching VOICE per
 * client. Absence = "warm" (the current default — byte-unchanged behaviour).
 *
 * Set when a client clearly signals a preference ("just tell me straight",
 * "be gentle with me", "push me"). The steer is injected into the model brain's
 * system prompt; when tone is "warm" nothing is injected, so the default voice is
 * exactly as before.
 */

export type ToneMode = "warm" | "gentle" | "direct" | "hype";

export function getToneMode(user: any): ToneMode {
  const m = (user?.profileNotes || "").match(/\btone:(gentle|direct|hype)\b/i);
  return m ? (m[1].toLowerCase() as ToneMode) : "warm";
}

// Returns a tone when the client clearly asks for one, else null. Deliberately
// specific phrasing so it never hijacks an ordinary message.
export function detectToneSignal(m: string): Exclude<ToneMode, "warm"> | null {
  const s = m || "";
  if (/\b(just tell me straight|tell it (to me )?straight|no fluff|no sugar.?coat\w*|stop sugar.?coating|get to the point|be blunt|be direct|don.?t sugar.?coat|straight talk|no.?nonsense|keep it real with me|spare me the|cut the fluff)\b/i.test(s)) return "direct";
  if (/\b(hype me( up)?|push me( harder)?|be hard on me|i need (some )?(motivation|a push|tough love)|go hard on me|challenge me|be my drill sergeant|don.?t go easy on me|fire me up)\b/i.test(s)) return "hype";
  // Gentle: only clear requests for a softer voice, or plainly emotional overwhelm —
  // NOT bare "struggling" (that's usually "struggling to find time/afford it", a
  // logistics concern the client wants ANSWERED, not a tone confirmation).
  if (/\b(be gentle( with me)?|go easy on me|be kind( to me)?|take it easy on me|be patient with me|softly softly|don.?t be (too )?(hard|harsh) on me)\b/i.test(s)
      || /\bi.?m (feeling )?(really |so |very )?(anxious|overwhelmed|fragile|discouraged)\b/i.test(s)) return "gentle";
  return null;
}

export function toneSteer(tone: ToneMode): string {
  switch (tone) {
    case "gentle":
      return "TONE FOR THIS CLIENT: they are anxious and easily discouraged — be extra gentle and reassuring. Lead with warmth, celebrate the smallest wins, never apply pressure, no hard pushes. Offer only the smallest next step. Calm the anxiety first.";
    case "direct":
      return "TONE FOR THIS CLIENT: they want it straight — no softening, no preamble, no pep-talk. Give the answer and the one action in as few words as possible. Warm but blunt, zero fluff.";
    case "hype":
      return "TONE FOR THIS CLIENT: they respond to energy — bring intensity, celebrate wins loudly, challenge them to push harder. Still kind, never mean.";
    default:
      return "";
  }
}
