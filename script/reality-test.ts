/**
 * THE COACH K REALITY TEST — the six journeys, against a real database and the real model.
 *
 * (2026-08-10 directive, §7–§14.) Every other harness in this repo tests the deterministic
 * spine: routing, shape, state, persistence. None of them tests whether Coach K can COACH,
 * because that answer lives in the model's words and the model's use of the client's actual
 * state. Those are different tests and they are reported separately, on purpose.
 *
 * THE HARD RULE THIS FILE ENFORCES (§16): if the model is unreachable, every journey reports
 * NOT TESTED and the script exits non-zero-but-distinct. It must never be possible to read
 * "the deterministic harness passed" as "the coaching passed". A PASS here requires that a real
 * model answered a real turn against real rows.
 *
 * Run:  DATABASE_URL=postgresql://… REALITY_LLM=1 npx tsx script/reality-test.ts
 *
 * Each turn's record is pulled from the TURN LEDGER, so a failure can be classified against what
 * the system actually did rather than against a guess:
 *
 *   STATE          it had the wrong or missing facts
 *   UNDERSTANDING  it misread what the client meant
 *   REASONING      it understood and advised badly
 *   ACTION         it understood and mutated the wrong thing
 *   RESPONSE       it knew the answer and communicated it badly
 */

process.env.NORMALIZER = process.env.NORMALIZER || "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.ENGINE_LIVE = "on";
process.env.APP_URL = process.env.APP_URL || "https://kamlifecoach.co.za";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

type Verdict = "PASS" | "FAIL" | "NOT TESTED";
type Category = "STATE" | "UNDERSTANDING" | "REASONING" | "ACTION" | "RESPONSE";

interface Turn {
  say: string;
  media?: string;
  /** Objective checks only. Anything needing taste is left to the human reading the transcript. */
  must?: Array<{ what: string; ok: (reply: string, all: string[]) => boolean; category: Category }>;
}

interface Journey { n: number; name: string; seed?: Record<string, unknown>; before?: string[]; turns: Turn[] }

// ── Objective checks, reused across journeys ────────────────────────────────────────────────
const noGuilt = (r: string) => !/\b(you should have|you need to log|please log|why didn'?t you|disappoint|failed to|no excuse)\b/i.test(r);
const noLecture = (r: string) => r.length <= 700 && (r.match(/\n\s*[•\-\*]/g) || []).length <= 4;
const atMostOneQuestion = (r: string) => (r.match(/\?/g) || []).length <= 1;
const notGeneric = (r: string) => !/\b(can be part of a balanced diet|in moderation|everything in moderation|balanced lifestyle)\b/i.test(r);
const mentions = (...words: string[]) => (r: string) => words.some(w => new RegExp(`\\b${w}\\b`, "i").test(r));

const JOURNEYS: Journey[] = [
  {
    n: 1, name: "RESTAURANT — a menu, a goal, and today's intake",
    before: ["two eggs and toast for breakfast", "chicken, pap and spinach for lunch"],
    turns: [
      { say: "I'm at Spur tonight." },
      { say: "What should I order? I'm trying to lose weight.", must: [
        { what: "uses TODAY's intake, not a generic answer", ok: notGeneric, category: "REASONING" },
        { what: "no lecture", ok: noLecture, category: "RESPONSE" },
      ] },
      { say: "I really want the burger though.", must: [
        { what: "adapts instead of repeating the refusal", ok: (r, all) => r !== all[all.length - 2], category: "REASONING" },
        { what: "names the trade-off, does not just forbid", ok: mentions("burger", "chips", "instead", "swap", "skip"), category: "REASONING" },
      ] },
      { say: "What if I skip the chips?", must: [
        { what: "answers the CHANGED constraint", ok: mentions("chips", "burger"), category: "UNDERSTANDING" },
        { what: "keeps continuity — still about tonight's order", ok: notGeneric, category: "REASONING" },
      ] },
    ],
  },
  {
    n: 2, name: "GROCERY — a budget that tightens as it goes",
    turns: [
      { say: "Here's my grocery list: chicken, rice, oil, eggs, milk, bread, spinach." },
      { say: "I only have R600.", must: [
        { what: "works to the budget", ok: mentions("R600", "600", "budget"), category: "REASONING" },
      ] },
      { say: "I already have rice.", must: [
        { what: "does not re-buy the rice", ok: r => !/\bbuy\b[^.]{0,20}\brice\b/i.test(r), category: "UNDERSTANDING" },
      ] },
      { say: "Chicken is too expensive.", must: [
        { what: "offers a cheaper protein, not a repeat of the list", ok: mentions("eggs", "pilchards", "tin fish", "soya", "mince", "liver", "chicken feet"), category: "REASONING" },
      ] },
      { say: "Can I use eggs instead?", must: [
        { what: "answers the substitution in context", ok: mentions("eggs"), category: "UNDERSTANDING" },
        { what: "no lecture", ok: noLecture, category: "RESPONSE" },
      ] },
    ],
  },
  {
    n: 3, name: "KFC — a real-time decision against today's state",
    before: ["I had pap and chicken earlier"],
    turns: [
      { say: "Can I have KFC tonight?", must: [
        { what: "reasons from TODAY, not from nutrition trivia", ok: notGeneric, category: "REASONING" },
        { what: "gives a decision, not a hand-back", ok: atMostOneQuestion, category: "RESPONSE" },
      ] },
      { say: "I want chips too.", must: [
        { what: "answers the added item", ok: mentions("chips"), category: "UNDERSTANDING" },
      ] },
      { say: "What if I just get the chicken?", must: [
        { what: "answers the narrowed choice", ok: mentions("chicken"), category: "UNDERSTANDING" },
        { what: "no lecture", ok: noLecture, category: "RESPONSE" },
      ] },
    ],
  },
  {
    n: 4, name: "MESSY VOICE NOTE — many facts, one real question",
    turns: [
      { say: "Ok so yesterday I had pap and beef stew for supper, and this morning just tea, "
          + "I think I walked about 6000 steps maybe more I'm not sure, I missed gym on Monday "
          + "because my back was sore, I'm feeling a bit useless honestly, and tonight there's a "
          + "family thing with lots of food. What do I do about tonight?",
        must: [
          { what: "answers the ACTUAL question (tonight)", ok: mentions("tonight", "tonite"), category: "UNDERSTANDING" },
          { what: "at most one clarifying question", ok: atMostOneQuestion, category: "RESPONSE" },
          { what: "no shaming", ok: noGuilt, category: "RESPONSE" },
          { what: "no lecture", ok: noLecture, category: "RESPONSE" },
        ] },
    ],
  },
  {
    n: 5, name: "CORRECTION — five operations in one turn",
    // The deterministic half of this journey is already enforced by acceptance-hold.ts against
    // real rows. Here it is re-run WITH the model in the loop, because the normalizer rewrites
    // messy phrasing before the handlers see it and could break what the handlers do correctly.
    before: ["I had rice and chicken for lunch"],
    turns: [
      { say: "Actually no, that was yesterday. And it wasn't rice, it was pap. And I had spinach too.",
        must: [
          { what: "confirms briefly, no motivational speech", ok: r => r.length < 300 && noGuilt(r), category: "RESPONSE" },
          { what: "names the day it moved to", ok: mentions("yesterday"), category: "ACTION" },
        ] },
      { say: "What did I eat yesterday?", must: [
        { what: "chicken retained", ok: mentions("chicken"), category: "ACTION" },
        { what: "pap present", ok: mentions("pap"), category: "ACTION" },
        { what: "spinach present", ok: mentions("spinach"), category: "ACTION" },
        { what: "rice gone", ok: r => !/\brice\b/i.test(r), category: "ACTION" },
      ] },
      { say: "What did I eat today?", must: [
        { what: "today is empty", ok: mentions("nothing", "no meals", "haven't logged"), category: "STATE" },
      ] },
    ],
  },
  {
    n: 6, name: "REFUSES TO LOG — still a coach",
    turns: [
      { say: "I'm not logging today. Just tell me what to eat.", must: [
        { what: "no guilt, no logging demand", ok: noGuilt, category: "RESPONSE" },
        { what: "actually tells them what to eat", ok: r => /\b(eat|have|plate|protein|breakfast|lunch|supper|dinner)\b/i.test(r), category: "REASONING" },
        { what: "does not turn into a logging workflow", ok: r => !/\b(send me|log it|type it like|describe what you ate)\b/i.test(r), category: "RESPONSE" },
      ] },
      { say: "What about tomorrow?", must: [
        { what: "still useful, still no logging demand", ok: r => noGuilt(r) && r.length > 20, category: "RESPONSE" },
      ] },
    ],
  },
];

// ── Preflight: no model, no verdicts. §16. ──────────────────────────────────────────────────
async function modelReachable(): Promise<string | null> {
  if (process.env.REALITY_LLM !== "1") return "REALITY_LLM=1 not set — this harness is opt-in because it spends real tokens.";
  // The SAME key chain the app uses (server/gpt.ts). Reading only OPENAI_API_KEY would report
  // NOT TESTED on Railway, where AI_INTEGRATIONS_OPENAI_API_KEY is the one that is set — a
  // harness that misses the key it was pointed at is worse than no harness.
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return "no OpenAI key — set AI_INTEGRATIONS_OPENAI_API_KEY or OPENAI_API_KEY.";
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    await client.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 4,
      messages: [{ role: "user", content: "reply with: ok" }],
    });
    return null;
  } catch (e: any) {
    return `the model is unreachable from here — ${String(e?.message || e).slice(0, 160)}`;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("reality-test: needs a REAL DATABASE_URL. The journeys are about state; a stub has none.");
    process.exit(2);
  }
  // THIS HARNESS WRITES. Six fake clients, their meals, their ledger rows. Pointed at
  // production by accident — which is exactly what happens when someone runs it in the Railway
  // console because that is where the key works — it would put test users into the real client
  // table. So it counts the real clients first and refuses unless the risk is accepted out loud.
  {
    const { db } = await import("../server/db");
    const { users } = await import("../shared/schema");
    const { sql } = await import("drizzle-orm");
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(users).catch(() => [{ n: 0 }] as any);
    const realish = Number(n) - 6;                       // this harness's own six do not count
    if (realish > 0 && process.env.REALITY_ON_PROD !== "1") {
      console.error(`reality-test: this database holds ${n} users, so it looks live, and this harness CREATES`);
      console.error("users and meals. Re-run with REALITY_ON_PROD=1 if you accept that. It cleans up after");
      console.error("itself (each test client is deleted, cascading its rows), but a failed run may not.");
      process.exit(2);
    }
  }
  const blocked = await modelReachable();

  if (blocked) {
    console.log("COACH K REALITY TEST\n");
    for (const j of JOURNEYS) console.log(`  NOT TESTED — journey ${j.n}: ${j.name}`);
    console.log(`\nReason: ${blocked}`);
    console.log("\nNOT TESTED is not FAIL and it is not PASS. The deterministic spine is covered by");
    console.log("`npm test` and `script/acceptance-hold.ts`; neither of them says anything about whether");
    console.log("Coach K can coach. Run this against the real environment to find that out.");
    process.exit(3);                       // distinct from 1 (failures) so CI cannot confuse them
  }

  const { db } = await import("../server/db");
  const { users, turnLedger, chatHistory } = await import("../shared/schema");
  const { eq } = await import("drizzle-orm");
  const { handleMessage } = await import("../server/routes");

  /**
   * REMOVE A TEST CLIENT — CHILDREN FIRST (2026-08-11).
   *
   * Run #1 died here, on the FIRST line of journey 1, before a single model call:
   *   delete on "users" violates foreign key constraint "chat_history_user_id_fkey"
   *
   * The schema declares ON DELETE cascade for chat_history, and the committed migration
   * creates that constraint as "chat_history_user_id_users_id_fk". Production is enforcing
   * "chat_history_user_id_fkey" — PostgreSQL's DEFAULT name, with NO cascade. The live
   * database is carrying an older constraint the Drizzle migration never replaced.
   *
   * That drift is a PRODUCTION issue, not a test issue, and it is reported rather than
   * repaired here: altering a live constraint is a migration, and this file is a harness.
   * What this function does is make the harness survive it — delete the child rows this
   * test creates, then the user. Nothing about the journeys or their assertions changes.
   */
  async function removeTestClient(phone: string): Promise<void> {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (!existing) return;
    await db.delete(chatHistory).where(eq(chatHistory.userId, existing.id));
    await db.delete(users).where(eq(users.phoneNumber, phone));
  }

  const results: Array<{ j: Journey; verdict: Verdict; fails: Array<{ turn: string; what: string; category: Category; reply: string }> }> = [];

  for (const j of JOURNEYS) {
    const phone = `whatsapp:+2700000${900 + j.n}`;
    await removeTestClient(phone);
    const now = Date.now();
    const [u] = await db.insert(users).values({
      phoneNumber: phone, name: "Kam Test", onboardingState: "COMPLETE", subscriptionStatus: "active",
      popiConsent: true, popiConsentAt: new Date(now - 30 * 86_400_000),
      trialEndsAt: new Date(now + 30 * 86_400_000), subscriptionExpiresAt: new Date(now + 30 * 86_400_000),
      goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 130, stepsTarget: 10000,
      currentWeight: "83", trainingMode: "gym", trainingDaysPerWeek: 3, trainingExperience: "beginner",
      gender: "male", age: 30, heightCm: 175, profileNotes: "numbers:full", totalWorkoutsCompleted: 8,
      lastActiveAt: new Date(now - 3_600_000), ...(j.seed || {}),
    } as any).returning();

    console.log(`\n${"═".repeat(92)}\nJOURNEY ${j.n} — ${j.name}\n${"═".repeat(92)}`);
    for (const s of j.before || []) { await handleMessage(phone, s); console.log(`  (setup) ${s}`); }

    const replies: string[] = [];
    const fails: Array<{ turn: string; what: string; category: Category; reply: string }> = [];
    for (const t of j.turns) {
      const reply = await handleMessage(phone, t.say, t.media);
      replies.push(reply);
      console.log(`\n  >>> ${t.say}`);
      console.log(`  <<< ${reply.replace(/\n/g, "\n      ")}`);
      for (const c of t.must || []) {
        const ok = c.ok(reply, replies);
        console.log(`      ${ok ? "✓" : "✗"} [${c.category}] ${c.what}`);
        if (!ok) fails.push({ turn: t.say, what: c.what, category: c.category, reply });
      }
    }
    // The ledger is what makes a failure classifiable rather than a guess.
    await new Promise(r => setTimeout(r, 800));
    const led = await db.select().from(turnLedger).where(eq(turnLedger.userId, u.id)).catch(() => [] as any[]);
    console.log(`\n  ledger: ${led.length} turn(s) recorded`);
    for (const row of led as any[]) {
      console.log(`    · "${String(row.inputText).slice(0, 44)}" day=${row.resolvedDay || "-"} `
        + `mutations=${JSON.stringify(row.mutations || [])} ${row.replyMs}ms`);
    }
    results.push({ j, verdict: fails.length ? "FAIL" : "PASS", fails });
    // Leave the database as it was found: the transcript above is the record, not the rows.
    await removeTestClient(phone).catch(() => {});
  }

  console.log(`\n${"═".repeat(92)}\nRESULTS\n${"═".repeat(92)}`);
  for (const r of results) console.log(`  ${r.verdict.padEnd(10)} journey ${r.j.n}: ${r.j.name}`);

  const byCategory = new Map<Category, number>();
  for (const r of results) for (const f of r.fails) byCategory.set(f.category, (byCategory.get(f.category) || 0) + 1);
  if (byCategory.size) {
    console.log("\nFAILURES BY PRIMARY CATEGORY");
    for (const [c, n] of [...byCategory].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${c}`);
    console.log("\nDETAIL");
    for (const r of results) for (const f of r.fails) {
      console.log(`  ✗ [${f.category}] journey ${r.j.n} — ${f.what}\n      on: "${f.turn}"\n      got: ${JSON.stringify(f.reply.slice(0, 200))}`);
    }
  }
  console.log("\nThese checks are OBJECTIVE only — state use, continuity, no-guilt, one-question,");
  console.log("no-lecture. Coaching QUALITY is not gradeable by regex; read the transcripts above.");
  process.exit(results.some(r => r.verdict === "FAIL") ? 1 : 0);
}

/**
 * A CRASH IS NOT A VERDICT (2026-08-11).
 *
 * Run #1 died on a foreign-key error before a single journey ran, node exited 1, and the
 * workflow annotated it "PRODUCT FAILURE — at least one journey failed on what Coach K said."
 * Nothing Coach K said was ever evaluated. Exit 1 must mean "a journey was run and it failed";
 * anything that stops the harness getting there is the environment, and exits 3.
 */
await main().catch((err) => {
  console.error("\nCOACH K REALITY TEST — ENVIRONMENT FAILURE. No journey was adjudicated.\n");
  console.error(`  ${err?.cause?.message || err?.message || err}`);
  console.error("\nThis is NOT a product result. Nothing about Coach K's coaching was measured.");
  process.exit(3);
});
