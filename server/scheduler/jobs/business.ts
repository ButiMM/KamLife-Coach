import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations,
  abExperiments, abAssignments,
  eq, gte, and, lt, desc, asc, sql, count,
  sendWhatsApp, sendCriticalAlert, claimDailySlot, claimProactive, claimCritical, isProactivePaused,
  getActiveClients, isPaused, loadState, saveState,
  deliveryStats, todaySAST, thisWeekUTC, FROM_NUMBER, PRICING, inArray,
} from "../shared";
import { gptCosts } from "../../../shared/schema";

export async function runMonthEndBudget(): Promise<void> {
  console.log("[SCHEDULER] JOB: Month-end budget mode");
  const clients = await getActiveClients();
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const budget = client.weeklyFoodBudget || "100_300";
      let budgetMsg: string;
      if (budget === "under_50" || budget === "50_100" || budget === "under_100") {
        budgetMsg = `${name}, month end is coming. Your R57 emergency plan — eggs R25, pilchards R12, sugar beans R20. This covers your protein for 4 days. Shop this weekend before the money is gone.`;
      } else if (budget === "100_300") {
        budgetMsg = `${name}, month end approaching. Your R100 week plan — eggs 12 pack R45, pilchards 3 tins R36, cabbage R8, onions R8, pap 2kg R15. Enough for the full week. Shop at Shoprite or Boxer this weekend.`;
      } else {
        budgetMsg = `${name}, month end coming. Pre-cook chicken in bulk, buy oats for the week, and prep Sunday — that's what keeps the nutrition consistent when the week gets busy.`;
      }
      if (await claimDailySlot(client.id, "month_end_budget")) { await sendWhatsApp(client.phoneNumber, budgetMsg); }
    } catch (err) { console.error(`[SCHEDULER] Month-end budget error — ${client.phoneNumber}:`, err); }
  }
}

export async function runSubscriptionExpiryCheck(): Promise<void> {
  console.log("[SCHEDULER] JOB: Subscription expiry check");
  const clients = await getActiveClients({ ignorePause: true }); // billing must run even when coaching is paused
  const now = Date.now();
  // Grace period is configurable so ops can extend it during bank holidays or PayFast
  // outages without a code deploy. Default 3 days matches PayFast's retry window.
  const graceDays = Math.max(1, parseInt(process.env.SUBSCRIPTION_GRACE_PERIOD_DAYS || "3", 10));
  const threeDaysMs = graceDays * 86_400_000;
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const renewsAt = (client as { subscriptionRenewsAt?: Date | null }).subscriptionRenewsAt;
      if (!renewsAt) continue;
      const renewsMs = new Date(renewsAt).getTime();
      const msUntilRenewal = renewsMs - now;
      const name = client.name || "there";
      if (msUntilRenewal > 0 && msUntilRenewal <= threeDaysMs) {
        const daysLeft = Math.ceil(msUntilRenewal / 86_400_000);
        if (await claimCritical(client.id, "renewal_reminder", todaySAST())) {
          await sendCriticalAlert(client.phoneNumber, `${name}, your KamLife Coach subscription renews in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. If your payment details have changed, update them at kamlifecoach.co.za before then. Nothing changes if everything is fine — coaching continues automatically.`);
        }
      }
      // 3-day grace period: PayFast recurring ITNs can land hours late and monthly
      // billing isn't exactly 30 days — only expire once renewal is >3 days overdue.
      if (msUntilRenewal < -threeDaysMs && client.subscriptionStatus === "active") {
        const daysOverdue = Math.floor(-msUntilRenewal / 86_400_000);
        await db.update(users).set({ subscriptionStatus: "inactive", cancelledAt: new Date() }).where(eq(users.phoneNumber, client.phoneNumber));
        if (await claimCritical(client.id, "sub_expired", todaySAST())) {
          await sendCriticalAlert(client.phoneNumber, `${name}, your subscription has expired. Your profile and progress history are saved. To continue with Coach K, renew at kamlifecoach.co.za or reply *pay* for a payment link.`);
        }
        console.log(`[SCHEDULER] Subscription expired — ${client.phoneNumber} — renewal ${daysOverdue} day(s) overdue, no PayFast ITN received`);
      }
    } catch (err) { console.error(`[SCHEDULER] Subscription expiry error — ${client.phoneNumber}:`, err); }
  }
}

export async function runPaymentFailureRecovery(): Promise<void> {
  console.log("[SCHEDULER] JOB: Payment failure recovery");
  const allUsers = await db.select().from(users);
  const failedUsers = allUsers.filter(u =>
    u.subscriptionStatus === "inactive" && u.cancelledAt && u.onboardingState === "COMPLETE" && u.totalWorkoutsCompleted && u.totalWorkoutsCompleted > 0
  );
  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  for (const client of failedUsers) {
    try {
      const name = client.name || "there";
      const daysSinceFail = Math.floor((Date.now() - new Date(client.cancelledAt!).getTime()) / 86_400_000);
      const workouts = client.totalWorkoutsCompleted || 0;
      const cleanPhone = client.phoneNumber.replace(/^whatsapp:/, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      if (daysSinceFail !== 1 && daysSinceFail !== 3 && daysSinceFail !== 7) continue;
      if (!(await claimCritical(client.id, "payment_recovery", todaySAST()))) continue;
      if (daysSinceFail === 1) {
        await sendCriticalAlert(client.phoneNumber, `${name}, your payment didn't go through yesterday. Could be a bank issue — happens all the time.\n\nYour programme and ${workouts} sessions of progress are saved. Update your payment here and coaching continues immediately:\n${payLink}`);
      } else if (daysSinceFail === 3) {
        await sendCriticalAlert(client.phoneNumber, `${name} — your coaching's been paused 3 days. You're in Week ${client.programmeWeek || 1} with ${workouts} sessions done, and all of it is saved.\n\nWhenever you're ready to pick back up, this fixes it in 30 seconds:\n${payLink}`);
      } else if (daysSinceFail === 7) {
        await sendCriticalAlert(client.phoneNumber, `${name}, last message about this — your subscription has been paused for a week.\n\n${workouts} sessions. Every meal logged. Every step counted. That work is not lost.\n\nWhen you're ready, reply *pay* and I'll send a fresh link. No pressure, no expiry on your data.\n\nIf you'd like to stop completely, reply *STOP* and I won't message again.`);
      }
    } catch (err) { console.error(`[SCHEDULER] Payment recovery error — ${client.phoneNumber}:`, err); }
  }
}

export async function runSignupNudge(): Promise<void> {
  console.log("[SCHEDULER] JOB: Signup nudge + lapsed win-back");
  const inactiveClients = await db.select().from(users).where(eq(users.subscriptionStatus, "inactive"));
  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  for (const client of inactiveClients) {
    try {
      const name = client.name || "there";
      const cleanPhone = client.phoneNumber.replace(/^whatsapp:/, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const onboardingComplete = client.onboardingState === "COMPLETE" && !!client.goalType;
      const isNewSignup = onboardingComplete && !client.totalWorkoutsCompleted && !client.lastWorkoutDate;
      const created = client.createdAt ? new Date(client.createdAt) : null;
      const cancelled = client.cancelledAt ? new Date(client.cancelledAt) : null;
      if (isNewSignup && created) {
        const daysSince = Math.floor((Date.now() - created.getTime()) / 86_400_000);
        const workouts = client.totalWorkoutsCompleted || 0;
        if (daysSince === 1 && client.subscriptionStatus === "inactive") {
          if (await claimCritical(client.id, "signup_nudge", todaySAST())) {
            await sendCriticalAlert(client.phoneNumber, `${name}, your programme is built and ready.\n\n${workouts === 0 ? "Day 1 is waiting." : `${workouts} session${workouts > 1 ? "s" : ""} logged.`} Activate now and coaching starts immediately.\n\n*${PRICING.monthlyDisplay} — cancel anytime:*\n${payLink}\n\n${PRICING.dailyDisplay}.`);
          }
        } else if (daysSince === 3 && client.subscriptionStatus === "inactive") {
          if (await claimCritical(client.id, "signup_nudge", todaySAST())) {
            await sendCriticalAlert(client.phoneNumber, `${name}, your programme is still here and ready to go.\n\n${PRICING.monthlyDisplay} — activate when you're ready:\n${payLink}`);
          }
        }
      } else if (!isNewSignup && cancelled) {
        const daysSinceCancelled = Math.floor((Date.now() - cancelled.getTime()) / 86_400_000);
        const workouts = client.totalWorkoutsCompleted || 0;
        if (daysSinceCancelled !== 3 && daysSinceCancelled !== 7 && daysSinceCancelled !== 30) continue;
        if (!(await claimCritical(client.id, "winback", todaySAST()))) continue;
        if (daysSinceCancelled === 3) {
          await sendCriticalAlert(client.phoneNumber, `${name} — you've done ${workouts} sessions with Coach K. That doesn't disappear.\n\nYour programme, weight history, and streaks are all saved. Pick up exactly where you left off.\n\n*Reactivate for ${PRICING.monthlyDisplay}:*\n${payLink}`);
        } else if (daysSinceCancelled === 7) {
          await sendCriticalAlert(client.phoneNumber, `${name}, a week since you left.\n\nThe people who come back after a week are the ones who actually get results — they know what consistency feels like now.\n\n${PRICING.monthlyDisplay}. Your data is here:\n${payLink}`);
        } else if (daysSinceCancelled === 30) {
          await sendCriticalAlert(client.phoneNumber, `${name} — 30 days. Coach K here.\n\nOne message to say your profile is still here if you want it. ${workouts} sessions logged. Progress saved.\n\n${PRICING.monthlyDisplay} if you're ready:\n${payLink}\n\nIf not — no hard feelings. Reply STOP and I won't message again.`);
        }
      }
    } catch (err) { console.error(`[SCHEDULER] Signup/win-back error — ${client.phoneNumber}:`, err); }
  }

  // Expired trial users — they experienced the product but never converted.
  // runSignupNudge only queries "inactive"; trial users keep status="trial" after
  // betaBypassUntil passes, so they fall through with zero conversion follow-up.
  const expiredTrialClients = await db.select().from(users).where(
    and(
      eq(users.subscriptionStatus, "trial"),
      eq(users.onboardingState, "COMPLETE"),
      lt(users.betaBypassUntil, new Date()),
    )
  );
  for (const client of expiredTrialClients) {
    try {
      const expiredAt = client.betaBypassUntil ? new Date(client.betaBypassUntil) : null;
      if (!expiredAt) continue;
      const daysSinceExpiry = Math.floor((Date.now() - expiredAt.getTime()) / 86_400_000);
      if (daysSinceExpiry !== 1 && daysSinceExpiry !== 3 && daysSinceExpiry !== 7) continue;
      const name = client.name || "there";
      const cleanPhone = client.phoneNumber.replace(/^whatsapp:/, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const workouts = client.totalWorkoutsCompleted || 0;
      const hasProgress = workouts > 0;
      let msg: string;
      if (daysSinceExpiry === 1) {
        msg = hasProgress
          ? `${name}, your free trial ended yesterday.\n\n${workouts} session${workouts !== 1 ? "s" : ""} logged — all saved.\n\nActivate for ${PRICING.monthlyDisplay} to continue exactly where you left off:\n${payLink}\n\n${PRICING.dailyDisplay}. Cancel anytime.`
          : `${name}, your free trial ended yesterday. Your personalised programme is ready and waiting.\n\nActivate for ${PRICING.monthlyDisplay}:\n${payLink}\n\n${PRICING.dailyDisplay}. Cancel anytime.`;
      } else if (daysSinceExpiry === 3) {
        msg = hasProgress
          ? `${name} — ${workouts} session${workouts !== 1 ? "s" : ""} saved and waiting. 3 days since your trial ended.\n\n${PRICING.monthlyDisplay} — your programme, food coaching, and progress all pick up immediately:\n${payLink}`
          : `${name}, 3 days since your trial ended. Your programme is still here.\n\n${PRICING.monthlyDisplay} — ${PRICING.dailyDisplay}:\n${payLink}`;
      } else {
        msg = `${name}, last nudge — your trial ended a week ago.\n\n${hasProgress ? `${workouts} sessions and all your data are saved.` : "Your programme is still ready."}\n\nWhen you are ready — ${PRICING.monthlyDisplay}:\n${payLink}\n\nIf you have decided not to continue, reply STOP.`;
      }
      if (await claimCritical(client.id, "trial_expiry_nudge", todaySAST())) {
        await sendCriticalAlert(client.phoneNumber, msg);
      }
    } catch (err) { console.error(`[SCHEDULER] Trial expiry nudge error — ${client.phoneNumber}:`, err); }
  }
}

export async function runPaydayShoppingNudge(): Promise<void> {
  console.log("[SCHEDULER] JOB: Payday shopping nudge");
  const clients = await getActiveClients();
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = (client.name || "there").split(" ")[0];
      const budget = client.weeklyFoodBudget || "100_300";
      const goal = client.goalType || "fat_loss";
      let msg = "";
      if (budget === "under_100" || budget === "50_100" || budget === "under_50") {
        msg = `${name}, if today is payday — protein before anything else.\n\nBest value at Shoprite or Boxer: eggs, pilchards, sugar beans. In that order. Those three cover your protein for the week.\n\nEverything else comes after. Reply *shopping list* for the full plan.`;
      } else if (budget === "100_300") {
        const focus = goal === "muscle_gain" ? `Frozen chicken and eggs are your priority — you need volume.` : `Frozen chicken, oats, and sweet potato. Protein first, carbs around training.`;
        msg = `${name}, payday — stock up before the money goes.\n\n${focus}\n\nReply *shopping list* for your full list. Reply *meal prep* for the batch cooking plan.`;
      } else {
        msg = `${name}, start of the pay cycle — best time to set up your kitchen for the week.\n\nBuy ${goal === "muscle_gain" ? "chicken breast, eggs, and Greek yoghurt in bulk" : "lean protein in bulk — chicken breast, tuna, eggs"}. Freeze what you won't use this week.\n\nReply *shopping list* for your personalised list.`;
      }
      if (await claimDailySlot(client.id, "payday_nudge")) { await sendWhatsApp(client.phoneNumber, msg); }
    } catch (err) { console.error(`[SCHEDULER] Payday nudge error — ${client.phoneNumber}:`, err); }
  }
}

export async function runStepLeaderboard(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly step leaderboard broadcast");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runStepLeaderboard blocked"); return; }
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const allStepLogs = await db.select({ userId: stepLogs.userId, steps: stepLogs.steps }).from(stepLogs).where(gte(stepLogs.loggedAt, sevenDaysAgo));
    const userSteps: Record<string, { total: number; days: number }> = {};
    for (const log of allStepLogs) {
      if (!userSteps[log.userId]) userSteps[log.userId] = { total: 0, days: 0 };
      userSteps[log.userId].total += log.steps;
      userSteps[log.userId].days++;
    }
    const participantIds = Object.keys(userSteps);
    if (participantIds.length < 3) return;
    const participants = await db.select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber, subscriptionStatus: users.subscriptionStatus })
      .from(users).where(inArray(users.id, participantIds));
    const infoMap: Record<string, { name: string; phone: string; active: boolean }> = {};
    for (const p of participants) infoMap[p.id] = { name: p.name || "Anonymous", phone: p.phoneNumber, active: p.subscriptionStatus === "active" };
    const ranked = participantIds.map(uid => ({
      uid, name: infoMap[uid]?.name || "Anonymous", phone: infoMap[uid]?.phone || "",
      avg: Math.round(userSteps[uid].total / userSteps[uid].days), active: infoMap[uid]?.active || false,
    })).sort((a, b) => b.avg - a.avg);
    const medals = ["🥇", "🥈", "🥉"];
    let boardBase = `*🏆 Weekly Step Leaderboard*\n\n`;
    for (let i = 0; i < Math.min(5, ranked.length); i++) {
      const r = ranked[i];
      boardBase += `${i < 3 ? medals[i] : `${i + 1}.`} ${(r.name || "Member").split(" ")[0]} — ${r.avg.toLocaleString()} avg/day\n`;
    }
    let sent = 0;
    for (const r of ranked) {
      if (!r.active || !r.phone) continue;
      const myRank = ranked.indexOf(r) + 1;
      const personal = myRank <= 5
        ? `\nYou are *#${myRank}*! ${myRank === 1 ? "You led the pack this week. 👑" : "Keep pushing for #1 next week."}`
        : `\nYou are *#${myRank}* of ${ranked.length}. ${r.avg.toLocaleString()} avg steps. Log more to climb next week.`;
      // DB claim (weekly window) so a recycle can't re-broadcast the leaderboard.
      if (!(await claimProactive(r.uid, "step_leaderboard", thisWeekUTC()))) continue;
      try { await sendWhatsApp(r.phone, `${boardBase}${personal}\n\nNew week starts now. Reply *leaderboard* anytime to check rankings.`); sent++; } catch {}
      if (sent % 10 === 0) await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`[SCHEDULER] Leaderboard sent to ${sent} clients`);
  } catch (err) { console.error("[SCHEDULER] Leaderboard broadcast error:", err); }
}

export async function runWeeklyKpiReport(): Promise<void> {
  const coachPhone = process.env.COACH_ALERT_PHONE;
  if (!coachPhone) { console.log("[KPI] COACH_ALERT_PHONE not set — skipping weekly report"); return; }
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
    const allClients = await db.select({ id: users.id, subscriptionStatus: users.subscriptionStatus, createdAt: users.createdAt, totalWorkoutsCompleted: users.totalWorkoutsCompleted, lastWorkoutDate: users.lastWorkoutDate }).from(users);
    const totalClients = allClients.length;
    const paying = allClients.filter(c => c.subscriptionStatus === "active").length;
    const newThisWeek = allClients.filter(c => c.createdAt && new Date(c.createdAt) >= sevenDaysAgo).length;
    const churned = allClients.filter(c => c.subscriptionStatus === "inactive" || c.subscriptionStatus === "cancelled").length;
    const [weekWorkouts] = await db.select({ c: count() }).from(workoutLogs).where(gte(workoutLogs.loggedAt, sevenDaysAgo));
    const [weekSteps] = await db.select({ c: count() }).from(stepLogs).where(gte(stepLogs.loggedAt, sevenDaysAgo));
    const [weekMessages] = await db.select({ c: count() }).from(chatHistory).where(gte(chatHistory.createdAt, sevenDaysAgo));
    const atRisk = allClients.filter(c => {
      if (c.subscriptionStatus !== "active") return false;
      const lastActivity = c.lastWorkoutDate ? new Date(c.lastWorkoutDate) : (c.createdAt ? new Date(c.createdAt) : now);
      return lastActivity < twoDaysAgo;
    }).length;
    const mrr = paying * PRICING.monthlyPriceZAR;
    const [weekFoodLogs] = await db.select({ c: count() }).from(mealLogs).where(gte(mealLogs.loggedAt, sevenDaysAgo));
    const weekFoodLogsCount = weekFoodLogs?.c || 0;
    const [gptFallbackLogs] = await db.execute(sql`SELECT COUNT(*) as c FROM meal_logs WHERE source = 'gpt_fallback' AND logged_at >= ${sevenDaysAgo}`) as unknown as { rows: { c: number }[] }[];
    const gptFallbackCount = Number((gptFallbackLogs as unknown as { rows?: { c?: number }[] })?.rows?.[0]?.c || 0);
    const fallbackPct = weekFoodLogsCount > 0 ? Math.round((gptFallbackCount / weekFoodLogsCount) * 100) : 0;
    const scannerHits = weekFoodLogsCount - gptFallbackCount;
    const scannerPct = weekFoodLogsCount > 0 ? Math.round((scannerHits / weekFoodLogsCount) * 100) : 0;
    const [escNewRow] = await db.select({ c: count() }).from(escalations).where(gte(escalations.createdAt, sevenDaysAgo));
    const [escOpenRow] = await db.select({ c: count() }).from(escalations).where(eq(escalations.status, "open"));
    const [escResolvedRow] = await db.select({ c: count() }).from(escalations).where(and(eq(escalations.status, "resolved"), gte(escalations.resolvedAt as Parameters<typeof gte>[0], sevenDaysAgo)));
    const [escUrgentRow] = await db.select({ c: count() }).from(escalations).where(and(eq(escalations.priority, "urgent"), eq(escalations.status, "open")));
    const foodSourceRows = await db.execute(sql`SELECT source, COUNT(*) as c FROM meal_logs WHERE logged_at >= ${sevenDaysAgo} GROUP BY source ORDER BY c DESC`) as unknown as { rows: { source: string; c: number }[] }[];
    const foodSources: string[] = ((foodSourceRows as unknown as { rows?: { source?: string; c?: number }[] })?.rows || []).map((r) => `${r.source || "unknown"}: ${r.c}`);
    let abSection = "";
    try {
      const activeExps = await db.select().from(abExperiments).where(eq(abExperiments.status, "active"));
      if (activeExps.length > 0) {
        const abLines: string[] = [];
        for (const exp of activeExps.slice(0, 3)) {
          const assignments = await db.select({ variant: abAssignments.variant, delivered: abAssignments.delivered, responded: abAssignments.responded }).from(abAssignments).where(eq(abAssignments.experimentId, exp.id));
          const a = assignments.filter(x => x.variant === "A");
          const b = assignments.filter(x => x.variant === "B");
          const rateA = a.filter(x => x.delivered).length > 0 ? Math.round(a.filter(x => x.responded).length / a.filter(x => x.delivered).length * 100) : 0;
          const rateB = b.filter(x => x.delivered).length > 0 ? Math.round(b.filter(x => x.responded).length / b.filter(x => x.delivered).length * 100) : 0;
          const winner = rateA > rateB ? "A leads" : rateB > rateA ? "B leads" : "tied";
          abLines.push(`  ${exp.name}: A ${rateA}% vs B ${rateB}% (${winner}, n=${assignments.length})`);
        }
        abSection = `\n\n*A/B Tests*\n${abLines.join("\n")}`;
      }
    } catch (e) { console.warn("[KPI] A/B section error:", e); }
    const escSection = `\n\n*Escalations*\nNew this week: ${escNewRow?.c || 0} | Resolved: ${escResolvedRow?.c || 0}\nOpen: ${escOpenRow?.c || 0}${(escUrgentRow?.c || 0) > 0 ? ` ⚠️ ${escUrgentRow?.c} URGENT` : ""}`;
    const foodSourceSection = foodSources.length > 0 ? `\nSources: ${foodSources.join(", ")}` : "";

    // ── Actionable brief — turn the numbers into prioritised "do this" items ──
    // Each action only appears when its metric crosses a threshold worth acting on,
    // so a healthy week produces a short list (or none). Ordered most-urgent first.
    const deliveryTotal = deliveryStats.sent + deliveryStats.failed;
    const deliveryFailPct = deliveryTotal > 0 ? Math.round((deliveryStats.failed / deliveryTotal) * 100) : 0;

    // AI COST, BY FEATURE (CFO view) — the cost was always logged per feature; now it's
    // surfaced so the R199 margin is watched with data, not vibes. ~$11 = R199 revenue/client.
    const weekAgoDate = new Date(now.getTime() - 7 * 86_400_000);
    const costRows = await db.select({
      feature: gptCosts.feature,
      total: sql<string>`COALESCE(SUM(${gptCosts.costUsd}::numeric), 0)`,
    }).from(gptCosts).where(gte(gptCosts.createdAt, weekAgoDate)).groupBy(gptCosts.feature).catch(() => [] as { feature: string | null; total: string }[]);
    const weekCostTotal = costRows.reduce((s, r) => s + parseFloat(r.total || "0"), 0);
    const costPerClientWk = totalClients > 0 ? weekCostTotal / totalClients : 0;
    const monthlyPerClient = costPerClientWk * 4.3;
    const topFeatures = costRows
      .map(r => ({ f: r.feature || "other", c: parseFloat(r.total || "0") }))
      .sort((a, b) => b.c - a.c).slice(0, 5)
      .filter(r => r.c > 0)
      .map(r => `  ${r.f}: $${r.c.toFixed(2)}`).join("\n");
    const costSection = weekCostTotal > 0
      ? `\n\n*AI cost (last 7d)*\nTotal: $${weekCostTotal.toFixed(2)} · ~$${monthlyPerClient.toFixed(2)}/client/month vs $11 revenue\n${topFeatures}`
      : "";

    const actions: { p: number; text: string }[] = [];
    // Margin guard: at R199 (~$11/client/mo), AI cost eating a third of that needs a look.
    if (monthlyPerClient > 3.5 && totalClients >= 3)
      actions.push({ p: 2, text: `🟠 AI cost ~$${monthlyPerClient.toFixed(2)}/client/month — watch it against the $11 margin. Biggest driver: ${(topFeatures.split("\n")[0] || "").trim() || "n/a"}.` });
    if ((escUrgentRow?.c || 0) > 0)
      actions.push({ p: 1, text: `🔴 ${escUrgentRow?.c} URGENT escalation${(escUrgentRow?.c || 0) > 1 ? "s" : ""} open — clear the dashboard inbox first.` });
    if (deliveryFailPct >= 15)
      actions.push({ p: 1, text: `🔴 WhatsApp delivery failing ${deliveryFailPct}% — check Twilio sender quality before it becomes a ban.` });
    if (atRisk >= 1)
      actions.push({ p: 2, text: `🟠 ${atRisk} active client${atRisk > 1 ? "s" : ""} silent 48h+ — a personal check-in now prevents churn.` });
    if (churned >= 1)
      actions.push({ p: 2, text: `🟠 ${churned} on churn risk (14d+) — the winback flow is running, but a human note converts best.` });
    if (newThisWeek === 0)
      actions.push({ p: 2, text: `🟠 0 new signups this week — top of funnel is dry. Post / share the link.` });
    if (weekFoodLogsCount >= 20 && fallbackPct >= 35)
      actions.push({ p: 3, text: `🟡 SA scanner missed ${fallbackPct}% of foods (GPT fallback) — add the top misses to the food DB to cut cost + latency.` });
    if (paying === 0 && totalClients >= 3)
      actions.push({ p: 1, text: `🔴 0 paying clients — activation is the single most important number. Review the signup→pay flow.` });
    const actionSection = actions.length
      ? `\n\n*🎯 Do this week* (priority order)\n${actions.sort((a, b) => a.p - b.p).map(a => a.text).join("\n")}`
      : `\n\n*🎯 Do this week*\n✅ No fires. Focus on growth — one new acquisition channel.`;

    const report = `*📊 KamLife Weekly Report*\n_${now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}_\n\n*Revenue*\nMRR: R${mrr.toLocaleString()} (${paying} paying)\nNew this week: ${newThisWeek}\n\n*Engagement*\nWorkouts: ${weekWorkouts?.c || 0}\nStep logs: ${weekSteps?.c || 0}\nFood logs: ${weekFoodLogsCount} | SA scanner: ${scannerPct}% | GPT: ${fallbackPct}%${foodSourceSection}\nMessages: ${weekMessages?.c || 0}\n\n*Health*\nTotal clients: ${totalClients}\nAt-risk (48h+ silent): ${atRisk}\nChurn risk (14d+): ${churned}${escSection}\n\n*Delivery*\nSent: ${deliveryStats.sent} | Failed: ${deliveryStats.failed}${abSection}${costSection}${actionSection}`;
    await sendWhatsApp(`whatsapp:${coachPhone}`, report);
    console.log(`[KPI] Weekly report sent to coach`);
  } catch (e) { console.error("[KPI] Weekly report error:", e); }
}

export async function runSupplementReminder(): Promise<void> {
  console.log("[SCHEDULER] JOB: Supplement reminder");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runSupplementReminder blocked"); return; }
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
    const { sastDayStart } = await import("../shared");
    const todayStart = sastDayStart();
    const suppLoggers = await db.select({ userId: chatHistory.userId }).from(chatHistory).where(and(eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)));
    const uniqueUserIds = [...new Set(suppLoggers.map(s => s.userId))];
    if (uniqueUserIds.length === 0) return;
    let sent = 0;
    for (const uid of uniqueUserIds) {
      const todayLog = await db.select({ id: chatHistory.id }).from(chatHistory).where(and(eq(chatHistory.userId, uid), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart))).limit(1);
      if (todayLog.length > 0) continue;
      const [client] = await db.select({ phoneNumber: users.phoneNumber, name: users.name, subscriptionStatus: users.subscriptionStatus }).from(users).where(eq(users.id, uid)).limit(1);
      if (!client || client.subscriptionStatus !== "active") continue;
      const recentSupp = await db.select({ messageIn: chatHistory.messageIn }).from(chatHistory).where(and(eq(chatHistory.userId, uid), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo))).orderBy(desc(chatHistory.createdAt)).limit(3);
      const suppText = recentSupp.map(s => s.messageIn || "").join(" ").toLowerCase();
      let suppName = "";
      if (/creatine/.test(suppText)) suppName = "creatine";
      else if (/protein|whey|shake/.test(suppText)) suppName = "protein";
      else if (/omega|fish.?oil/.test(suppText)) suppName = "omega-3s";
      else if (/vitamin|vit\s*[cd]|multivit/.test(suppText)) suppName = "vitamins";
      else if (/magnesium/.test(suppText)) suppName = "magnesium";
      // No "Morning {name}" greeting — the 6am morning brief already greeted them;
      // a second greeting 2h later reads as two bots. This is a nudge, not a hello.
      const msg = suppName ? `Quick one — ${suppName} taken yet? Consistency is what makes it work. 💊` : `Quick one — supplements taken? One less thing to think about later. 💊`;
      // Daily-slot claim (routine nudge) — DB-backed, restart-safe, respects the daily cap.
      if (!(await claimDailySlot(uid, "supplement_reminder"))) continue;
      await sendWhatsApp(client.phoneNumber, msg);
      sent++;
    }
    console.log(`[SCHEDULER] Supplement reminders sent: ${sent}`);
  } catch (err) { console.error("[SCHEDULER] Supplement reminder error:", err); }
}

export async function runAutoCalAdjust(): Promise<void> {
  console.log("[SCHEDULER] JOB: Auto calorie adjustment");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runAutoCalAdjust blocked"); return; }

  // One adjustment per client per 3-week window
  const windowKey = Math.floor(Date.now() / (21 * 86_400_000));

  try {
    const activeClients = await getActiveClients();
    let adjusted = 0;

    for (const client of activeClients) {
      if (isPaused(client)) continue;
      try {
        // Don't adjust until 3 weeks into programme
        if (client.programmeStartDate) {
          const daysSinceStart = Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86_400_000);
          if (daysSinceStart < 21) continue;
        }

        const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000);
        const weights = await db
          .select({ weight: weightLogs.weight })
          .from(weightLogs)
          .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, threeWeeksAgo)))
          .orderBy(asc(weightLogs.loggedAt));
        if (weights.length < 3) continue;

        const first = parseFloat(String(weights[0].weight));
        const last  = parseFloat(String(weights[weights.length - 1].weight));
        if (isNaN(first) || isNaN(last)) continue;

        const change     = last - first;
        // THE BASELINE, NOT THE OVERLAY (2026-08-18, Issue #49 sweep). This read
        // client.calorieTarget — the column it writes forty lines below — exactly the recursion
        // migration 0005 removed from scheduler/jobs/adaptive.ts. 0005 fixed one job; this is the
        // second, and nothing pointed at it.
        //
        // Two defects, not one. The slow ratchet is the obvious half: 2000 → 1900 → 1800 every
        // three weeks, each cut measured from the last cut rather than from the client's profile.
        // The worse half is that since 0005 the daily adaptive job recomputes the visible target
        // from `baseline` every morning at 05:45 — so this job's Sunday-morning write was ERASED
        // by Monday, twenty hours after the client had been told "Calories: 2000 → 1900".
        // A three-week structural re-evaluation is a change to the profile, which is what a
        // baseline IS. It writes both now: the baseline so tomorrow's adaptation starts from it,
        // and the visible target so the number in this message is true when they read it.
        const currentCal  = client.baselineCalorieTarget ?? client.calorieTarget  ?? 1800;
        const currentProt = client.baselineProteinTarget ?? client.proteinTarget  ?? 120;
        const name        = (client.name || "").split(" ")[0] || "there";
        const goal        = client.goalType || "fat_loss";
        const isFemale    = client.gender === "female";
        const calFloor    = isFemale ? 1300 : 1500;

        let newCal:  number | null = null;
        let newProt: number | null = null;
        let msg:     string | null = null;

        if (goal === "fat_loss") {
          // Losing TOO FAST (> ~1% of bodyweight/week across the 3-week window, min 1.8kg)
          // costs muscle, not just fat — the classic failure mode for aggressive dieters and
          // GLP-1 (Ozempic/Wegovy) clients whose appetite is medically suppressed. Raise the
          // floor instead of letting them dig deeper. Mirrors the muscle_gain wrong-direction
          // guard below; without this, only plateaus got corrected, never over-shooting.
          const tooFastKg = Math.max(1.8, last * 0.03);
          if (change <= -tooFastKg && currentCal < 3500) {
            newCal  = currentCal + 150;
            newProt = Math.min(currentProt + 10, 220);
            msg = `${name}, you're down ${Math.abs(change).toFixed(1)}kg in 3 weeks — faster than the safe lane, and losing that quick starts costing you muscle, not just fat. Adjustments:\n\n📈 Calories: *${currentCal} → ${newCal} kcal/day*\n🥩 Protein: *${currentProt} → ${newProt}g/day* (muscle shield)\n\nThe scale slowing down slightly is the plan working, not stalling. Keep training.`;
          } else
          // Plateau window: |change| < 0.5kg — neither losing meaningfully nor gaining.
          // The one-sided change >= -0.3 would fire on significant weight GAIN too ("held steady"
          // being factually wrong). Use abs so we only trigger for true no-movement.
          if (Math.abs(change) < 0.5 && currentCal > calFloor) {
            newCal  = Math.max(calFloor, currentCal - 100);
            newProt = Math.min(currentProt + 10, 220);
            msg = `${name}, your weight has held steady for 3 weeks — your body has adapted to the current deficit. Two small adjustments:\n\n📉 Calories: *${currentCal} → ${newCal} kcal/day*\n🥩 Protein: *${currentProt} → ${newProt}g/day* (higher protein protects muscle while we cut)\n\nSmall change, big impact over time. Keep training, keep logging.`;

            // Plateau detection (runs 1h earlier, same Sunday) tells fat_loss/recomposition
            // clients in this same |change|<=0.5kg band to "keep protein the same" — directly
            // contradicting the protein bump above. Apply the target update either way (it's
            // the real, correct adjustment), but skip the duplicate WhatsApp send so the client
            // doesn't get two conflicting automated messages an hour apart. The new targets still
            // surface naturally at their next weigh-in via the existing "Targets updated" note.
            const [plateauAlreadySent] = await db.select({ id: sentProactive.id }).from(sentProactive)
              .where(and(eq(sentProactive.userId, client.id), eq(sentProactive.messageKey, "plateau"), eq(sentProactive.dedupeWindow, thisWeekUTC())))
              .limit(1);
            if (plateauAlreadySent) msg = null;
          }
        } else if (goal === "muscle_gain") {
          // Fire only when stalled or losing (change < 0.1kg over 3 weeks).
          // change <= 0.3 incorrectly fired when someone was losing weight significantly,
          // sending "weight hasn't moved" when they were actually down 2kg.
          if (change < 0.1 && currentCal < 3500) {
            newCal = Math.min(3500, currentCal + 150);
            if (change < -0.3) {
              // Losing weight on a muscle-gain programme — clearer message than "hasn't moved"
              msg = `${name}, you are losing weight on a muscle-building programme — down ${Math.abs(change).toFixed(1)}kg in 3 weeks. That is the wrong direction. Calories bumped: *${currentCal} → ${newCal} kcal/day*.\n\nAdd carbs around training: rice, oats, sweet potato, banana before gym. Protein stays at ${currentProt}g.`;
            } else {
              msg = `${name}, your weight has not moved in 3 weeks — for muscle gain, that means you need more fuel. Calories bumped: *${currentCal} → ${newCal} kcal/day*.\n\nAdd carbs around training: rice, oats, sweet potato, banana before gym. Protein stays at ${currentProt}g. Your body needs the surplus to grow.`;
            }
          }
        } else if (goal === "recomposition") {
          if (change > 1.0 && currentCal > calFloor) {
            // Gaining too fast — accumulating fat
            newCal = Math.max(calFloor, currentCal - 100);
            msg = `${name}, your weight has gone up ${change.toFixed(1)}kg in 3 weeks. For body recomp we want steady, not gaining. Pulling calories back slightly: *${currentCal} → ${newCal} kcal/day*.\n\nProtein stays at ${currentProt}g. Keep the training consistent — that is where the muscle comes from.`;
          } else if (change < -1.5) {
            // Losing too fast — risking muscle loss
            newCal = Math.min(3500, currentCal + 100);
            msg = `${name}, you are losing faster than expected for recomp — ${Math.abs(change).toFixed(1)}kg in 3 weeks. That is too fast and we risk losing muscle with the fat. Adding calories back: *${currentCal} → ${newCal} kcal/day*.\n\nProtein stays at ${currentProt}g. Recomp is a slow game — the goal is body composition, not just the scale.`;
          }
          // ±0.5kg: perfect recomp — no adjustment needed
        }

        if (newCal !== null) {
          // Claim before mutating targets + sending — DB-backed per 3-week window, restart-safe.
          if (!(await claimProactive(client.id, "cal_adjust", `w${windowKey}`))) continue;
          // Baseline AND overlay. The baseline is what tomorrow's adaptation reasons from; the
          // overlay is the number this message quotes, so it must be true today too.
          const patch: any = { baselineCalorieTarget: newCal, calorieTarget: newCal };
          if (newProt !== null) { patch.baselineProteinTarget = newProt; patch.proteinTarget = newProt; }
          await db.update(users).set(patch).where(eq(users.id, client.id));
          if (msg) await sendWhatsApp(client.phoneNumber, msg);
          adjusted++;
        }
      } catch { /* skip individual client errors */ }
    }
    console.log(`[SCHEDULER] Auto calorie adjustments made: ${adjusted}`);
  } catch (err) { console.error("[SCHEDULER] Auto calorie adjustment error:", err); }
}

export async function runStepTargetAdaptation(): Promise<void> {
  console.log("[SCHEDULER] JOB: Step target adaptation");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runStepTargetAdaptation blocked"); return; }

  // One step adjustment per client per 2-week window
  const windowKey = Math.floor(Date.now() / (14 * 86_400_000));

  try {
    const clients = await getActiveClients();
    let bumped = 0, reduced = 0;

    for (const client of clients) {
      if (isPaused(client)) continue;
      try {
        // BASELINE, for the same reason as the calorie job above: this read the column it writes,
        // so every fortnight's ±1000 was measured from the previous fortnight's ±1000, and the
        // daily adaptive job then recomputed the visible target from `baseline` and undid it.
        const stepsTarget    = client.baselineStepsTarget ?? client.stepsTarget ?? 8500;
        const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
        const sevenDaysAgo    = new Date(Date.now() - 7  * 86_400_000);

        const [recentSteps, recentActivity] = await Promise.all([
          db.select({ steps: stepLogs.steps })
            .from(stepLogs)
            .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fourteenDaysAgo))),
          db.select({ id: chatHistory.id })
            .from(chatHistory)
            .where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, sevenDaysAgo)))
            .limit(1),
        ]);

        if (recentActivity.length === 0) continue; // inactive — skip
        if (recentSteps.length < 7) continue;       // not enough step data

        const daysHit = recentSteps.filter(l => (l.steps || 0) >= stepsTarget).length;
        const hitRate = daysHit / recentSteps.length;
        const name    = (client.name || "").split(" ")[0] || "there";

        if (hitRate >= 0.8 && stepsTarget < 12000) {
          if (!(await claimProactive(client.id, "step_target_adapt", `w${windowKey}`))) continue;
          const newTarget = Math.min(12000, stepsTarget + 1000);
          await db.update(users).set({ baselineStepsTarget: newTarget, stepsTarget: newTarget }).where(eq(users.id, client.id));
          await sendWhatsApp(client.phoneNumber, `${name}, you have been nailing your step target 🔥 Time to raise the bar.\n\nNew target: *${newTarget.toLocaleString()} steps/day*\n\nSame routine — just aim a little further. Your body is ready for it.`);
          bumped++;
        } else if (hitRate <= 0.3 && stepsTarget > 5000) {
          if (!(await claimProactive(client.id, "step_target_adapt", `w${windowKey}`))) continue;
          const newTarget = Math.max(5000, stepsTarget - 1000);
          await db.update(users).set({ baselineStepsTarget: newTarget, stepsTarget: newTarget }).where(eq(users.id, client.id));
          await sendWhatsApp(client.phoneNumber, `${name}, I have adjusted your step target to *${newTarget.toLocaleString()} steps/day*.\n\nThis is not lowering standards — it is setting a target you can actually hit consistently. Hitting ${newTarget.toLocaleString()} every day beats struggling at ${stepsTarget.toLocaleString()} and stopping.\n\nWe raise it again when this feels easy.`);
          reduced++;
        }
      } catch { /* skip individual */ }
    }
    console.log(`[SCHEDULER] Step target adaptation — bumped: ${bumped}, reduced: ${reduced}`);
  } catch (err) { console.error("[SCHEDULER] Step target adaptation error:", err); }
}

export async function runMonthlyNps(): Promise<void> {
  console.log("[SCHEDULER] JOB: Monthly NPS survey");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runMonthlyNps blocked"); return; }
  const today = todaySAST();
  try {
    const activeClients = await db.select({ id: users.id, phoneNumber: users.phoneNumber, name: users.name, subscriptionStatus: users.subscriptionStatus, totalWorkoutsCompleted: users.totalWorkoutsCompleted, programmeStartDate: users.programmeStartDate }).from(users).where(eq(users.subscriptionStatus, "active"));
    let sent = 0;
    for (const client of activeClients) {
      if ((client.totalWorkoutsCompleted || 0) < 3) continue;
      // Atomic daily-slot claim replaces the non-atomic "already sent today" check.
      if (!(await claimDailySlot(client.id, "monthly_nps"))) continue;
      const name = client.name?.split(" ")[0] || "there";
      await sendWhatsApp(client.phoneNumber, `${name}, one question:\n\nHow likely are you to recommend Coach K to a friend? Reply with a number from 1 to 10.\n\n1 = Not at all. 10 = Definitely.\n\nHonest answer only — I read every one.`);
      sent++;
    }
    console.log(`[SCHEDULER] NPS surveys sent: ${sent}`);
  } catch (err) { console.error("[SCHEDULER] NPS survey error:", err); }
}
