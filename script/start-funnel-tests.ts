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

console.log(failed ? `\n${failed} failed` : "\nstart-funnel-tests: all passed");
process.exit(failed ? 1 : 0);
