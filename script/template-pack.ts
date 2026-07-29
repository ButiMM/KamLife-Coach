/**
 * TEMPLATE PACK — everything Meta needs, in submission order, ready to paste.
 *
 * (2026-07-29, founder: "I want to get approval this week.")
 *
 * Meta reviews each WhatsApp template by hand and a rejection costs a day. Four templates
 * submitted badly is four days; four submitted correctly is usually one. This prints each one
 * exactly as it must be entered in the Twilio Content Template Builder — name, category,
 * language, body, and the sample values Meta demands — and refuses to print a pack that would
 * be rejected for a mechanical reason.
 *
 * It also reports which approved SIDs are already in the environment, so "am I done?" is one
 * command rather than a hunt through Railway.
 *
 * Run: npx tsx script/template-pack.ts
 */

import { TEMPLATES, validateTemplate, templateSid, unwiredTemplates } from "../server/whatsapp-templates";

const BAR = "═".repeat(74);
const LANGUAGE = "en"; // South African English submits as "en" — en_ZA is not a Meta locale.

const bad = TEMPLATES.map(t => ({ t, problems: validateTemplate(t) })).filter(r => r.problems.length > 0);
if (bad.length > 0) {
  console.error("✗ This pack would be REJECTED. Fix these before submitting:\n");
  for (const { t, problems } of bad) {
    console.error(`  ${t.name}`);
    for (const p of problems) console.error(`    • ${p}`);
  }
  process.exit(1);
}

console.log(`\n${BAR}`);
console.log("WHATSAPP TEMPLATE SUBMISSION PACK");
console.log("Twilio Console → Messaging → Content Template Builder → Create new");
console.log(`Language for every one of these: ${LANGUAGE}`);
console.log(BAR);

TEMPLATES.forEach((t, i) => {
  const sid = templateSid(t.name);
  console.log(`\n${"─".repeat(74)}`);
  console.log(`[${i + 1}/${TEMPLATES.length}] ${t.name}   ${sid ? `✅ APPROVED (${sid})` : "⬜ not submitted"}`);
  console.log(`${"─".repeat(74)}`);
  console.log(`Unblocks: ${t.unblocks}\n`);
  console.log(`Template name:  ${t.name}`);
  console.log(`Category:       ${t.category}${t.category === "MARKETING" ? "   ← clients can mute MARKETING; this one is worth it anyway" : ""}`);
  console.log(`Language:       ${LANGUAGE}`);
  console.log(`Content type:   Text`);
  // NOT indented. An indented body looks tidier here and arrives at Meta with leading spaces
  // on every line — which validateTemplate itself rejects. Delimiters instead of padding.
  console.log(`\nBody — copy everything between the lines, exactly:`);
  console.log("┌" + "─".repeat(72));
  console.log(t.body);
  console.log("└" + "─".repeat(72));
  if (t.footer) console.log(`\nFooter: ${t.footer}`);
  if (t.samples.length === 0) {
    console.log(`\nNo variables — nothing to sample. (Deliberate: this one is sent from a code`);
    console.log(`path that knows only a phone number.)`);
  } else {
    console.log(`\nSample values Meta asks for:`);
    t.samples.forEach((s, k) => console.log(`  {{${k + 1}}} = ${s}   — ${t.vars[k]}`));
  }
  console.log(`\nWhen approved, copy the HX… SID into Railway as:  ${t.env}`);
});

const missing = unwiredTemplates();
console.log(`\n${BAR}`);
if (missing.length === 0) {
  console.log(`✅ All ${TEMPLATES.length} templates approved and wired.`);
  console.log("Proactive messages can now reach clients who have been quiet for over 24 hours.");
} else {
  console.log(`${TEMPLATES.length - missing.length} of ${TEMPLATES.length} wired. Still needed in Railway:`);
  for (const t of missing) console.log(`  ⬜ ${t.env}   (${t.name})`);
  console.log(`\nUntil these are set, every proactive message to a client who has been quiet`);
  console.log(`for over 24 hours is rejected by WhatsApp and reaches nobody.`);
}
console.log(`${BAR}\n`);
