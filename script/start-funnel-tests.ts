/**
 * The /start page counter stores only whitelisted values. Anything else (free text, an answer,
 * a health-derived outcome, an oversized body) is dropped, so no personal data can reach the table.
 */
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY ??= "sk-stub";
const { parseFunnelEvent } = await import("../server/routes/admin-metrics");

let failed = 0;
function check(name: string, ok: boolean) { if (!ok) { failed++; console.log(`FAIL ${name}`); } else console.log(`ok   ${name}`); }

check("the page's beacon (a JSON string) is counted",
  JSON.stringify(parseFunnelEvent('{"step":"landing","outcome":"","src":"TT"}')) === JSON.stringify({ step: "landing", outcome: "", src: "TT" }));
check("a fit outcome is counted", parseFunnelEvent({ step: "outcome", outcome: "FIT_OPEN", src: "IG" })?.outcome === "FIT_OPEN");
check("a health-derived outcome is never stored", parseFunnelEvent({ step: "outcome", outcome: "MEDICAL", src: "IG" }) === null);
check("an unknown step is dropped", parseFunnelEvent({ step: "Lerato 0821234567", outcome: "", src: "IG" }) === null);
check("an unknown source is dropped", parseFunnelEvent({ step: "landing", outcome: "", src: "someone's name" }) === null);
check("junk is dropped", parseFunnelEvent("not json") === null && parseFunnelEvent(null) === null);
check("an oversized body is dropped", parseFunnelEvent(JSON.stringify({ step: "landing", pad: "x".repeat(400) })) === null);

// The pages must not contradict each other on billing or brand line.
const { readFileSync } = await import("node:fs");
const startJs = readFileSync("client/public/start/app.js", "utf8");
const payHtml = readFileSync("client/public/pay/index.html", "utf8");
check("the start page no longer says billing is on the 1st", !startJs.includes("before the 1st"));
check("the pay page carries the same brand line as the start page", payHtml.includes("Real people. Real life. Real progress.") && !payHtml.includes("Accountability"));

// kamlife.co.za opens on the /start page, not the Coach K app.
const { isKamlifeDomain } = await import("../server/static");
check("www.kamlife.co.za and kamlife.co.za go to /start", isKamlifeDomain("www.kamlife.co.za") && isKamlifeDomain("KamLife.co.za:443"));
check("the Railway address keeps its own root", !isKamlifeDomain("kamlife-coach-production.up.railway.app") && !isKamlifeDomain(undefined));

check("no page says 'first 100 clients' or 'founding rate'", !/first 100 clients|founding rate/i.test(startJs + payHtml));
// The page watch summary is counts only and finds where people drop off.
const { summarizeFunnel } = await import("../server/routes/admin-metrics");
const sum = summarizeFunnel([
  { day: "2026-11-12", step: "landing", outcome: "", src: "IG", n: 100 },
  { day: "2026-11-12", step: "q1", outcome: "", src: "IG", n: 60 },
  { day: "2026-11-12", step: "q2", outcome: "", src: "IG", n: 20 },
  { day: "2026-11-12", step: "q3", outcome: "", src: "IG", n: 18 },
  { day: "2026-11-12", step: "q4", outcome: "", src: "IG", n: 17 },
  { day: "2026-11-12", step: "q5", outcome: "", src: "IG", n: 16 },
  { day: "2026-11-12", step: "q6", outcome: "", src: "IG", n: 15 },
  { day: "2026-11-12", step: "q7", outcome: "", src: "IG", n: 14 },
  { day: "2026-11-12", step: "name", outcome: "", src: "IG", n: 12 },
  { day: "2026-11-12", step: "outcome", outcome: "FIT_OPEN", src: "IG", n: 10 },
  { day: "2026-11-12", step: "contact", outcome: "FIT_OPEN", src: "IG", n: 8 },
  { day: "2026-11-11", step: "landing", outcome: "", src: "TT", n: 40 },
], "2026-11-12");
check("page watch counts today's visits and WhatsApp clicks", sum.todaySoFar.visits === 100 && sum.todaySoFar.whatsappClicks === 8 && sum.yesterday.visits === 40);
check("page watch names the biggest drop-off", sum.todaySoFar.biggestDrop?.from === "q1" && sum.todaySoFar.biggestDrop?.to === "q2");

console.log(failed ? `\n${failed} failed` : "\nstart-funnel-tests: all passed");
process.exit(failed ? 1 : 0);
