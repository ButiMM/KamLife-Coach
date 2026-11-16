// Page watch: loads the live start, pay and plan pages, checks the bank name and phone
// numbers the pages show, and reads today's visit counter. Prints one line starting
// "PAGEWATCH " with a JSON result that the founder's scheduled watch reads from the run log.
// The repo is public, so this prints only ok/alert flags and today's aggregate counts:
// no bank account number, no key, no names.
// Exits 1 when something is wrong, so the run shows red.

const HOSTS = ["https://www.kamlife.co.za", "https://kamlife-coach-production.up.railway.app"];
const ALLOWED_PHONES = new Set(["27658829664", "0658829664"]);
const ACCOUNT = "kamlife (pty) ltd";
const SOCIAL = ["IG", "TT", "STATUS", "CELEB"];

export function checkPay(js) {
  const m = js.match(/ACCOUNT_NAME\s*=\s*["'`]([^"'`]*)["'`]/);
  return { accountName: m ? m[1] : null, ok: !!m && m[1].trim().toLowerCase() === ACCOUNT };
}

export function findPhones(text) {
  const found = new Set();
  for (const m of text.matchAll(/wa\.me\/(\d+)/g)) found.add(m[1]);
  for (const m of text.matchAll(/(?<![\d])(?:\+?27|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}(?![\d])/g)) {
    found.add(m[0].replace(/[^\d]/g, ""));
  }
  const other = [...found].filter((n) => !ALLOWED_PHONES.has(n));
  return { other, ok: other.length === 0 };
}

export function traffic(json) {
  const t = json?.todaySoFar;
  if (!t) return null;
  const bySource = {};
  for (const [src, v] of Object.entries(t.bySource ?? {})) bySource[src] = { visits: v.landing ?? 0, whatsapp: v.contact ?? 0 };
  const socialVisits = SOCIAL.reduce((s, k) => s + (bySource[k]?.visits ?? 0), 0);
  const whatsappClicks = t.whatsappClicks ?? 0;
  return { day: json.today, visits: t.visits ?? 0, whatsappClicks, socialVisits, bySource,
    realTraffic: whatsappClicks > 0 || socialVisits >= 20 };
}

async function get(path) {
  let last = "no response";
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + path, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } });
      const body = await r.text();
      if (r.ok && body.trim().length > 0) return { ok: true, host, status: r.status, body };
      last = `${r.status}${body.trim() ? "" : " empty"}`;
    } catch (e) {
      last = String(e?.cause?.code ?? e?.name ?? e);
    }
  }
  return { ok: false, error: last };
}

async function main() {
  const out = { at: new Date().toISOString(), pages: {}, alerts: [] };
  for (const p of ["start", "pay", "plan"]) {
    const r = await get(`/${p}/`);
    const title = r.ok ? (r.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim() : null;
    out.pages[p] = r.ok ? { up: true, via: new URL(r.host).hostname, title } : { up: false, error: r.error };
    if (!r.ok) out.alerts.push(`PAGE_DOWN ${p} (${r.error})`);
  }

  const pay = await get("/pay/app.js");
  if (pay.ok) {
    const c = checkPay(pay.body), ph = findPhones(pay.body);
    out.payAccountNameOk = c.ok;
    out.payPhonesOk = ph.ok;
    if (!c.ok) out.alerts.push(`BANK_NAME_CHANGED "${c.accountName ?? "missing"}"`);
    if (!ph.ok) out.alerts.push(`OTHER_PHONE pay ${ph.other.join(",")}`);
  } else out.alerts.push(`PAY_CODE_UNREADABLE (${pay.error})`);

  const start = await get("/start/app.js");
  if (start.ok) {
    const ph = findPhones(start.body);
    out.startPhonesOk = ph.ok;
    if (!ph.ok) out.alerts.push(`OTHER_PHONE start ${ph.other.join(",")}`);
  } else out.alerts.push(`START_CODE_UNREADABLE (${start.error})`);

  const key = process.env.FUNNEL_WATCH_KEY;
  if (!key) out.traffic = "NO_KEY";
  else {
    const f = await get(`/api/funnel/watch?k=${encodeURIComponent(key)}`);
    try { out.traffic = f.ok ? traffic(JSON.parse(f.body)) ?? "NO_DATA" : "NO_DATA"; } catch { out.traffic = "NO_DATA"; }
  }

  console.log("PAGEWATCH " + JSON.stringify(out));
  if (out.alerts.length) process.exit(1);
}

if (process.argv[2] === "--self-test") {
  const assert = (await import("node:assert/strict")).default;
  assert.equal(checkPay('const ACCOUNT_NAME = "KamLife (Pty) Ltd";').ok, true);
  assert.equal(checkPay('const ACCOUNT_NAME = "K Mokoena";').ok, false);
  assert.deepEqual(findPhones('wa.me/27658829664 call 065 882 9664').other, []);
  assert.deepEqual(findPhones('wa.me/27821234567').other, ["27821234567"]);
  assert.deepEqual(findPhones('ACCOUNT_NUMBER = "63222881525"').other, []);
  const t = traffic({ today: "2026-11-16", todaySoFar: { visits: 25, whatsappClicks: 0, bySource: { IG: { landing: 12, contact: 0 }, TT: { landing: 8, contact: 0 }, LINK: { landing: 5, contact: 0 } } } });
  assert.equal(t.socialVisits, 20);
  assert.equal(t.realTraffic, true);
  console.log("page-watch self-test ok");
} else {
  await main();
}
