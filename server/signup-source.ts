/**
 * SIGN-UP SOURCE / QR ATTRIBUTION (2026-07-22, Kam: "QR codes — like that government
 * app. Simpler to share.")
 *
 * A join-QR is just a wa.me deep link wrapped in an image. The prefilled first message
 * can carry a SOURCE TAG (ref: gymA) so that when the client scans and sends, we know
 * exactly where they came from — a gym poster, an Instagram bio, a printed flyer. That
 * turns every QR into free acquisition attribution: which channel brings signups, and
 * (joined with cost-tracking) which brings whales vs cheap-to-serve clients.
 *
 * Pure string helpers — no DB, no network. Unit-tested in script/unit-tests.ts.
 */

// The default WhatsApp number people message. Digits only, for wa.me.
export function joinNumberDigits(): string {
  return (process.env.TWILIO_WHATSAPP_NUMBER || "").replace(/^whatsapp:/i, "").replace(/\D/g, "");
}

// Tags are lowercased, kept to [a-z0-9_-], and capped — a poster tag must be predictable
// and safe to store/aggregate. "Gym A!!" → "gym-a".
export function sanitiseSourceTag(raw: string | null | undefined): string {
  return (raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

// Extract a source tag from an inbound message. Recognises the forms a prefilled QR can
// carry — "(ref: gymA)", "ref:gymA", "src:gymA", "(code: gymA)", "join gymA" — so whatever
// convention ends up on a poster still lands. Returns null when there's no tag.
export function parseSignupSource(text: string | null | undefined): string | null {
  const s = text || "";
  const m =
    s.match(/\b(?:ref|src|source|code|via)\s*[:=]\s*([a-z0-9_-]{1,24})/i) ||
    s.match(/\((?:ref|src|source|code|via)\s*[:=]?\s*([a-z0-9_-]{1,24})\)/i) ||
    // Bare "join <x>" only counts with an explicit connector, so "join KamLife" / "join now"
    // (ordinary first messages) never become a phantom source tag.
    s.match(/\bjoin(?:ing)?\s+(?:via|from|with)\s+([a-z0-9][a-z0-9_-]{1,23})\b/i);
  if (!m) return null;
  const tag = sanitiseSourceTag(m[1]);
  return tag.length >= 2 ? tag : null;
}

// Remove the source token from a message so downstream onboarding/parsing never sees it.
export function stripSignupSource(text: string | null | undefined): string {
  return (text || "")
    .replace(/\(?\b(?:ref|src|source|code|via)\s*[:=]?\s*[a-z0-9_-]{1,24}\)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The friendly prefilled first message a scanned QR sends. The tag rides in a form the
// parser above recognises but that still reads naturally to the client.
export function buildJoinPrefill(sourceTag?: string | null): string {
  const base = "Hi! I'd like to start with KamLife Coach 💪";
  const tag = sanitiseSourceTag(sourceTag);
  return tag ? `${base} (ref: ${tag})` : base;
}

// The wa.me deep link a QR encodes. Falls back to a bare link if the number env is unset.
export function buildJoinLink(sourceTag?: string | null): string {
  const digits = joinNumberDigits();
  const prefill = encodeURIComponent(buildJoinPrefill(sourceTag));
  return digits ? `https://wa.me/${digits}?text=${prefill}` : `https://wa.me/?text=${prefill}`;
}
