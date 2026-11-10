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

console.log(failed ? `\n${failed} failed` : "\nstart-funnel-tests: all passed");
process.exit(failed ? 1 : 0);
