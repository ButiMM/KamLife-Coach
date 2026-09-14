/**
 * PROACTIVE TEMPLATE DELIVERY — focused tests (Cut 6, 2026-09-14).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS TRUE BEFORE THIS CUT, traced on c042dd8 before a line of it was written
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WhatsApp refuses freeform text outside 24 hours of the client's last message (Twilio 63016).
 * Only an approved template gets through. The registry carried FOUR approved templates and the
 * codebase had exactly ONE template call site:
 *
 *     reminders 1 · narrative 1 · onboarding 13 · spend-watchdog 2 · weekly 9 · trial 3
 *     evening 2 · business 9 · programme 9 · media-recovery 1 · morning 3 · monday 4
 *                            ── 57 proactive sends, 0 template sends ──
 *
 * kamlife_daily_plan, kamlife_weekly_check and kamlife_payment_failed had NO caller at all. The
 * only template that could be sent was the generic "Coach K checking in", from inside sendWhatsApp's
 * error handler — and it returned "fallback", which deliveryAccepted() reads as TRUE. So a client
 * who went quiet did not get a late morning plan; they got a generic check-in, and the job recorded
 * a delivery and a training move against a message the client never saw.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW THIS IS GRADED, STATED HONESTLY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * DETERMINISTIC SIMULATED TWILIO RESPONSES, as the order specifies. A 63016 is a fact about a live
 * WhatsApp sender and a real client's last inbound message; no fixture can arrange one. So the
 * provider's ANSWER is simulated and everything else is the shipped code: the template registry,
 * the SID validation, the variable sanitiser, the window-recovery branch, the truth floor, the
 * outcome reported to the caller and the exact payload handed to Twilio.
 *
 * NOTHING HERE PROVES A MESSAGE REACHED A PHONE. It proves which template was chosen, what it
 * carried, and what the caller was told — which is precisely what was wrong.
 */
process.env.OFFLINE_AI = "1";
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = "sk-stub";
process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.APP_URL = "https://kamlifecoach.co.za";
process.env.PROACTIVE_PAUSED = "";
process.env.SHADOW = "";

// Four valid-looking SIDs, so the wiring is exercised rather than skipped as "unapproved".
const SID = {
  daily: "HX00000000000000000000000000000001",
  weekly: "HX00000000000000000000000000000002",
  payment: "HX00000000000000000000000000000003",
  reengage: "HX00000000000000000000000000000004",
};
process.env.TWILIO_DAILY_TEMPLATE_SID = SID.daily;
process.env.TWILIO_WEEKLY_TEMPLATE_SID = SID.weekly;
process.env.TWILIO_PAYMENT_TEMPLATE_SID = SID.payment;
process.env.TWILIO_REENGAGE_TEMPLATE_SID = SID.reengage;

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const { _setTwilioClientForTests, deliveryAccepted, statusCallbackUrl } = await import("../server/outbound-delivery");
const { sendWhatsApp } = await import("../server/scheduler/shared");
const {
  TEMPLATES, templateSid, isValidTemplateSid, renderTemplateBody,
  malformedTemplateEnvNames, WINDOW_RECOVERY_TEMPLATE, validateTemplate,
} = await import("../server/whatsapp-templates");
const { buildContentVariables, sanitiseContentVariable } = await import("../server/utils");

// ── THE SIMULATED PROVIDER ───────────────────────────────────────────────────────────────────
// Call 1 is rejected with 63016 — the client is outside the window. Everything after it succeeds.
// Every payload is recorded, so "what did we actually hand Twilio?" is answered from the payload
// rather than from a log line.
let sent: Array<Record<string, any>> = [];
let rejectFirstWith: number | null = 63016;
const fakeTwilio = {
  messages: {
    create: async (payload: Record<string, any>) => {
      sent.push(payload);
      if (sent.length === 1 && rejectFirstWith !== null) {
        const err: any = new Error(`simulated Twilio ${rejectFirstWith}`);
        err.code = rejectFirstWith;
        err.status = 400;
        throw err;
      }
      return { sid: `SM${sent.length}` };
    },
  },
};
_setTwilioClientForTests(fakeTwilio);

const reset = () => { sent = []; rejectFirstWith = 63016; };
const freeform = () => sent.find(p => typeof p.body === "string");
const template = () => sent.find(p => typeof p.contentSid === "string");

console.log("\nproactive-template-tests\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("1. A CLOSED WINDOW SENDS THE MESSAGE'S OWN TEMPLATE, CARRYING ITS REAL CONTENT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  reset();
  const ACTION = "Log one meal — even just what you had for lunch";
  const outcome = await sendWhatsApp("whatsapp:+27820000001", "Morning Thandi — here is your plan.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": ACTION },
  });

  chk(!!template(), "a template was sent after the freeform send was rejected",
    `payloads: ${JSON.stringify(sent.map(p => Object.keys(p)))}`);
  chk(template()?.contentSid === SID.daily,
    "…and it is the DAILY template, not the generic check-in", `got ${template()?.contentSid}`);
  const vars = JSON.parse(template()?.contentVariables || "{}");
  chk(vars["2"] === ACTION, "…carrying the client's ACTUAL action, not a placeholder",
    JSON.stringify(vars));
  chk(vars["1"] === "Thandi", "…and their actual name");

  // THE OUTCOME IS ACCEPTED, because the content really did reach them — in approved-template form.
  chk(deliveryAccepted(outcome), "the caller is told the message was delivered", `outcome=${outcome}`);

  // AND THE RENDERED BODY IS THE APPROVED BODY. This is what history and the truth floor now see.
  const body = renderTemplateBody("kamlife_daily_plan", vars);
  chk(body.includes("Thandi") && body.includes(ACTION),
    "the locally rendered body is the approved text with the real values in it",
    JSON.stringify(body.slice(0, 90)));
  chk(!body.includes("{{"), "…with no placeholder left unfilled", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n2. WEEKLY USES WEEKLY, PAYMENT USES PAYMENT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Without this, one wired template would satisfy §1 and the other two could stay orphaned.
{
  reset();
  await sendWhatsApp("whatsapp:+27820000002", "Your week in full.", undefined, {
    name: "kamlife_weekly_check", variables: { "1": "Thandi", "2": "2 of 3", "3": "5 of 7" },
  });
  chk(template()?.contentSid === SID.weekly, "the weekly review sends the WEEKLY template",
    `got ${template()?.contentSid}`);
  const wv = JSON.parse(template()?.contentVariables || "{}");
  chk(wv["2"] === "2 of 3" && wv["3"] === "5 of 7", "…carrying the week's real counts", JSON.stringify(wv));

  reset();
  await sendWhatsApp("whatsapp:+27820000003", "Your payment did not go through.", undefined, {
    name: "kamlife_payment_failed", variables: { "1": "Thandi", "2": "199" },
  });
  chk(template()?.contentSid === SID.payment, "the payment alert sends the PAYMENT template",
    `got ${template()?.contentSid}`);
  chk(JSON.parse(template()?.contentVariables || "{}")["2"] === "199", "…carrying the real amount");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n3. A GENERIC CHECK-IN IS NEVER RECORDED AS DELIVERY OF THE ORIGINAL MESSAGE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE DEFECT IN ONE CHECK. The old code returned "fallback" here, deliveryAccepted() read that as
// true, and morning.ts opened a training loop for a client who had read "Coach K checking in".
{
  reset();
  const outcome = await sendWhatsApp("whatsapp:+27820000004", "Morning Thandi — here is your plan.");
  chk(template()?.contentSid === SID.reengage,
    "with no template for this message, the generic check-in goes", `got ${template()?.contentSid}`);
  chk(outcome === "substituted", "…and the outcome says SUBSTITUTED, not delivered", `outcome=${outcome}`);
  chk(!deliveryAccepted(outcome),
    "…so deliveryAccepted() is FALSE and no caller records this as the message landing");

  // THE OPPOSITE CONTROL: a matched template must NOT report substituted, or §1's acceptance is
  // satisfied by a door that reports failure for everything.
  reset();
  const good = await sendWhatsApp("whatsapp:+27820000005", "Morning.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": "Walk 20 minutes" },
  });
  chk(good !== "substituted" && deliveryAccepted(good),
    "a matched template is still reported as delivered", `outcome=${good}`);

  // AND AN OPEN WINDOW IS UNTOUCHED: no rejection, no template, plain freeform delivery.
  reset(); rejectFirstWith = null;
  const open = await sendWhatsApp("whatsapp:+27820000006", "Morning Thandi.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": "Walk 20 minutes" },
  });
  chk(open === "sent" && !template(),
    "inside the window nothing changes — freeform goes and no template is sent", `outcome=${open}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n4. RUNTIME VARIABLES CONTAINING NEWLINES ARE SAFELY RENDERED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// validateTemplate has always checked the SAMPLES submitted for approval. Nothing checked the
// values actually sent — and kamlife_daily_plan's {{2}} is computed prose out of one-action.ts.
{
  chk(sanitiseContentVariable("Log one meal\nwhat you had for lunch") === "Log one meal what you had for lunch",
    "a line break inside a variable becomes a space, and the words survive");
  chk(sanitiseContentVariable("a\t\tb") === "a b", "tabs too");
  chk(sanitiseContentVariable("a    b") === "a b", "and runs of spaces Meta strips or rejects");
  chk(sanitiseContentVariable("  padded  ") === "padded", "…and the value is trimmed");
  chk(sanitiseContentVariable("8,500 steps — 2 of 3 sessions") === "8,500 steps — 2 of 3 sessions",
    "a clean value is passed through UNCHANGED, punctuation and all");
  chk(buildContentVariables({ "1": "\n \t " }) === undefined,
    "a variable that is nothing but whitespace is not sent as a value");

  reset();
  await sendWhatsApp("whatsapp:+27820000007", "Morning.", undefined, {
    name: "kamlife_daily_plan",
    variables: { "1": "Thandi", "2": "Log one meal today.\n\nEven just lunch." },
  });
  // READ DEFENSIVELY. If the daily template is not the one that went, there is no {{2}} to read —
  // and an assertion that THROWS on that is a crash, which this cut's own revert harness refuses
  // to count as a detection. It must FAIL and say what it saw.
  const v = JSON.parse(template()?.contentVariables || "{}");
  const v2 = typeof v["2"] === "string" ? v["2"] : "";
  chk(v2 !== "", "the daily template carried a second variable at all", JSON.stringify(v));
  chk(!/[\n\r\t]/.test(v2), "the value handed to Twilio carries no line break or tab", JSON.stringify(v2));
  chk(v2.includes("Log one meal today.") && v2.includes("Even just lunch."),
    "…and none of the client's words were dropped to achieve that", JSON.stringify(v2));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n5. THE RE-ENGAGEMENT BODY CARRIES NO RESTART DOCTRINE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Three existing acceptances forbid this phrasing on the FREEFORM door. A template body renders at
// Twilio, so it never passed through them — and shipped the retired doctrine for weeks.
{
  const t = TEMPLATES.find(x => x.name === WINDOW_RECOVERY_TEMPLATE)!;
  chk(!/we start from today|no catch-?up needed|start (?:from )?fresh|reset your/i.test(t.body),
    "the re-engagement template does not tell a client their history restarts",
    JSON.stringify(t.body));
  chk(/nothing you logged is lost/i.test(t.body),
    "…and it still says their record is intact, which is the true half");
  chk(t.vars.length === 0 && !/\{\{\d+\}\}/.test(t.body),
    "it remains variable-free — it is sent from an error handler that knows only a phone number");

  // EVERY approved body, not just this one: the doctrine must not reappear in another template.
  for (const tpl of TEMPLATES) {
    chk(!/we start from today|no catch-?up needed/i.test(tpl.body),
      `…and neither does "${tpl.name}"`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n6. BOTH FREEFORM AND TEMPLATE REQUESTS CARRY THE DELIVERY CALLBACK");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// /webhook/status has existed, signature-validated, for months. No send ever asked Twilio to POST
// there, so it could not fire and a send Twilio ACCEPTED but never delivered left no evidence.
{
  reset();
  await sendWhatsApp("whatsapp:+27820000008", "Morning.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": "Walk 20 minutes" },
  });
  chk(freeform()?.statusCallback === "https://kamlifecoach.co.za/webhook/status",
    "the freeform request carries statusCallback", JSON.stringify(freeform()?.statusCallback));
  chk(template()?.statusCallback === "https://kamlifecoach.co.za/webhook/status",
    "…and so does the template request", JSON.stringify(template()?.statusCallback));

  // DERIVED, NOT DUPLICATED — and absent rather than guessed when APP_URL cannot support it.
  const real = process.env.APP_URL;
  process.env.APP_URL = "http://localhost:3000";
  chk(statusCallbackUrl() === "", "a non-https APP_URL yields no callback rather than a bad one");
  process.env.APP_URL = "";
  chk(statusCallbackUrl() === "", "…and an unset APP_URL yields none");
  process.env.APP_URL = "https://kamlifecoach.co.za/";
  chk(statusCallbackUrl() === "https://kamlifecoach.co.za/webhook/status",
    "…and a trailing slash does not produce a double slash", statusCallbackUrl());
  process.env.APP_URL = real;

  // AND THE SEND STILL HAPPENS WITHOUT ONE. A receipt is worth having; it is not worth the message.
  reset();
  process.env.APP_URL = "";
  const outcome = await sendWhatsApp("whatsapp:+27820000009", "Morning.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": "Walk 20 minutes" },
  });
  chk(deliveryAccepted(outcome) && template()?.statusCallback === undefined,
    "with no APP_URL the message still goes, simply without a receipt", `outcome=${outcome}`);
  process.env.APP_URL = real;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n7. MISSING OR MALFORMED SID CONFIGURATION FAILS LOUDLY, NOT SILENTLY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  chk(isValidTemplateSid(SID.daily), "a real Content SID validates");
  chk(!isValidTemplateSid("HX0000"), "a truncated SID does not");
  chk(!isValidTemplateSid("MG00000000000000000000000000000001"), "a Messaging Service SID is not a Content SID");
  chk(!isValidTemplateSid("TWILIO_DAILY_TEMPLATE_SID=HX000…"), "a whole pasted line is not a SID");

  const real = process.env.TWILIO_DAILY_TEMPLATE_SID;
  process.env.TWILIO_DAILY_TEMPLATE_SID = "not-a-sid";
  chk(templateSid("kamlife_daily_plan") === "", "a malformed SID reads as UNWIRED rather than being sent");
  process.env.TWILIO_DAILY_TEMPLATE_SID = "   ";
  chk(templateSid("kamlife_daily_plan") === "", "…and so does a blank one");

  // AND THE SEND FALLS BACK HONESTLY: no daily template, so the generic check-in runs and the
  // caller is told the morning plan did NOT land.
  reset();
  const outcome = await sendWhatsApp("whatsapp:+27820000010", "Morning.", undefined, {
    name: "kamlife_daily_plan", variables: { "1": "Thandi", "2": "Walk 20 minutes" },
  });
  chk(template()?.contentSid === SID.reengage && outcome === "substituted",
    "a misconfigured template degrades to the check-in AND reports it honestly",
    `sid=${template()?.contentSid} outcome=${outcome}`);
  process.env.TWILIO_DAILY_TEMPLATE_SID = real;
  chk(templateSid("kamlife_daily_plan") === SID.daily, "…and a valid SID still reads back");

  // THE RAILWAY CONDITION: a key whose NAME carries a trailing newline.
  chk(malformedTemplateEnvNames().length === 0, "with correctly named variables, nothing is reported");
  const saved = process.env.TWILIO_WEEKLY_TEMPLATE_SID;
  delete process.env.TWILIO_WEEKLY_TEMPLATE_SID;
  process.env["TWILIO_WEEKLY_TEMPLATE_SID\n"] = SID.weekly;
  const found = malformedTemplateEnvNames();
  chk(found.length === 1 && found[0].expected === "TWILIO_WEEKLY_TEMPLATE_SID",
    "a SID stored under a newline-bearing KEY is detected and named", JSON.stringify(found));
  chk(templateSid("kamlife_weekly_check") === "",
    "…and is NOT quietly read from the malformed key — a name nobody can type is not configuration");
  delete process.env["TWILIO_WEEKLY_TEMPLATE_SID\n"];
  process.env.TWILIO_WEEKLY_TEMPLATE_SID = saved;
  chk(malformedTemplateEnvNames().length === 0, "…and the report clears once the name is fixed");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n8. THE APPROVED PACK IS STILL SUBMITTABLE, AND THE TEMPLATES STILL MEAN SOMETHING");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Editing a body to remove the restart doctrine is editing a text Meta has to approve.
{
  for (const t of TEMPLATES) {
    chk(validateTemplate(t).length === 0, `"${t.name}" still passes every submission rule`,
      validateTemplate(t).join("; "));
  }
  chk(TEMPLATES.length === 4, "the pack is still four templates — none invented for this cut",
    `${TEMPLATES.length}`);
  chk(renderTemplateBody("kamlife_does_not_exist") === "", "an unknown template renders to nothing");
}

_setTwilioClientForTests(null);
console.log(`\n${failed === 0 ? "proactive-template-tests: ALL GREEN" : `proactive-template-tests: ${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
