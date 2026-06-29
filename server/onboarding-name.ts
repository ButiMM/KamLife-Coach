// Parse a first name out of a free-text onboarding reply. Returns the cleaned name, or
// null if it isn't a usable name (a command, pure filler, too long, contains digits, etc.).
// Pulls the name out of natural phrasings — "my name is Thabo" / "I'm Thabo" / "call me
// Sipho" — so a beginner who answers in a sentence is captured, not bounced for being >3
// words or stored literally as "I'm Thabo". The \b anchors and "i\s+am" (not "iam") keep
// real names like "Liam Smith" from being mis-extracted.
const NAME_COMMANDS = new Set(["RESET", "START", "RESTART", "MENU", "HELP", "DONE", "YES", "NO", "OK", "OKAY", "HI", "HEY", "HELLO", "HOWZIT", "HOLA", "YO", "SUP", "EITA", "SAWUBONA", "YEBO", "STOP", "CANCEL"]);
const NAME_FILLER = new Set(["my", "name", "names", "is", "i", "im", "am", "it", "its", "this", "the", "a", "an", "call", "me", "they", "so", "well", "yeah", "just"]);

export function parseFirstName(msg: string): string | null {
  let raw = msg.trim();
  const intro = raw.match(/\b(?:my name'?s|my name is|i\s+am|i'?m|it'?s|this is|they call me|call me)\s+([a-zA-Z][a-zA-Z''-]{1,19})\b/i);
  if (intro) raw = intro[1];
  const words = raw.split(/\s+/).filter(Boolean);
  const allFiller = words.length > 0 && words.every((w) => NAME_FILLER.has(w.toLowerCase().replace(/['’.]/g, "")));
  if (!raw || raw.length < 2 || raw.length > 20 || words.length > 3 || /[^a-zA-Z\s''-]/.test(raw) || allFiller || NAME_COMMANDS.has(raw.toUpperCase())) {
    return null;
  }
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
