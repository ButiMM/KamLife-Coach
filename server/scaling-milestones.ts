/**
 * SCALING RADAR — the founder's milestone playbook.
 *
 * Every threshold where growth affects margins, infrastructure, compliance or
 * team gets a concrete action list BEFORE it hits. Surfaced daily on the admin
 * dashboard: the next milestone shows an "approaching" alert from 80% of its
 * threshold. Deterministic, zero GPT cost — pure config + one count query.
 *
 * Keep actions honest and specific. Owners: "you" (founder, dashboards/hiring/
 * Railway clicks), "claude" (code changes — say the word when flagged),
 * "together" (a decision, then code).
 */

export interface MilestoneAction {
  owner: "you" | "claude" | "together";
  action: string;
}

export interface Milestone {
  clients: number;
  title: string;
  mrrZar: number; // clients × R199 — shown so every mark reads as money, not vanity
  why: string;
  actions: MilestoneAction[];
}

export type MilestoneStatus = "passed" | "approaching" | "upcoming";

export interface EvaluatedMilestone extends Milestone {
  status: MilestoneStatus;
  progressPct: number; // 0-100 toward this milestone
}

const R = 199;

export const MILESTONES: Milestone[] = [
  {
    clients: 100,
    title: "First real cohort",
    mrrZar: 100 * R,
    why: "The system is loafing at this size — the risks are habits, not infrastructure.",
    actions: [
      { owner: "you", action: "Check the WhatsApp quality rating in Twilio/Meta weekly — every future tier upgrade depends on it staying High." },
      { owner: "you", action: "Confirm Railway is on a paid plan and glance at CPU/memory graphs once a week." },
      { owner: "together", action: "Weekly 5-min PayFast reconciliation: payments received vs active subscriptions on this dashboard." },
      { owner: "claude", action: "Nothing structural. Watch GPT cost/client on this card — healthy is under ~R8/client/month." },
    ],
  },
  {
    clients: 250,
    title: "WhatsApp tier & tax runway",
    mrrZar: 250 * R,
    why: "Meta messaging tiers and VAT both need lead time — start before you need them.",
    actions: [
      { owner: "you", action: "Verify your Meta messaging tier reached 1,000 unique users/day (WhatsApp Manager). Sustained volume + High quality drives the auto-upgrade; a quality drop freezes you." },
      { owner: "you", action: "Book an accountant: VAT registration becomes MANDATORY at R1m annual turnover — you hit that around 420 clients. Register on your terms, not SARS's." },
      { owner: "you", action: "Escalations tab becomes a daily habit — crisis SLAs are now a real duty of care." },
    ],
  },
  {
    clients: 500,
    title: "Database & margin checkpoint",
    mrrZar: 500 * R,
    why: "First infra tuning + the margin curve becomes visible enough to manage.",
    actions: [
      { owner: "you", action: "VAT registration DONE by now (mandatory ~420 clients / R1m turnover)." },
      { owner: "you", action: "Railway → Variables → DB_POOL_MAX=40 (2-minute change)." },
      { owner: "claude", action: "Margin review: GPT spend should be under ~5-8% of MRR. If this card shows higher — say the word, Claude hunts the waste." },
      { owner: "you", action: "First hire decision: part-time VA (2-3 h/day) for escalations + billing questions." },
    ],
  },
  {
    clients: 1000,
    title: "Operations become real",
    mrrZar: 1000 * R,
    why: "Morning fan-out, support volume and Meta's 10k tier all need action here.",
    actions: [
      { owner: "you", action: "Railway → SCHEDULER_SEND_RATE_PER_SEC=20 and DB_POOL_MAX=50; upgrade the Postgres plan (RAM + storage)." },
      { owner: "you", action: "WhatsApp 10,000/day tier on the horizon — business verification must be complete, quality High for weeks." },
      { owner: "you", action: "Part-time human support is now mandatory, not optional." },
      { owner: "claude", action: "Second Railway replica (the leader lock already makes this safe) + load-test the morning fan-out. Tell Claude at ~800 clients." },
    ],
  },
  {
    clients: 2500,
    title: "Data volume & first FTE",
    mrrZar: 2500 * R,
    why: "Chat history passes ~10-20M rows; support outgrows a VA.",
    actions: [
      { owner: "claude", action: "Chat-history archival job (move >90-day rows to cold storage) — keeps every query fast." },
      { owner: "you", action: "Full-time support hire #1. Written SLAs: crisis <15 min (escalations tab), billing <24 h." },
      { owner: "together", action: "Model-mix audit + OpenAI volume/enterprise terms — the API bill is real money now." },
    ],
  },
  {
    clients: 10000,
    title: "Architecture shift",
    mrrZar: 10000 * R,
    why: "This is where the queue/worker advice becomes TRUE — not before.",
    actions: [
      { owner: "claude", action: "Split the scheduler into a dedicated worker service with a real job queue; add WhatsApp sender-number pool for fan-out throughput." },
      { owner: "you", action: "Negotiate Twilio volume pricing (or compare direct Meta Cloud API economics). Hire: 2-3 support + a bookkeeper." },
      { owner: "you", action: "WhatsApp 100k/unlimited tier (automatic with sustained quality + volume history)." },
      { owner: "together", action: "Monthly margin council: GPT + Twilio + infra as % of MRR — target under 15%." },
    ],
  },
  {
    clients: 50000,
    title: "Company, not project",
    mrrZar: 50000 * R,
    why: "Headcount, compliance and disaster-recovery become board-level items.",
    actions: [
      { owner: "you", action: "Ops lead + 5-8 support; dedicated POPIA/compliance officer; accountant becomes CFO-lite." },
      { owner: "claude", action: "Dedicated/managed Postgres migration + read replicas + real observability (alerts to your phone, not logs)." },
      { owner: "together", action: "Disaster-recovery drill: rehearse restore-from-backup, document it, repeat quarterly." },
    ],
  },
  {
    clients: 100000,
    title: "Scale-up",
    mrrZar: 100000 * R,
    why: "Platform relationships and security posture, not code, are the constraints.",
    actions: [
      { owner: "you", action: "Direct Meta BSP relationship; legal counsel on retainer; external security audit/pentest." },
      { owner: "claude", action: "Analytics warehouse; partitioning plan for hot tables; 24/7 on-call tooling." },
    ],
  },
];

/** A milestone alerts from 80% of its threshold. */
export const APPROACH_RATIO = 0.8;

export function evaluateScaling(activeClients: number): EvaluatedMilestone[] {
  return MILESTONES.map((mst) => {
    const progressPct = Math.min(100, Math.round((activeClients / mst.clients) * 100));
    const status: MilestoneStatus =
      activeClients >= mst.clients ? "passed"
      : activeClients >= mst.clients * APPROACH_RATIO ? "approaching"
      : "upcoming";
    return { ...mst, status, progressPct };
  });
}

/** The first not-yet-passed milestone — what the dashboard's progress bar points at. */
export function nextMilestone(activeClients: number): EvaluatedMilestone | null {
  return evaluateScaling(activeClients).find(mm => mm.status !== "passed") || null;
}
