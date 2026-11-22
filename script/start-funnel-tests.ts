/**
 * The /start page counter stores only whitelisted values. Anything else (free text, an answer,
 * a health-derived outcome, an oversized body) is dropped, so no personal data can reach the table.
 */
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY ??= "sk-stub";
const { parseFunnelEvent, spotsOpenFromEnv } = await import("../server/routes/admin-metrics");

let failed = 0;
function check(name: string, ok: boolean) { if (!ok) { failed++; console.log(`FAIL ${name}`); } else console.log(`ok   ${name}`); }

// The founder closes the intake from Railway (KAMLIFE_SPOTS=full) without a code change; only "full" closes it.
check("KAMLIFE_SPOTS=full closes the intake; unset, open or a typo keeps it open",
  spotsOpenFromEnv("full") === false && spotsOpenFromEnv(" FULL ") === false && spotsOpenFromEnv(undefined) === true && spotsOpenFromEnv("open") === true && spotsOpenFromEnv("fulll") === true);

check("the page's beacon (a JSON string) is counted",
  JSON.stringify(parseFunnelEvent('{"step":"landing","outcome":"","src":"TT"}')) === JSON.stringify({ step: "landing", outcome: "", src: "TT" }));
check("a fit outcome is counted", parseFunnelEvent({ step: "outcome", outcome: "FIT_OPEN", src: "IG" })?.outcome === "FIT_OPEN");
check("a health-derived outcome is never stored", parseFunnelEvent({ step: "outcome", outcome: "MEDICAL", src: "IG" }) === null);
check("an unknown step is dropped", parseFunnelEvent({ step: "Lerato 0821234567", outcome: "", src: "IG" }) === null);
check("an unknown source is dropped", parseFunnelEvent({ step: "landing", outcome: "", src: "someone's name" }) === null);
check("a shared-link visit (#share) is counted", parseFunnelEvent({ step: "landing", outcome: "", src: "SHARE" })?.src === "SHARE");
check("junk is dropped", parseFunnelEvent("not json") === null && parseFunnelEvent(null) === null);
check("an oversized body is dropped", parseFunnelEvent(JSON.stringify({ step: "landing", pad: "x".repeat(400) })) === null);

// The pages must not contradict each other on billing or brand line.
const { readFileSync } = await import("node:fs");
const startJs = readFileSync("client/public/start/app.js", "utf8");
const payHtml = readFileSync("client/public/pay/index.html", "utf8");
check("the start page no longer says billing is on the 1st", !startJs.includes("before the 1st"));
check("the first screen has one start button and every start button opens question 1 (22 Nov rebuild: every start button says Start on WhatsApp)", /for\(const id of \["begin","begin2","begin3","begin4"\]\)\{const b=document\.getElementById\(id\);if\(b\)b\.onclick=\(\)=>visit\("goal"\);\}/.test(startJs) && !/data-goal=/.test(startJs) && (startJs.match(/startBtn\("begin"/g)||[]).length===1 && (startJs.match(/startBtn\("begin\d?","Start on WhatsApp"/g)||[]).length===4);
check("R250 is kept for everyone who joins by 31 December (founder, 22 Nov); R450 is for new clients from January", startJs.includes("Join by 31 December to keep R250") && payHtml.includes("Join by 31 December to keep R250") && !startJs.includes("30 November") && !payHtml.includes("30 November"));
check("the pay page carries the same brand line as the start page", payHtml.includes("Real people. Real life. Real progress.") && !payHtml.includes("Accountability"));

// kamlife.co.za opens on the /start page, not the Coach K app.
const { isKamlifeDomain } = await import("../server/static");
check("www.kamlife.co.za and kamlife.co.za go to /start", isKamlifeDomain("www.kamlife.co.za") && isKamlifeDomain("KamLife.co.za:443"));
check("the Railway address keeps its own root", !isKamlifeDomain("kamlife-coach-production.up.railway.app") && !isKamlifeDomain(undefined));
{
  // The root serves the page itself (no redirect), so the address and share links stay kamlife.co.za.
  const { kamlifeDomainRoot } = await import("../server/static");
  const req: any = { method: "GET", path: "/", url: "/", headers: { host: "www.kamlife.co.za" } };
  let redirected = false, nexted = false;
  kamlifeDomainRoot(req, { redirect: () => { redirected = true; } } as any, () => { nexted = true; });
  const startHtml = readFileSync("client/public/start/index.html", "utf8");
  check("kamlife.co.za/ serves the start page with no redirect", !redirected && nexted && req.url === "/start/index.html");
  check("share previews and canonical point at kamlife.co.za", startHtml.includes('rel="canonical" href="https://www.kamlife.co.za/"') && !startHtml.includes("up.railway.app") && startHtml.includes('src="/start/app.js"'));
}

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


// No dead ends: every screen except health and under-18 offers a way to stay in touch, across every answer combination.
{
  const cut = startJs.indexOf("// No health- or age-derived result");
  const page = new Function("location", startJs.slice(0, cut).replace('"use strict";', "") + ";return {QUESTIONS,routeAnswers,renderOutcome,spotsOpen};")({ hash: "", origin: "https://www.kamlife.co.za" });
  let combos: Record<string, string>[] = [{}];
  for (const q of page.QUESTIONS) combos = combos.flatMap((c: any) => q.options.map((o: string[]) => ({ ...c, [q.key]: o[0] })));
  const stranded = combos.filter(a => {
    const r = page.routeAnswers(a, page.spotsOpen);
    if (r.outcome === "MEDICAL" || r.outcome === "GUARDIAN") return false;
    const html = page.renderOutcome(r, a);
    return !html.includes('id="whatsappLink"') && !html.includes('id="followChannel"');
  });
  check(`every non-health result has a WhatsApp or Channel button (${combos.length} combinations)`, combos.length === 10800 && stranded.length === 0);
}
check("a non-fit reason (budget) is counted", parseFunnelEvent({ step: "outcome", outcome: "BUDGET", src: "TT" })?.outcome === "BUDGET");
check("a Channel tap is counted", parseFunnelEvent({ step: "channel", outcome: "BUDGET", src: "TT" })?.step === "channel");
{
  const cut = startJs.indexOf("// No health- or age-derived result");
  const page = new Function("location", startJs.slice(0, cut).replace('"use strict";', "") + ";return {routeAnswers,messageFor,renderOutcome,QUESTIONS};")({ hash: "", origin: "https://www.kamlife.co.za" });
  const explorer = { goal: "weight", train: "home", need: "food", commit: "ready", start: "looking", med: "none" };
  const r = page.routeAnswers(explorer, true);
  check("someone just exploring, otherwise a fit, reaches the coach and says they're exploring",
    r.outcome === "FIT_OPEN" && page.messageFor(explorer, r).includes("Start: I'm just exploring for now"));
  // GLP-1 users (19 Nov): someone on weight-loss medication from her doctor finds her answer, reaches the coach,
  // and is told her doctor stays in charge of the medication.
  const onMeds = { ...explorer, start: "now", med: "managed" };
  const medOpt = page.QUESTIONS.find((q: any) => q.key === "med").options.find((o: any) => o[0] === "managed")[1];
  const medR = page.routeAnswers(onMeds, true);
  check("someone on weight-loss medication from her doctor reaches the coach with her doctor kept in charge",
    /weight-loss medication/.test(medOpt) && medR.outcome === "FIT_OPEN" && page.renderOutcome(medR, onMeds).includes("Keep your doctor in the loop"));
  // About you (20 Nov): the founder must know who is messaging (name, woman or man, age, where) without asking in WhatsApp.
  const who = { ...explorer, start: "now", med: "none", name: "Lerato M", sex: "f", age: "25-34", place: "Accra", days: "3-4" };
  check("the WhatsApp message opens with her name, woman or man, age and where she's based",
    page.messageFor(who, page.routeAnswers(who, true)).startsWith("Hi Coach 👋🏾 I'm Lerato (woman, 25-34), based in Accra. I did the KamLife check.")
    && /, 3-4 days a week/.test(page.messageFor(who, page.routeAnswers(who, true))) && /Price: seen it/.test(page.messageFor(who, page.routeAnswers(who, true))));
  // Shorter flow (17 Nov): no price question and no name screen; every combination still gets a result,
  // and a full intake keeps the buyer by sending her to the coach's priority list, not away.
  const qs: any[] = page.QUESTIONS;
  check("the price question and name screen are gone", !qs.some((q: any) => q.key === "price") && !/screen==="name"/.test(startJs));
  let combos = 0, incomplete = 0, fullLost = 0;
  const walk = (i: number, a: any) => {
    if (i === qs.length) {
      for (const open of [true, false]) {
        combos++; const res = page.routeAnswers(a, open);
        if (res.outcome === "INCOMPLETE") incomplete++;
        if (res.outcome === "FIT_FULL" && !(page.renderOutcome(res, a).includes('id="whatsappLink"') && page.messageFor(a, res).includes("PRIORITY LIST"))) fullLost++;
      }
      return;
    }
    for (const [v] of qs[i].options) walk(i + 1, { ...a, [qs[i].key]: v });
  };
  walk(0, {});
  check(`all ${combos} answer combinations reach a result`, combos > 0 && incomplete === 0);
  check("a full intake always offers the priority list on WhatsApp", fullLost === 0);
}


// The start page promises video demos for gym and home: every exercise on the plan page has one.
{
  const w: any = {};
  new Function("window", readFileSync("client/public/plan/programmes.js", "utf8"))(w);
  const noVideo: string[] = [];
  for (const [key, text] of Object.entries(w.KAMLIFE_PROGRAMMES as Record<string, string>)) {
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (!/^\d️⃣/u.test(l)) return;
      const next = lines.slice(i + 1, i + 3).find(x => /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(x.trim()));
      if (!next) noVideo.push(`${key}: ${l}`);
    });
  }
  check(`every plan page exercise has a video${noVideo.length ? ` (missing: ${noVideo.slice(0, 3).join("; ")})` : ""}`, noVideo.length === 0);
}

// Since 14 Nov people not training yet can reach the coach, so the page and its share preview must not say it's only for people already training.
check("the landing page and share preview welcome people who are just starting",
  !/coaching for people already training|You’re training\.<br>|content="Already training|content="For people already training/.test(startJs + readFileSync("client/public/start/index.html", "utf8")));

// Safety: a change to the pay page's bank account name, or a new phone number on the pay or start page, must fail CI before it ships.
{
  const payJs = readFileSync("client/public/pay/app.js", "utf8");
  check("the pay page account name is KamLife (Pty) Ltd", /const ACCOUNT_NAME = "KamLife \(Pty\) Ltd";/.test(payJs));
  check("the pay reference fits a bank app (cell number, not name and number)", /Payment reference: <strong>your cell number<\/strong>/.test(readFileSync("client/public/pay/index.html", "utf8")));
  check("the pay page account number and branch are the company's", /const ACCOUNT_NUMBER = "63222881525";/.test(payJs) && /const BRANCH_CODE = "250655";/.test(payJs) && /const BANK = "FNB \/ RMB";/.test(payJs));
  const pages = startJs + payJs + payHtml + readFileSync("client/public/start/index.html", "utf8");
  const numbers = pages.match(/(?:\+?27|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}/g) ?? [];
  const other = numbers.filter(n => n.replace(/\D/g, "").replace(/^0/, "27") !== "27658829664");
  check(`the only phone number on the pay and start pages is 065 882 9664${other.length ? ` (found: ${other.join(", ")})` : ""}`, numbers.length > 0 && other.length === 0);
}

console.log(failed ? `\n${failed} failed` : "\nstart-funnel-tests: all passed");
process.exit(failed ? 1 : 0);
