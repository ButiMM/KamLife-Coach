import type { Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { users, workoutLogs, stepLogs, chatHistory, mealLogs, weightLogs, escalations } from "../../shared/schema";
import { eq, desc, asc, and, gte, lt, sql, count } from "drizzle-orm";
import { PRICING, calculateMRR, calculateARPU, calculateLTV, calculateTrialConversion } from "../../shared/pricing";
import { deliveryStats } from "../scheduler";

export function registerCoachRoutes(app: Express): void {
// ============================================================
// COACH ADMIN DASHBOARD — GET /coach (auth via x-dashboard-key header only)
// ============================================================
app.get("/coach", async (req: any, res: any) => {
  const key = (req.headers["x-dashboard-key"] as string) || "";
  const dashKey = process.env.COACH_DASHBOARD_KEY;
  if (!dashKey) return res.status(503).send("<h1>Dashboard not configured — set COACH_DASHBOARD_KEY</h1>");
  let authorized = false;
  try { authorized = key.length === dashKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(dashKey)); } catch { authorized = false; }
  if (!authorized) {
    return res.status(401).send("<h1>Unauthorized</h1>");
  }
  try {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const fourteenDaysAgo = new Date(now - 14 * 86400000);

    // Run all queries in parallel
    const [
      totalUsersRows,
      activeRows,
      silentSevenRows,
      silentFourteenRows,
      totalWorkoutsRows,
      totalStepsRows,
      allCompleteUsers,
      weekThreeUsers,
      newThisWeekUsers,
    ] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.onboardingState, "COMPLETE")),
      db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), gte(users.lastActiveAt, sevenDaysAgo))),
      db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, sevenDaysAgo))),
      db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, fourteenDaysAgo))),
      db.select({ count: sql<number>`COUNT(*)` }).from(workoutLogs),
      db.select({ total: sql<string>`COALESCE(SUM(steps), 0)` }).from(stepLogs),
      db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, sevenDaysAgo))).orderBy(asc(users.lastActiveAt)).limit(200),
      db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), eq(users.programmeWeek, 3))).limit(200),
      db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), gte(users.createdAt, sevenDaysAgo))).orderBy(desc(users.createdAt)).limit(100),
    ]);

    // Goal/budget breakdown — project only needed columns, reuse allCompleteUsers where possible
    const allComplete = await db.select({
      goalType: users.goalType,
      budgetLevel: users.budgetLevel,
      subscriptionStatus: users.subscriptionStatus,
      totalWorkoutsCompleted: users.totalWorkoutsCompleted,
      lastActiveAt: users.lastActiveAt,
    }).from(users).where(eq(users.onboardingState, "COMPLETE"));
    const goalCounts: Record<string, number> = {};
    const budgetCounts: Record<string, number> = {};

    // Funnel total via the already-fetched count row
    const funnelTotal = Number((totalUsersRows[0] as any)?.count ?? 0);
    const funnelOnboarded = allComplete.length;
    const funnelFirstWorkout = allComplete.filter(u => (u.totalWorkoutsCompleted || 0) >= 1).length;
    const funnelPaying = allComplete.filter(u => u.subscriptionStatus === "active").length;
    const funnelActiveWeek = allComplete.filter(u => u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) < 7 * 86400000).length;
    const estimatedMRR = calculateMRR(funnelPaying);
    for (const u of allComplete) {
      const g = u.goalType || "unknown";
      goalCounts[g] = (goalCounts[g] || 0) + 1;
      const b = u.budgetLevel || "unknown";
      budgetCounts[b] = (budgetCounts[b] || 0) + 1;
    }

    const totalClients = Number((totalUsersRows[0] as any)?.count ?? 0);
    const activeCount = Number((activeRows[0] as any)?.count ?? 0);
    const silentSeven = Number((silentSevenRows[0] as any)?.count ?? 0);
    const silentFourteen = Number((silentFourteenRows[0] as any)?.count ?? 0);
    const totalWorkouts = Number((totalWorkoutsRows[0] as any)?.count ?? 0);
    const totalSteps = Number((totalStepsRows[0] as any)?.total ?? 0);
    const timestamp = new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });

    const fmtDate = (d: any) => {
      if (!d) return "Never";
      const dt = new Date(d);
      return dt.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
    };
    const maskPhone = (p: string | null | undefined) => {
      if (!p) return "—";
      const digits = p.replace(/\D/g, "");
      return "****" + digits.slice(-4);
    };
    const daysSince = (d: any) => {
      if (!d) return 999;
      return Math.floor((now - new Date(d).getTime()) / 86400000);
    };

    const atRiskRows = allCompleteUsers.filter((u: any) => daysSince(u.lastActiveAt) >= 2).map((u: any) => {
      const days = daysSince(u.lastActiveAt);
      const rowBg = days >= 14 ? "#3b0a0a" : days >= 5 ? "#2a1a0a" : "#1a2a1a";
      const badgeColor = days >= 14 ? "#ef4444" : days >= 5 ? "#f97316" : "#f59e0b";
      const riskLabel = days >= 14 ? "SEVERE" : days >= 5 ? "HIGH" : "WARNING";
      const injuries = u.injuries || u.medicalConditions || "";
      const ph = u.phoneNumber.replace(/'/g, "\\'");
      return `
        <tr style="background:${rowBg}; border-bottom: 1px solid #2d3748;">
          <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
          <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
          <td style="padding:10px 12px;">
            <span style="background:${badgeColor}; color:#000; border-radius:4px; padding:2px 8px; font-size:12px; font-weight:700;">${riskLabel}</span>
            <span style="color:#9ca3af; font-size:11px; margin-left:6px;">${fmtDate(u.lastActiveAt)} (${days}d ago)</span>
          </td>
          <td style="padding:10px 12px; color:#22c55e; font-weight:600; text-align:center;">${u.programmeWeek ?? "—"}</td>
          <td style="padding:10px 12px; color:#d1d5db; text-align:center;">${u.totalWorkoutsCompleted ?? 0}</td>
          <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
          <td style="padding:8px 6px; white-space:nowrap;">
            <button onclick="intervene('${ph}','checkin',this)" style="background:#3b82f6; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Check-in</button>
            <button onclick="intervene('${ph}','workout',this)" style="background:#22c55e; color:#000; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Workout</button>
            <button onclick="intervene('${ph}','motivation',this)" style="background:#a78bfa; color:#000; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Motivate</button>
          </td>
        </tr>`;
    }).join("");

    const weekThreeRows = weekThreeUsers.map((u: any) => `
        <tr style="background:#0f1f2f; border-bottom: 1px solid #2d3748;">
          <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
          <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
          <td style="padding:10px 12px; color:#d1d5db;">${fmtDate(u.lastActiveAt)}</td>
          <td style="padding:10px 12px; color:#d1d5db; text-align:center;">${u.totalWorkoutsCompleted ?? 0}</td>
          <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
        </tr>`).join("");

    const newThisWeekRows = newThisWeekUsers.map((u: any) => `
        <tr style="background:#0a1a0f; border-bottom: 1px solid #2d3748;">
          <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
          <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
          <td style="padding:10px 12px; color:#22c55e;">${fmtDate(u.createdAt)}</td>
          <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
          <td style="padding:10px 12px; color:#d1d5db; font-size:13px;">${(u as any).budgetTier || "—"}</td>
        </tr>`).join("");

    const goalBreakdownHtml = Object.entries(goalCounts).map(([g, c]) =>
      `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #2d3748;">
        <span style="color:#d1d5db; text-transform:capitalize;">${g.replace(/_/g, " ")}</span>
        <span style="color:#22c55e; font-weight:700;">${c}</span>
      </div>`
    ).join("");

    const budgetBreakdownHtml = Object.entries(budgetCounts).map(([b, c]) =>
      `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #2d3748;">
        <span style="color:#d1d5db; text-transform:capitalize;">${b.replace(/_/g, " ")}</span>
        <span style="color:#22c55e; font-weight:700;">${c}</span>
      </div>`
    ).join("");

    // Pre-compute funnel HTML to avoid nested template literal issues
    const funnelSteps = [
      { label: "Signed Up", count: funnelTotal, color: "#6b7280" },
      { label: "Onboarding Complete", count: funnelOnboarded, color: "#3b82f6" },
      { label: "First Workout Done", count: funnelFirstWorkout, color: "#a78bfa" },
      { label: "Paying", count: funnelPaying, color: "#22c55e" },
      { label: "Active This Week", count: funnelActiveWeek, color: "#4ade80" },
    ];
    const funnelHtml = funnelSteps.map(step => {
      const pct = funnelTotal > 0 ? Math.round(step.count / funnelTotal * 100) : 0;
      return '<div style="margin-bottom:8px;">' +
        '<div style="display:flex; justify-content:space-between; margin-bottom:3px;">' +
        '<span style="color:#d1d5db; font-size:13px;">' + step.label + '</span>' +
        '<span style="color:#9ca3af; font-size:13px;">' + step.count + ' (' + pct + '%)</span>' +
        '</div>' +
        '<div style="background:#1f2937; border-radius:4px; height:20px; overflow:hidden; border:1px solid #374151;">' +
        '<div style="background:' + step.color + '; height:100%; width:' + pct + '%; border-radius:3px; transition:width 0.3s;"></div>' +
        '</div></div>';
    }).join("");

    // Pre-compute delivery rate
    const deliveryTotal = deliveryStats.sent + deliveryStats.failed;
    const deliveryRate = deliveryTotal > 0 ? Math.round(deliveryStats.sent / deliveryTotal * 100) : 100;
    const deliveryRateColor = deliveryTotal > 0 ? (deliveryStats.failed / deliveryTotal > 0.1 ? '#ef4444' : '#22c55e') : '#4b5563';

    const tableStyle = `width:100%; border-collapse:collapse; font-size:14px;`;
    const thStyle = `padding:10px 12px; text-align:left; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280; background:#0d1117; border-bottom:2px solid #22c55e;`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>KamLife Coach Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111827; color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 16px; }
  .card { background: #1f2937; border-radius: 12px; padding: 20px; border: 1px solid #374151; }
  .stat-value { font-size: 2.2rem; font-weight: 800; color: #22c55e; line-height: 1; }
  .stat-label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 6px; }
  .section-title { font-size: 16px; font-weight: 700; color: #22c55e; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .section { margin-bottom: 24px; }
  .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #374151; }
  @media (max-width: 768px) {
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    .grid-3 { grid-template-columns: 1fr; }
  }
  @media (max-width: 480px) {
    .grid-4 { grid-template-columns: 1fr 1fr; }
    .stat-value { font-size: 1.6rem; }
  }
</style>
</head>
<body>
<div style="background:#0d1117; border-bottom:2px solid #22c55e; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
  <div>
    <div style="font-size:20px; font-weight:800; color:#22c55e; letter-spacing:-0.02em;">KamLife Coach</div>
    <div style="font-size:12px; color:#6b7280; margin-top:2px;">Coach Dashboard — Confidential</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:12px; color:#9ca3af;">Last updated</div>
    <div style="font-size:13px; color:#d1d5db; font-weight:600;">${timestamp} SAST</div>
  </div>
</div>

<div class="container">

  <!-- STATS ROW 1 -->
  <div style="margin-top:20px; margin-bottom:16px; font-size:11px; color:#4b5563; text-transform:uppercase; letter-spacing:0.12em; font-weight:700;">Client Overview</div>
  <div class="grid-4">
    <div class="card" style="border-color:#22c55e44;">
      <div class="stat-value">${totalClients}</div>
      <div class="stat-label">Total Clients</div>
    </div>
    <div class="card" style="border-color:#22c55e44;">
      <div class="stat-value" style="color:#4ade80;">${activeCount}</div>
      <div class="stat-label">Active (7 days)</div>
    </div>
    <div class="card" style="border-color:#f59e0b44;">
      <div class="stat-value" style="color:#f59e0b;">${silentSeven}</div>
      <div class="stat-label">Silent (7d+)</div>
    </div>
    <div class="card" style="border-color:#ef444444;">
      <div class="stat-value" style="color:#ef4444;">${silentFourteen}</div>
      <div class="stat-label">Silent (14d+)</div>
    </div>
  </div>

  <!-- STATS ROW 2 -->
  <div class="grid-3">
    <div class="card">
      <div class="stat-value" style="color:#a78bfa;">${totalWorkouts.toLocaleString()}</div>
      <div class="stat-label">Total Workouts Logged</div>
    </div>
    <div class="card">
      <div class="stat-value" style="color:#38bdf8;">${Number(totalSteps).toLocaleString()}</div>
      <div class="stat-label">Total Steps Logged</div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-bottom:8px; font-size:12px;">Goal Breakdown</div>
      ${goalBreakdownHtml || '<div style="color:#4b5563; font-size:13px;">No data</div>'}
      <div style="margin-top:10px; border-top:1px solid #374151; padding-top:10px;">
        <div style="font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; font-weight:700;">Budget Tiers</div>
        ${budgetBreakdownHtml || '<div style="color:#4b5563; font-size:13px;">No data</div>'}
      </div>
    </div>
  </div>

  <!-- REVENUE + FUNNEL -->
  <div style="margin-bottom:16px; font-size:11px; color:#4b5563; text-transform:uppercase; letter-spacing:0.12em; font-weight:700;">Revenue & Funnel</div>
  <div class="grid-4">
    <div class="card" style="border-color:#22c55e44;">
      <div class="stat-value" style="color:#22c55e;">R${estimatedMRR.toLocaleString()}</div>
      <div class="stat-label">Estimated MRR</div>
    </div>
    <div class="card" style="border-color:#22c55e44;">
      <div class="stat-value" style="color:#4ade80;">${funnelPaying}</div>
      <div class="stat-label">Paying Clients</div>
    </div>
    <div class="card" style="border-color:#3b82f644;">
      <div class="stat-value" style="color:#38bdf8;">${funnelFirstWorkout}</div>
      <div class="stat-label">Completed 1+ Workout</div>
    </div>
    <div class="card" style="border-color:#a78bfa44;">
      <div class="stat-value" style="color:#a78bfa;">${funnelActiveWeek}</div>
      <div class="stat-label">Active This Week</div>
    </div>
  </div>

  <!-- DELIVERY HEALTH -->
  <div class="grid-3" style="margin-bottom:16px;">
    <div class="card" style="border-color:${deliveryStats.failed > 0 ? '#ef444444' : '#22c55e44'};">
      <div class="stat-value" style="color:${deliveryStats.failed > 0 ? '#ef4444' : '#22c55e'};">${deliveryStats.sent}</div>
      <div class="stat-label">Messages Sent Today</div>
    </div>
    <div class="card" style="border-color:${deliveryStats.failed > 0 ? '#ef444444' : '#37415144'};">
      <div class="stat-value" style="color:${deliveryStats.failed > 0 ? '#ef4444' : '#4b5563'};">${deliveryStats.failed}</div>
      <div class="stat-label">Delivery Failures Today</div>
    </div>
    <div class="card">
      <div class="stat-value" style="color:${deliveryRateColor};">${deliveryRate}%</div>
      <div class="stat-label">Delivery Rate</div>
    </div>
  </div>

  <!-- PINNED NEXT ACTIONS -->
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#8b5cf6; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Actions</span>
      <span class="section-title" style="margin-bottom:0;">Pinned Next Actions</span>
    </div>
    <div id="next-actions-container" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading actions...</div>
  </div>

  <!-- CONVERSION FUNNEL -->
  <div class="card" style="margin-bottom:16px; padding:20px;">
    <div class="section-title" style="margin-bottom:16px;">Conversion Funnel</div>
    ${funnelHtml}
  </div>

  <!-- AT RISK -->
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#ef4444; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">At Risk</span>
      <span class="section-title" style="margin-bottom:0;">At-Risk Clients (${allCompleteUsers.filter((u: any) => daysSince(u.lastActiveAt) >= 2).length} clients)</span>
    </div>
    ${allCompleteUsers.length === 0
      ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">All clients active — no at-risk clients right now.</div>`
      : `<div class="table-wrap">
        <table style="${tableStyle}">
          <thead>
            <tr>
              <th style="${thStyle}">Name</th>
              <th style="${thStyle}">Phone</th>
              <th style="${thStyle}">Last Active</th>
              <th style="${thStyle} text-align:center;">Week</th>
              <th style="${thStyle} text-align:center;">Workouts</th>
              <th style="${thStyle}">Goal</th>
              <th style="${thStyle}">Actions</th>
            </tr>
          </thead>
          <tbody>${atRiskRows}</tbody>
        </table>
      </div>`
    }
  </div>

  <!-- WEEK 3 DANGER ZONE -->
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Week 3</span>
      <span class="section-title" style="margin-bottom:0;">Danger Zone (${weekThreeUsers.length} clients)</span>
    </div>
    ${weekThreeUsers.length === 0
      ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">No clients currently in Week 3.</div>`
      : `<div class="table-wrap">
        <table style="${tableStyle}">
          <thead>
            <tr>
              <th style="${thStyle}">Name</th>
              <th style="${thStyle}">Phone</th>
              <th style="${thStyle}">Last Active</th>
              <th style="${thStyle} text-align:center;">Workouts</th>
              <th style="${thStyle}">Goal</th>
            </tr>
          </thead>
          <tbody>${weekThreeRows}</tbody>
        </table>
      </div>`
    }
  </div>

  <!-- NEW THIS WEEK -->
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">New</span>
      <span class="section-title" style="margin-bottom:0;">New This Week (${newThisWeekUsers.length} clients)</span>
    </div>
    ${newThisWeekUsers.length === 0
      ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">No new clients joined this week.</div>`
      : `<div class="table-wrap">
        <table style="${tableStyle}">
          <thead>
            <tr>
              <th style="${thStyle}">Name</th>
              <th style="${thStyle}">Phone</th>
              <th style="${thStyle}">Joined</th>
              <th style="${thStyle}">Goal</th>
              <th style="${thStyle}">Budget</th>
            </tr>
          </thead>
          <tbody>${newThisWeekRows}</tbody>
        </table>
      </div>`
    }
  </div>

</div>

<!-- ESCALATION INBOX -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#ef4444; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Inbox</span>
      <span class="section-title" style="margin-bottom:0;">Escalation Inbox</span>
      <select id="escFilter" onchange="loadEscalations()" style="margin-left:auto; background:#111827; border:1px solid #374151; border-radius:6px; padding:6px 10px; color:#f9fafb; font-size:12px;">
        <option value="open">Open</option>
        <option value="claimed">Claimed</option>
        <option value="resolved">Resolved</option>
        <option value="all">All</option>
      </select>
    </div>
    <div id="escWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading escalations...</div>
  </div>
</div>

<!-- COHORT ANALYTICS -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#a78bfa; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Cohorts</span>
      <span class="section-title" style="margin-bottom:0;">Signup Cohort Analytics</span>
    </div>
    <div id="cohortWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading cohort data...</div>
  </div>
</div>

<!-- A/B EXPERIMENTS -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">A/B</span>
      <span class="section-title" style="margin-bottom:0;">Message Experiments</span>
      <button onclick="showNewExperiment()" style="margin-left:auto; background:#f59e0b; color:#000; border:none; border-radius:6px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer;">+ New</button>
    </div>
    <div id="newExpForm" style="display:none; margin-bottom:12px;" class="card">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
        <input id="expName" placeholder="Experiment name" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px;" />
        <select id="expType" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px;">
          <option value="morning_checkin">Morning Check-in</option>
          <option value="nudge">Nudge / Re-engagement</option>
          <option value="workout_reminder">Workout Reminder</option>
          <option value="food_reminder">Food Logging Reminder</option>
          <option value="weekly_checkin">Weekly Check-in</option>
        </select>
      </div>
      <textarea id="expA" rows="2" placeholder="Variant A (control) message template..." style="width:100%; background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px; margin-bottom:6px; resize:vertical;"></textarea>
      <textarea id="expB" rows="2" placeholder="Variant B (challenger) message template..." style="width:100%; background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px; margin-bottom:8px; resize:vertical;"></textarea>
      <div style="display:flex; gap:8px;">
        <button onclick="createExperiment()" style="background:#f59e0b; color:#000; border:none; border-radius:6px; padding:8px 16px; font-size:13px; font-weight:700; cursor:pointer;">Create</button>
        <button onclick="document.getElementById('newExpForm').style.display='none'" style="background:#374151; color:#9ca3af; border:none; border-radius:6px; padding:8px 16px; font-size:13px; cursor:pointer;">Cancel</button>
      </div>
    </div>
    <div id="abWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading experiments...</div>
  </div>
</div>

<!-- CLIENT TIMELINE -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#38bdf8; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Timeline</span>
      <span class="section-title" style="margin-bottom:0;">Client Timeline (30 days)</span>
    </div>
    <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
      <input id="timelinePhone" type="text" placeholder="Enter phone number e.g. +27..." style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
      <button onclick="loadTimeline()" style="background:#38bdf8; color:#000; border:none; border-radius:6px; padding:10px 20px; font-size:14px; font-weight:700; cursor:pointer;">Load</button>
    </div>
    <div id="timelineWrap" style="display:none;">
      <div id="timelineSummary" class="card" style="margin-bottom:12px;"></div>
      <div id="timelineEvents" class="table-wrap"></div>
    </div>
  </div>
</div>

<!-- NPS SUMMARY -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">NPS</span>
      <span class="section-title" style="margin-bottom:0;">Client Satisfaction</span>
    </div>
    <div id="npsWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading NPS data...</div>
  </div>
</div>

<!-- BROADCAST -->
<div class="container">
  <div class="section">
    <div class="section-title">Quick Broadcast</div>
    <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <input id="broadcastMsg" type="text" placeholder="Type message to send..." style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
      <select id="broadcastFilter" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:13px;">
        <option value="all">All Clients</option>
        <option value="active">Active Only</option>
        <option value="atrisk">At-Risk Only</option>
      </select>
      <button onclick="sendBroadcast()" style="background:#22c55e; color:#000; border:none; border-radius:6px; padding:10px 20px; font-size:14px; font-weight:700; cursor:pointer;">Send</button>
      <span id="broadcastStatus" style="color:#9ca3af; font-size:12px;"></span>
    </div>
  </div>
</div>

<!-- KPI METRICS -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">KPIs</span>
      <span class="section-title" style="margin-bottom:0;">Business Metrics (30 days)</span>
    </div>
    <div id="kpiWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading KPI data...</div>
  </div>
</div>

<!-- REVENUE -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Revenue</span>
      <span class="section-title" style="margin-bottom:0;">Revenue Dashboard</span>
    </div>
    <div id="revenueWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading revenue data...</div>
  </div>
</div>

<!-- CLIENT SEARCH -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#38bdf8; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Search</span>
      <span class="section-title" style="margin-bottom:0;">Client Search</span>
    </div>
    <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
      <input id="clientSearch" type="text" placeholder="Search by name or phone..." onkeyup="searchClients()" style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
    </div>
    <div id="searchResults" style="display:none;" class="table-wrap"></div>
  </div>
</div>

<!-- WEEKLY REPORT -->
<div class="container">
  <div class="section">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <span style="background:#a78bfa; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Report</span>
      <span class="section-title" style="margin-bottom:0;">Weekly Coach Report</span>
      <button onclick="loadWeeklyReport()" style="margin-left:auto; background:#a78bfa; color:#000; border:none; border-radius:6px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer;">Generate</button>
    </div>
    <div id="weeklyReportWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Click Generate to load weekly report.</div>
  </div>
</div>

<div style="text-align:center; padding:20px; color:#374151; font-size:12px; border-top:1px solid #1f2937; margin-top:8px;">
  KamLife Coach Admin Dashboard — Confidential &nbsp;|&nbsp; Refresh to update
</div>

<script>
  const DASH_KEY = "${key}";
  async function intervene(phone, type, btn) {
    btn.disabled = true;
    btn.textContent = "...";
    try {
      const res = await fetch("/api/dashboard/intervene", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ phone, type })
      });
      const data = await res.json();
      if (data.success) {
        btn.textContent = "Sent ✓";
        btn.style.background = "#065f46";
        btn.style.color = "#fff";
      } else {
        btn.textContent = "Failed";
        btn.style.background = "#7f1d1d";
      }
    } catch {
      btn.textContent = "Error";
      btn.style.background = "#7f1d1d";
    }
  }
  async function sendBroadcast() {
    const msg = document.getElementById("broadcastMsg").value.trim();
    const filter = document.getElementById("broadcastFilter").value;
    const status = document.getElementById("broadcastStatus");
    if (!msg) { status.textContent = "Type a message first"; return; }
    if (!confirm("Send to " + filter + " clients?")) return;
    status.textContent = "Sending...";
    try {
      const res = await fetch("/api/dashboard/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ message: msg, filter })
      });
      const data = await res.json();
      status.textContent = "Sent: " + data.sent + " | Failed: " + data.failed;
      document.getElementById("broadcastMsg").value = "";
    } catch {
      status.textContent = "Error sending";
    }
  }

  // ---- ESCALATION INBOX ----
  async function loadEscalations() {
    const filter = document.getElementById("escFilter").value;
    const wrap = document.getElementById("escWrap");
    wrap.innerHTML = '<div style="color:#9ca3af;">Loading...</div>';
    try {
      const res = await fetch("/api/dashboard/escalations?status=" + filter, { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      if (!data.escalations || data.escalations.length === 0) {
        wrap.innerHTML = '<div style="color:#4b5563; padding:20px; text-align:center;">No ' + filter + ' escalations.</div>';
        return;
      }
      const prioColors = { urgent: "#ef4444", high: "#f59e0b", normal: "#38bdf8", low: "#6b7280" };
      let rows = "";
      for (const e of data.escalations) {
        const created = new Date(e.createdAt).toLocaleDateString("en-ZA", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
        const slaColor = e.slaBreach ? "#ef4444" : "#22c55e";
        const slaText = e.slaBreach ? "BREACHED" : e.slaRemaining !== null ? e.slaRemaining + "m left" : "—";
        const actions = e.status === "open"
          ? '<button onclick="claimEsc(' + e.id + ', this)" style="background:#38bdf8; color:#000; border:none; border-radius:4px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer;">Claim</button>'
          : e.status === "claimed"
          ? '<button onclick="resolveEsc(' + e.id + ')" style="background:#22c55e; color:#000; border:none; border-radius:4px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer;">Resolve</button>'
          : '<span style="color:#4b5563; font-size:11px;">' + (e.resolution || "Done") + '</span>';
        rows += '<tr>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937;"><span style="color:' + (prioColors[e.priority] || "#9ca3af") + '; font-weight:700; font-size:11px; text-transform:uppercase;">' + e.priority + '</span></td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600; font-size:13px;">' + (e.userName || "Unknown") + '</td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#9ca3af; font-size:12px;">' + (e.userPhone || "") + '</td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; font-size:12px;"><span style="background:#374151; border-radius:4px; padding:2px 6px; color:#d1d5db;">' + e.reason + '</span></td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:12px; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (e.triggerMessage || "—") + '</td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:' + slaColor + '; font-size:11px; font-weight:700;">' + slaText + '</td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:11px;">' + created + '</td>' +
          '<td style="padding:6px 10px; border-bottom:1px solid #1f2937;">' + actions + '</td>' +
          '</tr>';
      }
      wrap.innerHTML =
        '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
        '<thead><tr>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Priority</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Client</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Phone</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Reason</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Message</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">SLA</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Created</th>' +
        '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Action</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load escalations.</div>'; }
  }
  loadEscalations();

  async function claimEsc(id, btn) {
    btn.disabled = true; btn.textContent = "...";
    try {
      await fetch("/api/dashboard/escalations/" + id + "/claim", {
        method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ claimedBy: "Coach" })
      });
      loadEscalations();
    } catch { btn.textContent = "Error"; }
  }
  async function resolveEsc(id) {
    const note = prompt("Resolution notes (optional):");
    try {
      await fetch("/api/dashboard/escalations/" + id + "/resolve", {
        method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ resolution: note || "Resolved" })
      });
      loadEscalations();
    } catch { alert("Error resolving"); }
  }

  // ---- NPS SUMMARY ----
  (async function loadNPS() {
    const wrap = document.getElementById("npsWrap");
    try {
      const res = await fetch("/api/dashboard/nps", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      if (data.totalResponses === 0) {
        wrap.innerHTML = '<div style="color:#4b5563;">No NPS responses yet. Clients can reply "rate" to submit feedback.</div>';
        return;
      }
      const npsColor = data.npsScore >= 50 ? "#22c55e" : data.npsScore >= 0 ? "#f59e0b" : "#ef4444";
      let recentRows = "";
      for (const r of data.recent) {
        const color = r.score >= 9 ? "#22c55e" : r.score >= 7 ? "#f59e0b" : "#ef4444";
        recentRows += '<span style="display:inline-block; background:' + color + '22; color:' + color + '; border:1px solid ' + color + '44; border-radius:6px; padding:3px 8px; margin:2px; font-size:12px; font-weight:700;">' + r.score + '</span>';
      }
      wrap.innerHTML =
        '<div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:16px;">' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:' + npsColor + ';">' + data.npsScore + '</div><div style="font-size:11px; color:#6b7280;">NPS Score</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + data.promoters + '</div><div style="font-size:11px; color:#6b7280;">Promoters (9-10)</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + data.passives + '</div><div style="font-size:11px; color:#6b7280;">Passives (7-8)</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#ef4444;">' + data.detractors + '</div><div style="font-size:11px; color:#6b7280;">Detractors (1-6)</div></div>' +
        '</div>' +
        '<div style="font-size:12px; color:#6b7280; margin-bottom:8px;">Avg score: ' + data.avgScore + '/10 | ' + data.totalResponses + ' total responses</div>' +
        '<div style="font-size:11px; color:#4b5563;">Recent scores: ' + recentRows + '</div>';
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load NPS data.</div>'; }
  })();

  // ---- PINNED NEXT ACTIONS ----
  (async function loadNextActions() {
    const container = document.getElementById("next-actions-container");
    try {
      const res = await fetch("/api/dashboard/next-actions", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      if (!data.actions || data.actions.length === 0) {
        container.innerHTML = '<div style="color:#4ade80; text-align:center; padding:20px;">No pending actions — all clients in good shape.</div>';
        return;
      }
      const priorityColors = { urgent: "#ef4444", high: "#f59e0b", medium: "#3b82f6", low: "#6b7280" };
      const priorityLabels = { urgent: "URGENT", high: "HIGH", medium: "MED", low: "LOW" };
      let rows = "";
      for (const a of data.actions.slice(0, 20)) {
        const color = priorityColors[a.priority] || "#6b7280";
        rows += '<tr>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937;">' +
            '<span style="background:' + color + '; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:800;">' + (priorityLabels[a.priority] || "LOW") + '</span>' +
          '</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600;">' + a.name + '</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#9ca3af; font-size:12px;">' + a.action + '</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937;">' +
            '<button onclick="intervene(\'' + a.phone.replace(/'/g, "\\'") + '\',\'checkin\')" style="background:#22c55e; color:#000; border:none; padding:4px 10px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:700;">Nudge</button>' +
          '</td>' +
          '</tr>';
      }
      container.innerHTML =
        '<div style="font-size:12px; color:#6b7280; margin-bottom:8px;">' + data.total + ' actions identified</div>' +
        '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
        '<thead><tr>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Priority</th>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Client</th>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Action</th>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;"></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    } catch { container.innerHTML = '<div style="color:#ef4444;">Failed to load actions.</div>'; }
  })();

  // ---- COHORT ANALYTICS ----
  (async function loadCohorts() {
    try {
      const res = await fetch("/api/dashboard/cohorts", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      if (!data.cohorts || data.cohorts.length === 0) {
        document.getElementById("cohortWrap").innerHTML = '<div style="color:#4b5563;">No cohort data yet.</div>';
        return;
      }
      let rows = "";
      for (const c of data.cohorts) {
        const retColor = c.retentionRate >= 60 ? "#22c55e" : c.retentionRate >= 30 ? "#f59e0b" : "#ef4444";
        rows += '<tr>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600;">' + c.month + '</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center;">' + c.signups + '</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#4ade80;">' + c.onboardRate + '%</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#22c55e;">' + c.payRate + '%</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:' + retColor + ';">' + c.retentionRate + '%</td>' +
          '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#a78bfa;">' + c.avgWorkouts + '</td>' +
          '</tr>';
      }
      document.getElementById("cohortWrap").innerHTML =
        '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
        '<thead><tr>' +
        '<th style="padding:10px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Month</th>' +
        '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Signups</th>' +
        '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Onboard %</th>' +
        '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Pay %</th>' +
        '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Retention %</th>' +
        '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Avg Workouts</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    } catch { document.getElementById("cohortWrap").innerHTML = '<div style="color:#ef4444;">Failed to load cohort data.</div>'; }
  })();

  // ---- A/B EXPERIMENTS ----
  function showNewExperiment() { document.getElementById("newExpForm").style.display = "block"; }
  async function createExperiment() {
    const name = document.getElementById("expName").value.trim();
    const messageType = document.getElementById("expType").value;
    const variantA = document.getElementById("expA").value.trim();
    const variantB = document.getElementById("expB").value.trim();
    if (!name || !variantA || !variantB) { alert("Fill in all fields"); return; }
    try {
      await fetch("/api/dashboard/ab/experiments", {
        method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ name, variantA, variantB, messageType })
      });
      document.getElementById("newExpForm").style.display = "none";
      loadABExperiments();
    } catch { alert("Error creating experiment"); }
  }
  async function toggleExp(id, newStatus) {
    try {
      await fetch("/api/dashboard/ab/experiments/" + id + "/status", {
        method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
        body: JSON.stringify({ status: newStatus })
      });
      loadABExperiments();
    } catch {}
  }
  async function loadABExperiments() {
    const wrap = document.getElementById("abWrap");
    try {
      const res = await fetch("/api/dashboard/ab/experiments", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      if (!data.experiments || data.experiments.length === 0) {
        wrap.innerHTML = '<div style="color:#4b5563;">No experiments yet. Click "+ New" to start one.</div>';
        return;
      }
      let html = "";
      for (const exp of data.experiments) {
        const statusColor = exp.status === "active" ? "#22c55e" : exp.status === "paused" ? "#f59e0b" : "#6b7280";
        const winnerRate = Math.max(exp.responseRateA, exp.responseRateB);
        const winner = exp.responseRateA > exp.responseRateB ? "A" : exp.responseRateB > exp.responseRateA ? "B" : "—";
        const toggleBtn = exp.status === "active"
          ? '<button onclick="toggleExp(' + exp.id + ',\\'paused\\')" style="background:#f59e0b22; color:#f59e0b; border:1px solid #f59e0b44; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Pause</button> <button onclick="toggleExp(' + exp.id + ',\\'completed\\')" style="background:#6b728022; color:#6b7280; border:1px solid #6b728044; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Complete</button>'
          : exp.status === "paused"
          ? '<button onclick="toggleExp(' + exp.id + ',\\'active\\')" style="background:#22c55e22; color:#22c55e; border:1px solid #22c55e44; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Resume</button>'
          : '';
        html += '<div style="background:#111827; border:1px solid #374151; border-radius:8px; padding:14px; margin-bottom:10px;">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">' +
            '<div><span style="font-weight:700; color:#f9fafb; font-size:14px;">' + exp.name + '</span> <span style="font-size:11px; color:#6b7280; margin-left:6px;">' + exp.messageType + '</span></div>' +
            '<div style="display:flex; gap:6px; align-items:center;"><span style="color:' + statusColor + '; font-size:11px; font-weight:700; text-transform:uppercase;">' + exp.status + '</span> ' + toggleBtn + '</div>' +
          '</div>' +
          '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:12px;">' +
            '<div style="background:#1f2937; border-radius:6px; padding:10px;">' +
              '<div style="color:#9ca3af; font-size:10px; text-transform:uppercase; margin-bottom:4px;">Variant A (Control)</div>' +
              '<div style="color:#d1d5db; font-size:12px; margin-bottom:6px; max-height:40px; overflow:hidden;">' + exp.variantA.slice(0, 100) + '</div>' +
              '<div style="display:flex; gap:12px;"><span style="color:#38bdf8;">' + exp.statsA.delivered + ' sent</span><span style="color:#22c55e;">' + exp.statsA.responded + ' responded</span><span style="color:#a78bfa; font-weight:700;">' + exp.responseRateA + '%</span></div>' +
            '</div>' +
            '<div style="background:#1f2937; border-radius:6px; padding:10px;">' +
              '<div style="color:#9ca3af; font-size:10px; text-transform:uppercase; margin-bottom:4px;">Variant B (Challenger)</div>' +
              '<div style="color:#d1d5db; font-size:12px; margin-bottom:6px; max-height:40px; overflow:hidden;">' + exp.variantB.slice(0, 100) + '</div>' +
              '<div style="display:flex; gap:12px;"><span style="color:#38bdf8;">' + exp.statsB.delivered + ' sent</span><span style="color:#22c55e;">' + exp.statsB.responded + ' responded</span><span style="color:#a78bfa; font-weight:700;">' + exp.responseRateB + '%</span></div>' +
            '</div>' +
          '</div>' +
          (winner !== "—" ? '<div style="margin-top:8px; text-align:center; font-size:11px; color:#f59e0b;">Leading: Variant ' + winner + ' (' + winnerRate + '% response rate)</div>' : '') +
        '</div>';
      }
      wrap.innerHTML = html;
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load experiments.</div>'; }
  }
  loadABExperiments();

  // ---- CLIENT TIMELINE ----
  async function loadTimeline() {
    const phone = document.getElementById("timelinePhone").value.trim();
    if (!phone) return;
    const wrap = document.getElementById("timelineWrap");
    const summary = document.getElementById("timelineSummary");
    const eventsDiv = document.getElementById("timelineEvents");
    wrap.style.display = "block";
    summary.innerHTML = '<div style="color:#9ca3af;">Loading...</div>';
    eventsDiv.innerHTML = "";
    try {
      const res = await fetch("/api/dashboard/timeline/" + encodeURIComponent(phone), { headers: { "x-dashboard-key": DASH_KEY } });
      if (!res.ok) { summary.innerHTML = '<div style="color:#ef4444;">Client not found.</div>'; return; }
      const data = await res.json();
      const c = data.client;
      const s = data.summary;
      const trendColor = s.weightTrend < 0 ? "#22c55e" : s.weightTrend > 0 ? "#ef4444" : "#9ca3af";
      const trendLabel = s.weightTrend < 0 ? s.weightTrend + "kg ↓" : s.weightTrend > 0 ? "+" + s.weightTrend + "kg ↑" : "—";
      summary.innerHTML =
        '<div style="display:flex; flex-wrap:wrap; gap:16px; align-items:center; margin-bottom:12px;">' +
          '<div style="font-size:18px; font-weight:800; color:#f9fafb;">' + (c.name || "Unknown") + '</div>' +
          '<div style="font-size:12px; color:#6b7280;">' + c.phone + '</div>' +
          '<div style="font-size:12px; color:#9ca3af; background:#1f2937; border-radius:4px; padding:2px 8px;">' + (c.goal || "—") + ' · ' + (c.mode || "—") + ' · Week ' + (c.week || 0) + '</div>' +
        '</div>' +
        '<div style="display:grid; grid-template-columns:repeat(5,1fr); gap:12px;">' +
          '<div><div style="font-size:20px; font-weight:800; color:#a78bfa;">' + s.daysOnProgramme + '</div><div style="font-size:11px; color:#6b7280;">Days on programme</div></div>' +
          '<div><div style="font-size:20px; font-weight:800; color:#22c55e;">' + s.workoutsLast30 + '</div><div style="font-size:11px; color:#6b7280;">Workouts (30d)</div></div>' +
          '<div><div style="font-size:20px; font-weight:800; color:#38bdf8;">' + s.avgSteps.toLocaleString() + '</div><div style="font-size:11px; color:#6b7280;">Avg Steps</div></div>' +
          '<div><div style="font-size:20px; font-weight:800; color:' + trendColor + ';">' + trendLabel + '</div><div style="font-size:11px; color:#6b7280;">Weight Trend</div></div>' +
          '<div><div style="font-size:20px; font-weight:800; color:#f59e0b;">' + s.messagesLast30 + '</div><div style="font-size:11px; color:#6b7280;">Messages (30d)</div></div>' +
        '</div>';

      // Events table
      if (data.events.length === 0) {
        eventsDiv.innerHTML = '<div class="card" style="color:#4b5563; text-align:center; padding:20px;">No activity in last 30 days.</div>';
        return;
      }
      const icons = { weight: "⚖️", steps: "🚶", workout: "💪", chat: "💬" };
      const colors = { weight: "#22c55e", steps: "#38bdf8", workout: "#a78bfa", chat: "#9ca3af" };
      let eventRows = "";
      for (const e of data.events.slice(0, 100)) {
        const d = new Date(e.date);
        const dateStr = d.toLocaleDateString("en-ZA", { day:"2-digit", month:"short" }) + " " + d.toLocaleTimeString("en-ZA", { hour:"2-digit", minute:"2-digit" });
        eventRows += '<tr>' +
          '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:12px; white-space:nowrap;">' + dateStr + '</td>' +
          '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; text-align:center;">' + (icons[e.type] || "·") + '</td>' +
          '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; color:' + (colors[e.type] || "#d1d5db") + '; font-size:13px;">' + e.detail + '</td>' +
          '</tr>';
      }
      eventsDiv.innerHTML =
        '<table style="width:100%; border-collapse:collapse;">' +
        '<thead><tr>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Date</th>' +
        '<th style="padding:8px 12px; text-align:center; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Type</th>' +
        '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Detail</th>' +
        '</tr></thead><tbody>' + eventRows + '</tbody></table>';
    } catch { summary.innerHTML = '<div style="color:#ef4444;">Error loading timeline.</div>'; }
  }
  // ---- KPI METRICS ----
  (async function loadKPIs() {
    const wrap = document.getElementById("kpiWrap");
    try {
      const res = await fetch("/api/dashboard/kpis?days=30", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      const u = data.users;
      const r = data.rates;
      const a = data.activity;
      wrap.innerHTML =
        '<div class="grid-3" style="margin-bottom:12px;">' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + r.retention + '</div><div style="color:#9ca3af; font-size:11px;">Retention</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#38bdf8;">' + r.engagement + '</div><div style="color:#9ca3af; font-size:11px;">Engagement</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + r.conversion + '</div><div style="color:#9ca3af; font-size:11px;">Conversion</div></div>' +
        '</div>' +
        '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
          '<div>Active: <b style="color:#22c55e;">' + u.active + '</b></div>' +
          '<div>New: <b style="color:#38bdf8;">' + u.new + '</b></div>' +
          '<div>Churned: <b style="color:#ef4444;">' + u.churned + '</b></div>' +
          '<div>Paying: <b style="color:#f59e0b;">' + u.paying + '</b></div>' +
        '</div>' +
        '<div style="margin-top:10px; display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
          '<div>Messages: <b>' + a.messages + '</b></div>' +
          '<div>Workouts: <b>' + a.workouts + '</b></div>' +
          '<div>Weigh-ins: <b>' + a.weighIns + '</b></div>' +
          '<div>Avg msg/user: <b>' + a.avgMessagesPerUser + '</b></div>' +
        '</div>';
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load KPIs.</div>'; }
  })();

  // ---- REVENUE ----
  (async function loadRevenue() {
    const wrap = document.getElementById("revenueWrap");
    try {
      const res = await fetch("/api/dashboard/revenue", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      const c = data.current;
      const r = data.rates;
      const f = data.forecast;
      wrap.innerHTML =
        '<div class="grid-3" style="margin-bottom:12px;">' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + c.mrr + '</div><div style="color:#9ca3af; font-size:11px;">Monthly Revenue</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#38bdf8;">' + c.arr + '</div><div style="color:#9ca3af; font-size:11px;">Annual Revenue</div></div>' +
          '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + r.estimatedLTV + '</div><div style="color:#9ca3af; font-size:11px;">Est. LTV</div></div>' +
        '</div>' +
        '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
          '<div>Paying: <b style="color:#22c55e;">' + c.payingUsers + '</b></div>' +
          '<div>Trial: <b style="color:#38bdf8;">' + c.trialUsers + '</b></div>' +
          '<div>Cancelled: <b style="color:#ef4444;">' + c.cancelledUsers + '</b></div>' +
          '<div>Conversion: <b style="color:#f59e0b;">' + r.trialConversion + '</b></div>' +
        '</div>' +
        '<div style="margin-top:10px; padding:8px; background:#111827; border-radius:6px; font-size:12px; color:#9ca3af;">' +
          'Forecast: <b style="color:#22c55e;">' + f.projectedMRR + '</b>/mo if ' + f.projectedNewPaying + ' trial users convert' +
        '</div>';
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load revenue.</div>'; }
  })();

  // ---- CLIENT SEARCH ----
  let searchTimeout;
  function searchClients() {
    clearTimeout(searchTimeout);
    const q = document.getElementById("clientSearch").value.trim();
    const wrap = document.getElementById("searchResults");
    if (q.length < 2) { wrap.style.display = "none"; return; }
    searchTimeout = setTimeout(async () => {
      try {
        const res = await fetch("/api/dashboard/search?q=" + encodeURIComponent(q), { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (!data.results || data.results.length === 0) {
          wrap.style.display = "block";
          wrap.innerHTML = '<div style="color:#4b5563; padding:12px; text-align:center;">No clients found.</div>';
          return;
        }
        let rows = "";
        for (const c of data.results) {
          const lastActive = c.lastActive ? new Date(c.lastActive).toLocaleDateString("en-ZA", { day:"2-digit", month:"short" }) : "Never";
          rows += '<tr style="border-bottom:1px solid #1f2937;">' +
            '<td style="padding:8px 12px; color:#f9fafb; font-weight:600;">' + (c.name || "—") + '</td>' +
            '<td style="padding:8px 12px; color:#9ca3af; font-family:monospace; font-size:12px;">' + (c.phone || "") + '</td>' +
            '<td style="padding:8px 12px; color:#a78bfa;">' + (c.goal || "—") + '</td>' +
            '<td style="padding:8px 12px; color:#6b7280;">' + lastActive + '</td>' +
            '<td style="padding:8px 12px;"><span style="color:' + (c.payment === "active" ? "#22c55e" : "#f59e0b") + '; font-size:11px; font-weight:700;">' + (c.payment || "trial") + '</span></td>' +
          '</tr>';
        }
        wrap.style.display = "block";
        wrap.innerHTML = '<table style="width:100%; border-collapse:collapse;"><thead><tr>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Name</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Phone</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Goal</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Last Active</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Payment</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Search failed.</div>'; }
    }, 300);
  }

  // ---- WEEKLY REPORT ----
  async function loadWeeklyReport() {
    const wrap = document.getElementById("weeklyReportWrap");
    wrap.innerHTML = '<div style="color:#9ca3af;">Generating report...</div>';
    try {
      const res = await fetch("/api/dashboard/weekly-report", { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await res.json();
      const s = data.summary;
      let rows = "";
      for (const c of data.clients.slice(0, 50)) {
        const statusColor = c.status === "at_risk" ? "#ef4444" : c.status === "needs_attention" ? "#f59e0b" : "#22c55e";
        const statusLabel = c.status === "at_risk" ? "AT RISK" : c.status === "needs_attention" ? "ATTENTION" : "ON TRACK";
        rows += '<tr style="border-bottom:1px solid #1f2937;">' +
          '<td style="padding:6px 10px; color:#f9fafb; font-weight:500;">' + c.name + '</td>' +
          '<td style="padding:6px 10px;"><span style="background:' + statusColor + '22; color:' + statusColor + '; border-radius:4px; padding:2px 8px; font-size:10px; font-weight:700;">' + statusLabel + '</span></td>' +
          '<td style="padding:6px 10px; color:#d1d5db; font-size:12px; text-align:center;">' + c.weekActivity.messages + '</td>' +
          '<td style="padding:6px 10px; color:#d1d5db; font-size:12px; text-align:center;">' + c.weekActivity.workouts + '</td>' +
          '<td style="padding:6px 10px; color:#d1d5db; font-size:12px;">' + (c.weight.change !== null ? (c.weight.change > 0 ? "+" : "") + c.weight.change + "kg" : "—") + '</td>' +
          '<td style="padding:6px 10px; color:#6b7280; font-size:11px;">' + (c.risks.length > 0 ? c.risks.join(", ") : "none") + '</td>' +
        '</tr>';
      }
      wrap.innerHTML =
        '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px;">' +
          '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#ef4444;">' + s.atRisk + '</div><div style="color:#9ca3af; font-size:11px;">At Risk</div></div>' +
          '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#f59e0b;">' + s.needsAttention + '</div><div style="color:#9ca3af; font-size:11px;">Needs Attention</div></div>' +
          '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#22c55e;">' + s.onTrack + '</div><div style="color:#9ca3af; font-size:11px;">On Track</div></div>' +
        '</div>' +
        '<table style="width:100%; border-collapse:collapse;"><thead><tr>' +
          '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Client</th>' +
          '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Status</th>' +
          '<th style="padding:6px 10px; text-align:center; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Msgs</th>' +
          '<th style="padding:6px 10px; text-align:center; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Workouts</th>' +
          '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Weight</th>' +
          '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Risks</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to generate report.</div>'; }
  }
</script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send("Dashboard error: " + err);
  }
});
}
