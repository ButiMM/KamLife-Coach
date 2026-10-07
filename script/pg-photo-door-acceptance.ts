/**
 * REAL-POSTGRESQL ACCEPTANCE — a food photo gets a real reply (#596). Live, a captioned "Black coffee" photo
 * got "Eish, I cannot read that photo" and the failure row kept only a code. With Twilio and the model
 * stubbed at the network edge: a coffee and a plate are answered; a refused paid vision model falls back
 * to the one production answers text with; vision down entirely logs the caption; the row says why.
 */
if (!process.env.DATABASE_URL) { console.log("pg-photo-door-acceptance: SKIPPED — no DATABASE_URL."); process.exit(0); }
process.env.OPENAI_API_KEY = "sk-stub"; process.env.OFFLINE_AI = "0"; process.env.NORMALIZER = "off"; process.env.PROACTIVE_PAUSED = "true"; process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000"; process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
await import("./sast-noon-clock"); // #404
const { createCanvas } = await import("@napi-rs/canvas");
const jpeg = await (() => { const cv = createCanvas(64, 64); const g = cv.getContext("2d"); g.fillStyle = "#333"; g.fillRect(0, 0, 64, 64); return cv.encode("jpeg"); })();
let vision: "ok" | "4o-refused" | "down" = "ok"; let visionText = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (url.includes("twilio.com") && url.includes("/Media/")) return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) } });
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  const isVision = body.includes("image_url");
  if (isVision && (vision === "down" || (vision === "4o-refused" && JSON.parse(body).model === "gpt-4o")))
    return new Response(JSON.stringify({ error: { message: "The model `gpt-4o` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
  let content = "Noted.";
  if (body.includes("say what they want from this turn")) content = JSON.stringify({ scope: "in", family: "report", wants: "log", one_question: null, uncertainty: 0.1, facts: [], actions: [] });
  else if (body.includes("You are Coach K, a warm, direct South African")) content = "NEW-COACH-596";
  else if (isVision) content = visionText;
  return new Response(JSON.stringify({ id: "s", object: "chat.completion", created: 1, model: "stub", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};
const { pool, db } = await import("../server/db"); const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
let failed = 0;
const chk = (ok: boolean, msg: string, ev = "") => { if (!ok) failed++; REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && ev ? `\n          ${ev}` : ""}`); };
const P = "whatsapp:+27829400596", URL = "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMx/Media/MEx";
const fresh = async () => { await pool.query("DELETE FROM users WHERE phone_number=$1", [P]);
  await db.insert(schema.users).values({ phoneNumber: P, name: "Photo Tester", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 120 } as any); };
let n = 0; const photo = (caption: string) => handleMessage(P, caption, URL, "image/jpeg", undefined, `SM596${Date.now()}${++n}`);
const meals = async () => (await pool.query("SELECT raw_message r FROM meal_logs m JOIN users u ON u.id=m.user_id WHERE u.phone_number=$1", [P])).rows.map(r => String(r.r));
const CANNOT = /cannot read that photo|couldn't process that image/i;

REAL("\npg-photo-door-acceptance — a food photo gets a real reply (#596)\n");
await fresh(); vision = "ok"; visionText = "Black coffee, about 250ml — basically nothing in it.\nTOTAL: 5 kcal | 0g protein";
const c = await photo("Black coffee");
chk(!CANNOT.test(c) && c.trim().length > 0, "a captioned black-coffee photo gets a real reply, never \"cannot read\"", c.slice(0, 160));
visionText = "Pap, chicken and spinach — a solid plate.\nTOTAL: 650 kcal | 45g protein";
const p = await photo("");
chk(!CANNOT.test(p) && (await meals()).length >= 1, "a plate photo is logged and answered", `${p.slice(0, 160)} | ${JSON.stringify(await meals())}`);

await fresh(); vision = "4o-refused";
const r = await photo("Lunch");
chk(!CANNOT.test(r) && (await meals()).length === 1, "the paid vision model refused: gpt-4o-mini reads the photo and the meal is logged", `${r.slice(0, 160)} | ${JSON.stringify(await meals())}`);

await fresh(); vision = "down";
const d = await photo("Black coffee");
const row = (await pool.query("SELECT message_in i, message_out o FROM chat_history c JOIN users u ON u.id=c.user_id WHERE u.phone_number=$1 AND intent='MEDIA_FAILURE'", [P])).rows[0];
chk(!CANNOT.test(d) && (await meals()).some(m => /coffee/i.test(m)), "vision down: the caption \"Black coffee\" is logged instead of \"cannot read\"", `${d.slice(0, 160)} | ${JSON.stringify(await meals())}`);
chk(/photo_vision/.test(row?.i || "") && /does not exist or you do not have access/.test(row?.o || ""), "the failure row says which step failed and the real error", JSON.stringify(row));

await pool.query("DELETE FROM users WHERE phone_number=$1", [P]);
REAL(`\npg-photo-door-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end(); process.exit(failed === 0 ? 0 : 1);
