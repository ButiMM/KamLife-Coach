/**
 * The delivery-status webhook fails closed (#341). With the repo public, /webhook/status is a known
 * path: a request must carry a valid Twilio signature, and with no TWILIO_AUTH_TOKEN nothing passes.
 * Graded on the HTTP status of a real request to the real route (DB stubbed; nothing is written).
 */
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY ??= "sk-stub"; // module-load clients only; no model is called
process.env.OFFLINE_AI ??= "1";
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const express = (await import("express")).default;
const twilio = (await import("twilio")).default;
const { registerPaymentRoutes } = await import("../server/routes/payments");

const app = express();
app.use(express.urlencoded({ extended: false }));
registerPaymentRoutes(app as any);
const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const port = (server.address() as any).port;
const url = `http://127.0.0.1:${port}/webhook/status`;
const params = { MessageSid: "SM341test", MessageStatus: "delivered", To: "whatsapp:+27820000341" };

async function post(signature?: string): Promise<number> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(signature ? { "x-twilio-signature": signature } : {}) },
    body: new URLSearchParams(params).toString(),
  });
  return r.status;
}

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? ` — ${evidence}` : ""}`);
};

REAL("\nstatus-webhook-auth-tests — the delivery-status webhook fails closed (#341)\n");

for (const env of ["production", "development"]) {
  process.env.NODE_ENV = env;
  delete process.env.TWILIO_AUTH_TOKEN;
  const s = await post();
  chk(s === 503, `no TWILIO_AUTH_TOKEN (${env}): an unsigned request is refused`, `status ${s}`);
}

process.env.NODE_ENV = "production";
process.env.TWILIO_AUTH_TOKEN = "test-token-341";
chk((await post()) === 403, "token set: a request with no signature is refused");
chk((await post("forged")) === 403, "token set: a forged signature is refused");
const good = twilio.getExpectedTwilioSignature("test-token-341", url, params);
const s = await post(good);
chk(s === 200, "token set: a correctly signed Twilio request is accepted", `status ${s}`);

server.close();
REAL(`\nstatus-webhook-auth-tests: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
process.exit(failed === 0 ? 0 : 1);
