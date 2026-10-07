/**
 * THE TRACE'S MODEL, STUBBED AT THE NETWORK EDGE (#592). `TRACE_MODEL=stub npx tsx script/tester-trace.ts`
 * imports this first. The new coach's reading of each trace message is given here as a model would give it,
 * so the trace proves the PLUMBING: every message reaches the core, and the reading's actions are written
 * by the existing tools. Whether a real model reads these messages this way is the gate's job (A18 cases).
 * `modelCalls` counts the requests per turn; tester-trace prints it.
 */
export const modelCalls = { n: 0 };

const meal = (foodText: string, slot?: string) => ({ type: "LOG_MEAL", foodText, ...(slot ? { meal: slot } : {}), needsConfirmation: false });
const fact = (kind: string, subject: string, statement: string) => ({ kind, subject, statement, detail: {}, valid_from: null, valid_until: null, corrects: null });
const READINGS: Array<[RegExp, { family: string; actions?: unknown[]; facts?: unknown[] }]> = [
  [/^had pap and wors for lunch$/i, { family: "report", actions: [meal("pap and wors", "lunch")] }],
  [/^2 slices brown bread with peanut butter for breakfast$/i, { family: "report", actions: [meal("2 slices brown bread with peanut butter", "breakfast")] }],
  [/^kota from the spaza$/i, { family: "report", actions: [meal("kota")] }],
  [/^skipped breakfast, coffee only$/i, { family: "report", actions: [meal("coffee", "breakfast")] }],
  [/^for lunch I had rice and chicken and for supper/i, { family: "report", actions: [meal("rice and chicken", "lunch"), meal("samp and beans", "dinner")] }],
  [/^I ate a vetkoek with mince$/i, { family: "report", actions: [meal("vetkoek with mince")] }],
  [/^had a bunny chow at work$/i, { family: "report", actions: [meal("bunny chow")] }],
  [/^Ndidle ipapa nenyama$/i, { family: "report", actions: [meal("pap and meat")] }],
  [/^just finished 2 pieces of KFC/i, { family: "report", actions: [meal("2 pieces of KFC and a small chips")] }],
  [/^no it was chicken not beef$/i, { family: "correction", actions: [{ type: "CORRECT_MEAL", from: "beef", to: "chicken" }] }],
  [/^what did I eat today\?$/i, { family: "question", actions: [{ type: "SHOW_MEALS" }] }],
  [/bad knee/i, { family: "report", facts: [fact("injury", "knee", "I have a bad knee, it gets sore on stairs")] }],
  [/night shifts/i, { family: "report", facts: [fact("schedule", "night shifts", "I work night shifts this month")] }],
  [/^I have diabetes\. Had a kota for lunch$/i, { family: "report", actions: [meal("kota", "lunch")] }],
  [/^I don't eat fish$/i, { family: "report", facts: [fact("preference", "no fish", "I don't eat fish")] }],
  [/^I walked 6000 steps$/i, { family: "report", actions: [{ type: "LOG_STEPS", count: 6000 }] }],
  [/^I weigh 87kg today$/i, { family: "report", actions: [{ type: "LOG_WEIGHT", kg: 87 }] }],
  [/^I did a 30 min home workout$/i, { family: "report", actions: [{ type: "LOG_WORKOUT", what: "a 30 min home workout" }] }],
  [/^remind me to drink water at 3pm$/i, { family: "plan", actions: [{ type: "SET_REMINDER", body: "drink water", when: "at 3pm" }] }],
];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  modelCalls.n++;
  const body = typeof init?.body === "string" ? init.body : "";
  let content = "Noted.";
  if (body.includes("say what they want from this turn")) {
    const msg = String(JSON.parse(body).messages.at(-1).content || "").trim();
    const r = READINGS.find(([re]) => re.test(msg))?.[1] ?? { family: /\?$/.test(msg) ? "question" : "feeling" };
    content = JSON.stringify({ scope: "in", family: r.family, wants: "coach me", one_question: null, uncertainty: 0.1, facts: r.facts ?? [], actions: r.actions ?? [] });
  } else if (body.includes("You are Coach K, a warm, direct South African")) content = "[the new coach's words]";
  return new Response(JSON.stringify({ id: "stub", object: "chat.completion", created: 1, model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
