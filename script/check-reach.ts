/**
 * REACH GUARD — every path that can talk to a client is declared, or the build fails.
 *
 * (2026-07-30, founder: "We are only finding things as we test.") He is right, and today proves
 * it: eight of eight defects were found by him, in production, on his own phone.
 *
 * Look at what three of those eight actually were:
 *
 *   - humanizeReply, the entire voice enforcement, existed since 22 July and was imported by ONE
 *     file out of forty-two.
 *   - The provenance gate and hygiene were wired into sendWhatsApp, and two commit messages
 *     claimed they covered every outbound message. They covered the 68 cron jobs and none of the
 *     conversation, because replies go out through a different function.
 *   - Then the same mistake again: after "fixing" that, EIGHT files could still reach a client
 *     directly and only two of them were shaped.
 *
 * None of those needed a tester. They needed someone to COUNT. A claim about coverage is checkable
 * and I kept asserting it instead — which is the same defect the provenance gate exists to stop,
 * committed by the builder rather than the coach.
 *
 * So this counts. Every file that can put text in front of a client must be listed below with a
 * reason and a shaping status. A new one appears → red build. That is the difference between
 * finding this class of bug by testing and finding it by building.
 *
 * Run: npx tsx script/check-reach.ts   (wired into `npm test`)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Shaping = "shaped" | "verbatim-by-design" | "not-client-facing";

/**
 * Frozen 2026-07-30. Every file that calls the Twilio message API directly.
 *
 * "shaped" means it passes through the provenance gate (may the coach assert this?) and the
 * hygiene pass (does it read like a coach?). Anything a CLIENT reads as coaching must be shaped.
 */
const SENDERS: Array<{ file: string; shaping: Shaping; why: string }> = [
  {
    file: "server/outbound-delivery.ts", shaping: "shaped",
    why: "deliverTwilioMessage — THE customer transport owner (Cut B2). Every reply and every "
      + "proactive message reaches Twilio through this one function. It does no shaping itself and "
      + "must not: what may be said is decided by prepareOutbound, before the reply is split into "
      + "bubbles, and everything arriving here has already cleared that floor. Listed as shaped "
      + "because that is what a client reads, not because the gates live in this file.",
  },
  {
    file: "server/scheduler/shared.ts", shaping: "shaped",
    why: "sendSMSFallback — the SMS channel, from a different number, when WhatsApp rejects a "
      + "recipient. Its WhatsApp sends went to the delivery owner in Cut B2; this one stayed "
      + "because SMS is a different channel, not a second WhatsApp transport.",
  },
  // server/routes/whatsapp.ts was here until Cut B2 and is deliberately gone: sendParts built its
  // own Twilio client and ran the third copy of the retry loop, and now calls the owner above.
  // The reply path still exists — it just can no longer reach a client behind the owner's back,
  // which is the whole point of counting. unit-tests asserts that file stays at zero direct sends.
  {
    file: "server/handlers/safety.ts", shaping: "verbatim-by-design",
    why: "Crisis routing. A helpline number and the words around it must reach a person EXACTLY as written — no rewrite, no shortening, no gate that could fail. Never shape this.",
  },
  {
    file: "server/twilio-interactive.ts", shaping: "verbatim-by-design",
    why: "Button/list payloads. The body is built by the caller and is already short and structural; reshaping would break the interactive envelope.",
  },
  {
    file: "server/handlers/chat-log.ts", shaping: "not-client-facing",
    why: "Conversation logging and coach-facing echoes.",
  },
  {
    file: "server/routes/payments.ts", shaping: "not-client-facing",
    why: "Billing webhooks — transactional receipts and failure alerts, not coaching.",
  },
  {
    file: "server/routes/admin.ts", shaping: "not-client-facing",
    why: "Admin console actions, sent by the founder deliberately.",
  },
  {
    file: "server/routes/dashboard.ts", shaping: "not-client-facing",
    why: "Admin dashboard actions.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk("server");
const actual = files.filter(f => /messages\s*\.\s*create\s*\(/.test(readFileSync(f, "utf-8"))).sort();
const declared = SENDERS.map(s => s.file).sort();

const problems: string[] = [];

for (const f of actual) {
  if (!declared.includes(f)) {
    problems.push(`  ✗ ${f} can send to a client and is NOT declared in script/check-reach.ts.`);
    problems.push(`    Add it with a reason — and if a client reads it as coaching, route it through`);
    problems.push(`    sendFinal (reactive) or sendWhatsApp (proactive) so both gates apply.`);
  }
}
for (const f of declared) {
  if (!actual.includes(f)) {
    problems.push(`  ↓ ${f} no longer sends anything — remove it from SENDERS to lock the win in.`);
  }
}

if (problems.length > 0) {
  console.error("reach guard: FAILED\n");
  console.error(problems.join("\n"));
  console.error("\nEvery path to a client is declared here on purpose. Three of the eight defects");
  console.error("found on 30 July were a gate wired to the wrong door — nobody needed to test for");
  console.error("those, somebody needed to count. This counts.");
  process.exit(1);
}

const shaped = SENDERS.filter(s => s.shaping === "shaped").length;
const verbatim = SENDERS.filter(s => s.shaping === "verbatim-by-design").length;
console.log(`reach guard: ${actual.length} paths can reach a client — ${shaped} shaped, ${verbatim} verbatim by design, ${SENDERS.length - shaped - verbatim} not client-facing.`);
