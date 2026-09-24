import type { Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { users, chatHistory, paymentEvents, adminEvents, escalations } from "../../shared/schema";
import { escalationSLA } from "../safety-detection";
import { sastDayKey } from "../sast";
import { eq, and, asc } from "drizzle-orm";
import twilio from "twilio";
import { PRICING, GUARANTEE_PHRASE } from "../../shared/pricing";
import { sendCriticalAlert } from "../scheduler/shared";
import { deliverTwilioMessage } from "../outbound-delivery";
import { isOptedOut } from "../health-state";

function checkAdminKey(provided: string | string[] | undefined): boolean {
  const dashKey = process.env.COACH_DASHBOARD_KEY;
  if (!dashKey) return false;
  const key = (Array.isArray(provided) ? provided[0] : provided) || "";
  try { return key.length === dashKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(dashKey)); } catch { return false; }
}

/** PHP urlencode(), which is what PayFast hashes: spaces as "+", and !'()*~ escaped. */
function phpUrlencode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

/**
 * THE SUBSCRIPTION THE CLIENT IS PAYING ON (2026-09-22). PayFast identifies a recurring
 * subscription by its `token`, which arrives on every COMPLETE ITN and is kept in
 * payment_events.raw_body. `excludeEventKey` skips the ITN being processed right now, so the
 * answer is "the subscription they were paying on before this notification".
 */
export async function latestPayFastToken(phone: string, excludeEventKey = ""): Promise<string | null> {
  const { pool } = await import("../db");
  const { rows } = await pool.query<{ token: string }>(
    `SELECT raw_body->>'token' AS token FROM payment_events
      WHERE provider = 'payfast' AND phone = $1 AND payment_status = 'COMPLETE'
        AND COALESCE(raw_body->>'token', '') <> '' AND provider_payment_id <> $2
      ORDER BY processed_at DESC LIMIT 1`,
    [phone, excludeEventKey],
  );
  return rows[0]?.token ?? null;
}

/**
 * CANCEL THE RECURRING BILLING AT PAYFAST (2026-09-22). Until this existed, "yes, cancel" set the
 * row inactive and told the client "you will not be charged again" while the PayFast subscription
 * kept billing — nothing ever reached PayFast. PUT /subscriptions/{token}/cancel, signed the way
 * PayFast's SDK signs API calls (Auth::generateApiSignature: the headers plus the passphrase,
 * sorted by key, PHP-urlencoded, md5). Never throws: the caller must be able to tell the client
 * the truth either way, so failure is a value.
 */
export async function cancelPayFastSubscription(token: string | null): Promise<{ ok: boolean; detail: string }> {
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  if (!token) return { ok: false, detail: "no PayFast subscription token on file" };
  if (!merchantId || !passphrase) return { ok: false, detail: "PAYFAST_MERCHANT_ID or PAYFAST_PASSPHRASE not set" };
  const timestamp = new Date().toISOString().slice(0, 19) + "+00:00"; // ISO-8601 with offset, as PayFast requires
  const headers: Record<string, string> = { "merchant-id": merchantId, version: "v1", timestamp };
  const signed: Record<string, string> = { ...headers, passphrase };
  const signature = crypto.createHash("md5")
    .update(Object.keys(signed).sort().map(k => `${k}=${phpUrlencode(signed[k])}`).join("&"))
    .digest("hex");
  const url = `https://api.payfast.co.za/subscriptions/${encodeURIComponent(token)}/cancel`
    + (process.env.PAYFAST_SANDBOX === "true" ? "?testing=true" : "");
  try {
    const res = await fetch(url, { method: "PUT", headers: { ...headers, signature }, signal: AbortSignal.timeout(10_000) });
    const body: any = await res.json().catch(() => null);
    if (res.ok && body?.status === "success") return { ok: true, detail: "cancelled at PayFast" };
    return { ok: false, detail: `PayFast HTTP ${res.status}: ${JSON.stringify(body?.data ?? body)}`.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, detail: `PayFast request failed: ${e?.message || e}`.slice(0, 200) };
  }
}

/** A date N business days from now, as the client reads it in SAST ("Wed 1 Oct"). */
function businessDaysFromNow(n: number, from = new Date()): string {
  const d = new Date(`${sastDayKey(from)}T12:00:00Z`); // the SAST calendar day, from its one owner
  for (let added = 0; added < n;) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) added++; }
  return d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * THE 14-DAY MONEY-BACK GUARANTEE, END TO END (#328). It was advertised on five surfaces while
 * "refund" opened a manual form and told the client "your coach has been notified" — nobody was.
 * Now, from the client's own payment record:
 *   - within the guarantee: billing is cancelled through the same path as a client's own cancel
 *     (#263), the refund OWED is recorded with a due date, the founder gets the exact refund to
 *     issue, and the client is told the truth ("billing cancelled" only when PayFast confirmed it);
 *   - outside it, or with no payment on record: the founder really is alerted, and the client is
 *     told why this is not an automatic guarantee refund;
 *   - asked again: the client is told the refund already owed, and nothing is recorded twice.
 */
export async function handleRefundRequest(user: any, phone: string): Promise<string> {
  const name = (user.name || "").split(" ")[0] || "there";
  // The founder's task, with a deadline, in the escalation queue the dashboard already works from.
  // ONE task per client: the generic billing escalation ("refund" in the message) may already have
  // opened it, so the guarantee's details are written INTO that case rather than beside it.
  const founderTask = async (priority: "urgent" | "high" | "normal", text: string) => {
    const [open] = await db.select({ id: escalations.id }).from(escalations)
      .where(and(eq(escalations.userId, user.id), eq(escalations.reason, "billing"), eq(escalations.status, "open"))).limit(1);
    const fields = { triggerMessage: text.slice(0, 500), priority, slaDeadline: escalationSLA(priority) };
    await (open ? db.update(escalations).set(fields).where(eq(escalations.id, open.id)) : db.insert(escalations).values({ userId: user.id, reason: "billing", ...fields }))
      .catch((e) => console.error("[REFUND] escalation write failed:", e));
  };
  const [owed] = await db.select({ meta: adminEvents.meta }).from(adminEvents)
    .where(and(eq(adminEvents.targetPhone, phone), eq(adminEvents.action, "refund_guarantee_owed"))).limit(1);
  if (owed) {
    const due = (owed.meta as any)?.dueBy || "within 5 business days";
    return `${name}, your refund under the ${GUARANTEE_PHRASE} is already on its way. It goes back to the card or account you paid with by ${due}.`;
  }
  const [first] = await db.select({ at: paymentEvents.processedAt, amount: paymentEvents.amountGross, id: paymentEvents.providerPaymentId })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.phone, phone), eq(paymentEvents.provider, "payfast"), eq(paymentEvents.paymentStatus, "COMPLETE")))
    .orderBy(asc(paymentEvents.processedAt)).limit(1);
  const paidOn = first?.at ? new Date(first.at).toLocaleDateString("en-ZA", { day: "numeric", month: "long", timeZone: "Africa/Johannesburg" }) : null;
  const withinGuarantee = !!first?.at && Date.now() - new Date(first.at).getTime() <= PRICING.guaranteeDays * 86_400_000;

  if (!withinGuarantee) {
    await db.insert(adminEvents).values({ action: "refund_requested_outside_guarantee", targetPhone: phone, reason: paidOn ? `first payment ${paidOn}` : "no payment on record", meta: { firstPaymentId: first?.id ?? null } })
      .catch((e) => console.error("[REFUND] adminEvents insert failed:", e));
    await founderTask("normal", `Refund asked for. ${paidOn ? `First payment ${paidOn}, outside the ${PRICING.guaranteeDays}-day guarantee.` : "No PayFast payment on record for this number."} Reply to the client within 24 hours.`);
    return paidOn
      ? `${name}, your first payment was on ${paidOn}, so this is outside the ${GUARANTEE_PHRASE}. I've sent your request to the founder, who will reply to you here within 24 hours.`
      : `${name}, I can't find a payment from this number, so I've sent your request to the founder, who will reply to you here within 24 hours.`;
  }

  const amount = first!.amount ? `R${Number(first!.amount).toFixed(0)}` : `R${PRICING.monthlyPriceZAR}`;
  const dueBy = businessDaysFromNow(5);
  let billingOk = true;
  let detail = "subscription already inactive";
  if (user.subscriptionStatus === "active") {
    const token = await latestPayFastToken(phone);
    const billing = await cancelPayFastSubscription(token);
    billingOk = billing.ok; detail = billing.detail;
    await db.update(users).set({ subscriptionStatus: "inactive", cancelledAt: new Date(), subscriptionEndReason: "refund_guarantee" }).where(eq(users.phoneNumber, phone));
  }
  await db.insert(adminEvents).values({
    action: "refund_guarantee_owed", targetPhone: phone, reason: detail,
    meta: { amount, firstPaymentId: first!.id, dueBy, billingCancelConfirmed: billingOk },
  });
  await founderTask(billingOk ? "high" : "urgent", `Guarantee refund OWED: ${amount}, PayFast payment ${first!.id}, by ${dueBy}. Refund it in the PayFast dashboard.${billingOk ? "" : ` PayFast did NOT confirm the billing cancel (${detail}): cancel it by hand too.`}`);
  return `${name}, you're within the ${GUARANTEE_PHRASE}, so your ${amount} is coming back to you. Your coaching is stopped ${billingOk ? "and your recurring billing is cancelled" : "and your recurring billing is being cancelled by hand today"}. The refund goes back to the card or account you paid with by ${dueBy}.`;
}

export function registerPaymentRoutes(app: Express) {

  // ── Twilio delivery status webhook ──
  app.post("/webhook/status", (req: any, res: any) => {
    // Validate Twilio signature — prevents forged delivery status poisoning our logs.
    // FAILS CLOSED (#341): with no token there is nothing to check a signature against, so every
    // request is refused, in every environment. The repo is public and the path is known; only
    // Twilio sends here, and Twilio only sends when the token is configured.
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";
    if (!authToken) {
      console.error("[SECURITY] Delivery status — TWILIO_AUTH_TOKEN not set; rejecting request");
      return res.status(503).end();
    }
    const sig = (req.headers["x-twilio-signature"] as string) || "";
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    const fullUrl = `${proto}://${req.get("host")}${req.originalUrl}`;
    if (!twilio.validateRequest(authToken, sig, fullUrl, req.body)) {
      console.warn(`[SECURITY] Delivery status — invalid Twilio signature from ${req.ip}`);
      return res.status(403).end();
    }
    res.sendStatus(200);
    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
      // Normalise to the same canonical format stored in users.phoneNumber
      const raw = (To || "");
      const phone = raw.startsWith("whatsapp:") ? raw : `whatsapp:${raw}`;
      if (MessageStatus === "failed" || MessageStatus === "undelivered") {
        console.error(`[DELIVERY FAIL] ${phone.slice(-4)} | SID: ${MessageSid} | Status: ${MessageStatus} | Error: ${ErrorCode} — ${ErrorMessage || "no detail"}`);
        db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1)
          .then(rows => {
            if (rows[0]) {
              db.insert(chatHistory).values({
                userId: rows[0].id,
                messageIn: null,
                messageOut: null,
                intent: `DELIVERY_${MessageStatus.toUpperCase()}`,
              }).catch(() => {});
            }
          }).catch(() => {});
      } else if (MessageStatus === "delivered") {
        console.log(`[DELIVERY OK] ${phone.slice(-4)} | SID: ${MessageSid}`);
      }
    } catch (e) {
      console.error("[DELIVERY STATUS] Parse error:", e);
    }
  });

  // ── PayFast ITN webhook ──
  // PayFast's production servers send ITNs from a known CIDR range.
  // Requests from any other IP are logged as suspicious (not rejected outright,
  // because the signature check is the authoritative guard and PayFast occasionally
  // uses new IPs before updating their docs — but the log lets us spot spoofing).
  // Sandbox/local bypasses the check when NODE_ENV !== 'production'.
  const PAYFAST_IP_RANGES = [
    // PayFast production — https://developers.payfast.co.za/docs#step_4_verify_itn
    "197.97.145.", // 197.97.145.144/28
    "41.74.179.",  // 41.74.179.192/27
  ];
  function isPayFastIp(ip: string): boolean {
    if (process.env.NODE_ENV !== "production") return true;
    const clean = ip.replace(/^::ffff:/, ""); // strip IPv4-mapped prefix
    return PAYFAST_IP_RANGES.some(prefix => clean.startsWith(prefix));
  }

  app.post("/webhook/payfast", async (req: any, res: any) => {
    res.sendStatus(200);
    const itnId = `ITN-${Date.now()}`;
    const requestIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "";
    if (!isPayFastIp(requestIp)) {
      console.warn(`[PAYFAST:${itnId}] ⚠️  ITN from non-PayFast IP: ${requestIp} — proceeding but flagged for review`);
    }
    try {
      const data = req.body as Record<string, string>;
      const paymentStatus = data.payment_status;
      const phone = data.custom_str1;
      const pfPaymentId = data.pf_payment_id;
      const amountGross = parseFloat(data.amount_gross || "0");
      const safePhone = phone ? phone.replace(/\d{4}$/, "****") : "unknown";

      console.log(`[PAYFAST:${itnId}] ITN received — status=${paymentStatus} phone=${safePhone} amount=R${amountGross} pf_id=${pfPaymentId || "none"}`);

      if (!phone || !paymentStatus) {
        console.error(`[PAYFAST:${itnId}] REJECTED — missing phone or payment_status. Body keys: ${Object.keys(data).join(", ")}`);
        return;
      }

      // Validate signature — passphrase is REQUIRED; reject if not configured
      const passphrase = process.env.PAYFAST_PASSPHRASE;
      if (!passphrase) {
        console.error(`[PAYFAST:${itnId}] REJECTED — PAYFAST_PASSPHRASE env var not set. Cannot validate ITN signature safely. Configure it in Railway.`);
        return;
      }
      // FIELD ORDER (2026-09-22). PayFast signs an ITN over its fields IN THE ORDER IT SENDS
      // THEM — PayFast's own SDK validates it that way (PaymentIntegrations/Notification.php,
      // dataToString: no sort, stops at `signature`). 629610e (2026-06-19) re-sorted the keys on
      // the belief that the ITN spec required it, noting it "may fix" failures; sorting is the
      // rule for API calls, not for ITNs. Received order is the canonical check. The sorted form
      // is still accepted, so a deploy that is wrong about PayFast in either direction activates
      // nobody less than before — the log line says which one matched, and once Railway shows only
      // "received" the sorted branch should be deleted.
      const fields = Object.entries(data).filter(([k]) => k !== "signature");
      const md5Of = (pairs: [string, string][], enc: (v: string) => string) => crypto.createHash("md5")
        .update(`${pairs.map(([k, v]) => `${k}=${enc(String(v))}`).join("&")}&passphrase=${enc(passphrase)}`)
        .digest("hex");
      const legacyEnc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
      const candidates: [string, string][] = [
        ["received", md5Of(fields, phpUrlencode)],
        ["sorted_legacy", md5Of([...fields].sort(([a], [b]) => a.localeCompare(b)), legacyEnc)],
      ];
      const sent = String(data.signature || "");
      const matched = sent
        ? candidates.find(([, sig]) => sig.length === sent.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(sig)))
        : undefined;
      if (!matched) {
        console.error(`[PAYFAST:${itnId}] REJECTED — signature ${sent ? "mismatch" : "missing"} for ${safePhone}.`);
        return;
      }
      console.log(`[PAYFAST:${itnId}] Signature valid (order=${matched[0]})`);

      // Validate merchant ID
      const expectedMerchantId = process.env.PAYFAST_MERCHANT_ID;
      if (expectedMerchantId && data.merchant_id !== expectedMerchantId) {
        console.error(`[PAYFAST:${itnId}] REJECTED — merchant ID mismatch (got ${data.merchant_id}, expected ${expectedMerchantId})`);
        return;
      }

      // Amount validation — must match the subscription price within R5 tolerance.
      // Accepting any amount between R1–500 would allow someone to pay R1 and get a subscription.
      if (paymentStatus === "COMPLETE" && Math.abs(amountGross - PRICING.monthlyPriceZAR) > 5) {
        console.error(`[PAYFAST:${itnId}] REJECTED — amount R${amountGross} doesn't match expected R${PRICING.monthlyPriceZAR} (tolerance ±R5)`);
        return;
      }

      // Rebuild from digits so the lookup matches regardless of how PayFast encodes
      // custom_str1 on the ITN. Form-encoded POST bodies decode "+" to a space, so a
      // value sent as "+27..." can arrive as "27..." or " 27..." — all must resolve to
      // the canonical "whatsapp:+<digits>" Twilio stores.
      const phoneDigits = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const normalisedPhone = `whatsapp:+${phoneDigits}`;
      const [targetUser] = await db.select().from(users).where(eq(users.phoneNumber, normalisedPhone)).limit(1);
      if (!targetUser) {
        console.error(`[PAYFAST:${itnId}] REJECTED — no user found for phone: ${safePhone}`);
        return;
      }
      console.log(`[PAYFAST:${itnId}] User found — id=${targetUser.id} current_status=${targetUser.subscriptionStatus}`);

      // Idempotency guard — if we have already processed this pf_payment_id, skip entirely.
      // PayFast retries ITNs multiple times; without this, a retry causes duplicate rewards/messages.
      const eventKey = pfPaymentId || data.m_payment_id || `${phone}-${amountGross}-no-id`;
      try {
        await db.insert(paymentEvents).values({
          provider: "payfast",
          providerPaymentId: eventKey,
          phone: normalisedPhone,
          amountGross: String(amountGross),
          paymentStatus,
          rawBody: data as Record<string, unknown>,
        });
      } catch (idempErr: any) {
        // Postgres unique violation code 23505 means already processed
        if (idempErr?.code === "23505" || idempErr?.message?.includes("unique")) {
          console.log(`[PAYFAST:${itnId}] SKIPPED — duplicate ITN for pf_id=${pfPaymentId || "no-id"}`);
          return;
        }
        // Any other insert error is unexpected — log but continue processing
        console.error(`[PAYFAST:${itnId}] idempotency insert failed (non-duplicate):`, idempErr);
      }

      // THE ITN'S NOTICES (#265): through the delivery owner rather than a private Twilio client —
      // same text, same number, plus retries and delivery receipts — and never to someone who opted
      // out. `fromNum` is empty for an opted-out payer, so every notice to them below stands down.
      const fromNum = !isOptedOut(targetUser) && process.env.TWILIO_WHATSAPP_NUMBER ? "set" : "";
      const notify = (to: string, body: string) => deliverTwilioMessage(to, { body }, { label: "payfast", retryDelaysMs: [0, 2000] });

      // A CHARGE ON A SUBSCRIPTION THE CLIENT CANCELLED (2026-09-22). This used to fall into the
      // activation below: status active, cancelled_at nulled, "Subscription renewed" — the
      // client's decision erased by the money taken against it. The same token they were paying
      // on when they cancelled means this is that subscription, still billing. A different token
      // is a new subscription they chose, and activates as normal.
      if (paymentStatus === "COMPLETE" && targetUser.subscriptionEndReason === "client_cancelled" && data.token
        && data.token === await latestPayFastToken(normalisedPhone, eventKey)) {
        const retry = await cancelPayFastSubscription(data.token);
        await db.insert(adminEvents).values({
          action: "charged_after_cancellation",
          targetPhone: normalisedPhone,
          reason: `COMPLETE ITN on cancelled subscription; cancel retry: ${retry.detail}`,
          meta: { pfPaymentId, token: data.token, amountGross, cancelRetryOk: retry.ok },
        }).catch(e => console.error("[PAYFAST] adminEvents insert failed:", e));
        console.error(`[PAYFAST:${itnId}] CHARGED AFTER CANCELLATION — ${safePhone} R${amountGross} pf_id=${pfPaymentId} — client left inactive`);
        const coachAlertPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
        if (coachAlertPhone) {
          await sendCriticalAlert(`whatsapp:+${coachAlertPhone.replace(/\D/g, "")}`, `[BILLING] ${targetUser.name || "Client"} (${normalisedPhone}) was charged R${amountGross} (pf ${pfPaymentId}) on a subscription they cancelled. They are still cancelled. Refund this payment. PayFast cancel retry: ${retry.ok ? "confirmed" : `FAILED — cancel token ${data.token} by hand`}.`)
            .catch(e => console.error("[PAYFAST] founder alert failed:", e));
        }
        return;
      }

      if (paymentStatus === "COMPLETE") {
        const renewsAt = new Date(Date.now() + 30 * 86_400_000);
        const wasInactive = targetUser.subscriptionStatus !== "active";

        // All DB state changes in one transaction — subscription update + referral reward
        let referrerData: { phone: string; name: string | null; newExpiry: Date; optedOut: boolean } | null = null;
        await db.transaction(async (tx) => {
          await tx.update(users).set({
            subscriptionStatus: "active",
            subscriptionRenewsAt: renewsAt,
            paymentReference: pfPaymentId || null,
            cancelledAt: null,
            subscriptionEndReason: null,
          }).where(eq(users.phoneNumber, normalisedPhone));

          if (wasInactive && targetUser.referredBy) {
            // Idempotent guard — only reward the referrer ONCE per referred user, ever.
            // A user who cancels and re-subscribes would otherwise trigger the reward again.
            // The payment_events unique index on (provider, providerPaymentId) is the lock.
            const sentinel = await tx.insert(paymentEvents)
              .values({
                provider: "referral",
                providerPaymentId: `REF_REWARD_${targetUser.id}`,
                phone: normalisedPhone,
                amountGross: "0",
                paymentStatus: "REWARD",
                rawBody: {},
              })
              .onConflictDoNothing()
              .returning({ id: paymentEvents.id });

            if (sentinel.length > 0) {
              // referredBy stores the inviter's user id (UUID), set in the "join CODE" flow —
              // match on users.id, not users.referralCode, or the referrer is never found.
              const [referrer] = await tx.select().from(users)
                .where(eq(users.id, targetUser.referredBy))
                .limit(1);
              if (referrer && referrer.subscriptionStatus === "active") {
                const newExpiry = new Date(
                  Math.max(Date.now(), new Date(referrer.subscriptionRenewsAt || Date.now()).getTime()) + 30 * 86_400_000
                );
                await tx.update(users)
                  .set({ subscriptionRenewsAt: newExpiry })
                  .where(eq(users.id, referrer.id));
                referrerData = { phone: referrer.phoneNumber, name: referrer.name, newExpiry, optedOut: isOptedOut(referrer) };
              }
            }
          }
        });

        console.log(`[PAYFAST] Payment COMPLETE — ...${normalisedPhone.slice(-4)} | R${amountGross} | renews ${renewsAt.toISOString().slice(0, 10)}`);

        // Send notifications AFTER the transaction commits (Twilio calls can't be rolled back)
        if (referrerData) {
          const { phone: refPhone, name: refName, newExpiry, optedOut: refOptedOut } = referrerData as { phone: string; name: string | null; newExpiry: Date; optedOut: boolean };
          const refTo = refPhone.startsWith("whatsapp:") ? refPhone : `whatsapp:${refPhone}`;
          if (process.env.TWILIO_WHATSAPP_NUMBER && !refOptedOut) {
            await notify(refTo, `${refName || "Hey"} Your referral just joined KamLife Coach! You have earned one free month — your subscription has been extended to ${newExpiry.toISOString().slice(0, 10)}. Keep sharing your code and keep stacking free months.`).catch(e => console.error("[REFERRAL] Notify error:", e));
          }
          console.log(`[REFERRAL] Rewarded ${refPhone} — extended to ${(referrerData as any).newExpiry.toISOString().slice(0, 10)}`);
        }

        // Welcome / renewal WhatsApp
        const name = targetUser.name || "there";
        const isRenewal = targetUser.subscriptionStatus === "active";

        if (isRenewal) {
          if (fromNum) {
            await notify(normalisedPhone, `Payment confirmed, ${name}. Subscription renewed for another month. Coach K is here — let's go.`);
          }
        } else {
          if (fromNum) {
            const goalLabel: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomp" };
            const modeLabel: Record<string, string> = { gym: "Gym", gym_dumbbell: "Dumbbell gym", home: "Home", walk_only: "Walk + home" };
            const welcomeMsg = `Payment confirmed, ${name}. Welcome to KamLife Coach.\n\nGoal: ${goalLabel[targetUser.goalType || "fat_loss"] || "fat loss"} · Mode: ${modeLabel[targetUser.trainingMode || "home"] || "Home"} · Phase 1\n\n*What to expect:*\nWeek 1–2: Your body adapts. Energy improves. Scale may not move yet — this is normal.\nWeek 3: The hard week. Mirror hasn't changed. Most people quit here. Don't.\nWeek 4–6: Visible changes start. This is where the work pays off.\nWeek 8–12: Real transformation. Clothes fit differently. Strength up.\n\nCoach K checks in every morning and evening. Log everything — meals, steps, workouts. The more you log, the better I coach you.\n\n_Coach K is AI-powered — not a human coach and not a doctor. Always consult your doctor for medical advice._\n\nYour Day 1 workout is below. Do it today and reply *done* when finished.`;
            await notify(normalisedPhone, welcomeMsg);

            try {
              const { buildDay1Workout } = await import("../programme");
              const day1 = buildDay1Workout(targetUser);
              if (day1) {
                // The Day-1 workout now ships as several \n\n---\n\n bubbles and can exceed
                // Twilio's 1600-char body cap as one message (rejected outright, error 21617 —
                // the new client's first workout silently never arrived). Send each bubble.
                for (const part of day1.split(/\n\n---\n\n/)) {
                  const p = part.trim();
                  if (p) await notify(normalisedPhone, p);
                }
              }
            } catch (e) {
              console.error("[PAYFAST] Day 1 workout delivery error:", e);
            }
          }
        }
      } else if (paymentStatus === "CANCELLED") {
        // Our own API cancel makes PayFast send this. The client already cancelled, was already
        // told, and their cancelled_at is the moment they decided — leave all three alone.
        if (targetUser.subscriptionEndReason === "client_cancelled" && targetUser.subscriptionStatus === "inactive") {
          console.log(`[PAYFAST:${itnId}] CANCELLED ITN confirms the client's own cancel — ${safePhone}`);
          return;
        }
        // A CANCELLATION IS FOR ONE SUBSCRIPTION (Codex attack @ 1309c98). A late or retried
        // CANCELLED for token A, arriving after the client rejoined on token B, ended the
        // subscription they were paying on. Only the one they are paying on now can be ended here.
        const current = data.token ? await latestPayFastToken(normalisedPhone, eventKey) : null;
        if (data.token && current && current !== data.token) {
          console.log(`[PAYFAST:${itnId}] CANCELLED ITN for superseded token — ${safePhone} is on a newer subscription; nothing changed`);
          return;
        }
        await db.update(users).set({
          subscriptionStatus: "inactive",
          cancelledAt: new Date(),
          subscriptionEndReason: "payfast_cancelled",
        }).where(eq(users.phoneNumber, normalisedPhone));

        console.log(`[PAYFAST] Subscription CANCELLED — ${normalisedPhone}`);

        if (fromNum) {
          const name = targetUser.name || "there";
          await notify(normalisedPhone, `${name}, your KamLife Coach subscription has been cancelled. Your progress is saved — you can rejoin anytime. Reply *join* when you are ready.`)
            .catch(e => console.error("[TWILIO_CANCEL_NOTIFY]", e?.message || e));
        }
      } else if (paymentStatus === "PENDING") {
        // EFT / manual payments show PENDING before COMPLETE. Log and wait — do NOT
        // activate the subscription yet. A subsequent COMPLETE ITN will activate.
        console.log(`[PAYFAST:${itnId}] Payment PENDING — ${normalisedPhone} | R${amountGross} — awaiting COMPLETE`);
      } else if (paymentStatus === "REFUND" || paymentStatus === "REFUNDED") {
        // User was refunded — suspend access immediately.
        await db.update(users).set({
          subscriptionStatus: "inactive",
          cancelledAt: new Date(),
          subscriptionEndReason: "refunded",
        }).where(eq(users.phoneNumber, normalisedPhone));
        console.log(`[PAYFAST:${itnId}] Payment REFUNDED — ${normalisedPhone} — subscription deactivated`);
        await db.insert(adminEvents).values({
          action: "subscription_refunded",
          targetPhone: normalisedPhone,
          reason: `PayFast REFUND ITN received`,
          meta: { pfPaymentId, amountGross },
        }).catch(e => console.error("[PAYFAST] adminEvents insert failed:", e));
        if (fromNum) {
          const name = targetUser.name || "there";
          await notify(normalisedPhone, `${name}, your KamLife Coach payment has been refunded. Your access has been paused. If this is a mistake, reply *pay* or contact us at support@kamlifecoach.co.za.`)
            .catch(e => console.error("[TWILIO_REFUND_NOTIFY]", e?.message || e));
        }
      } else if (paymentStatus === "REFUND_REVERSED") {
        // Chargeback reversed — reinstate if the user is still inactive.
        if (targetUser.subscriptionStatus === "inactive") {
          const renewsAt = new Date(Date.now() + 30 * 86_400_000);
          await db.update(users).set({ subscriptionStatus: "active", subscriptionRenewsAt: renewsAt, cancelledAt: null, subscriptionEndReason: null })
            .where(eq(users.phoneNumber, normalisedPhone));
          console.log(`[PAYFAST:${itnId}] REFUND_REVERSED — ${normalisedPhone} — subscription reinstated`);
        }
      } else {
        console.warn(`[PAYFAST:${itnId}] Unhandled payment_status: ${paymentStatus} — logged but no action taken`);
      }
    } catch (err) {
      console.error(`[PAYFAST:${itnId}] Webhook processing error:`, err);
    }
  });

  // ── Admin: force-activate stuck subscription ──
  // Use when PayFast ITN fires but webhook fails (network blip, etc.) and user paid but DB didn't update.
  // Protected by COACH_DASHBOARD_KEY so only the coach can call it.
  app.post("/api/admin/force-activate", async (req: any, res: any) => {
    if (!checkAdminKey(req.headers["x-coach-key"])) return res.status(403).json({ error: "Forbidden" });
    try {
      const { phone, reason } = req.body as { phone?: string; reason?: string };
      if (!phone) return res.status(400).json({ error: "phone required" });
      // Normalise from digits — admin may paste with/without "+" or "whatsapp:" prefix.
      const phoneDigits = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const normalisedPhone = `whatsapp:+${phoneDigits}`;
      const [targetUser] = await db.select().from(users).where(eq(users.phoneNumber, normalisedPhone)).limit(1);
      if (!targetUser) return res.status(404).json({ error: "User not found" });
      const renewsAt = new Date(Date.now() + 30 * 86_400_000);
      await db.update(users).set({
        subscriptionStatus: "active",
        subscriptionRenewsAt: renewsAt,
        cancelledAt: null,
        subscriptionEndReason: null,
      }).where(eq(users.phoneNumber, normalisedPhone));
      await db.insert(adminEvents).values({
        action: "force_activate",
        targetPhone: normalisedPhone,
        reason: reason || "manual",
        meta: { renewsAt: renewsAt.toISOString(), userId: targetUser.id } as Record<string, unknown>,
      }).catch(e => console.error("[ADMIN_EVENTS] Insert failed:", e));
      console.log(`[PAYFAST] FORCE-ACTIVATE — ${normalisedPhone} | reason: ${reason || "manual"} | renews: ${renewsAt.toISOString().slice(0, 10)}`);
      return res.json({ ok: true, phone: normalisedPhone, renewsAt: renewsAt.toISOString().slice(0, 10) });
    } catch (err) {
      console.error("[PAYFAST] Force-activate error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Admin: test Twilio button (Content API) ──
  app.get("/api/admin/test-buttons", async (req: any, res: any) => {
    if (!checkAdminKey(req.headers["x-coach-key"])) return res.status(403).json({ error: "Forbidden" });
    const to = req.query.to as string;
    if (!to) return res.status(400).json({ error: "?to=whatsapp:+27..." });
    try {
      const { sendWhatsAppButtons } = await import("../twilio-interactive");
      await sendWhatsAppButtons(to.startsWith("whatsapp:") ? to : `whatsapp:${to}`, "Button test from Coach K", ["Option A", "Option B", "Option C"]);
      return res.json({ ok: true, message: "Button send attempted — check WhatsApp and Railway logs for [BUTTONS] lines" });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message, stack: err?.stack?.split("\n").slice(0, 5) });
    }
  });

  // ── PayFast payment link generator ──
  // No admin gate — users hit this when clicking their pay link from WhatsApp.
  // Rate-limited to prevent phone number enumeration and link-spam.
  // Security: PayFast validates the signature on the ITN; this endpoint only builds a URL.
  const linkRateBuckets = new Map<string, { count: number; resetAt: number }>();
  app.get("/api/payfast/link", (req: any, res: any, next: any) => {
    const now = Date.now();
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
    const bucket = linkRateBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      linkRateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > 10) return res.status(429).json({ error: "Too many requests" });
    return next();
  }, async (req: any, res: any) => {
    try {
      const phone = decodeURIComponent(req.query.phone as string || "");
      if (!phone) return res.status(400).json({ error: "phone required" });
      if (!/^\+?\d{9,15}$/.test(phone.replace(/^whatsapp:/, ""))) return res.status(400).json({ error: "Invalid phone format" });

      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
      if (!merchantId || !merchantKey) {
        return res.status(503).json({ error: "PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY env vars not set" });
      }

      const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`)).limit(1);
      const name = user?.name || "KamLife Client";
      const isSandbox = process.env.PAYFAST_SANDBOX === "true";
      const baseUrl = isSandbox ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process";
      const railwayBase = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
      const rawBase = (process.env.APP_URL || railwayBase || "https://kamlifecoach.co.za").replace(/\/$/, "");
      const appBase = /^https?:\/\//i.test(rawBase) ? rawBase : `https://${rawBase}`;
      const returnUrl = `${appBase}/payment-success`;
      const cancelUrl = `${appBase}/payment-cancel`;
      const notifyUrl = `${appBase}/webhook/payfast`;
      const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");

      const params = new URLSearchParams({
        merchant_id: merchantId,
        merchant_key: merchantKey,
        return_url: returnUrl,
        cancel_url: cancelUrl,
        notify_url: notifyUrl,
        name_first: name.split(" ")[0] || name,
        name_last: name.split(" ").slice(1).join(" ") || "",
        email_address: `${cleanPhone}@kamlife.local`,
        m_payment_id: `KAMLIFE-${cleanPhone}-${Date.now()}`,
        amount: String(PRICING.monthlyPriceZAR) + ".00",
        item_name: "KamLife Coach — Monthly Subscription",
        item_description: "WhatsApp fitness and nutrition coaching",
        custom_str1: phone.replace(/^whatsapp:/, ""),
        subscription_type: "1",
        billing_date: new Date().toISOString().slice(0, 10),
        recurring_amount: String(PRICING.monthlyPriceZAR) + ".00",
        frequency: "3",
        cycles: "0",
      });

      const payfastUrl = `${baseUrl}?${params.toString()}`;
      // Admin API callers (dashboard) pass ?json=1 to get the URL as JSON
      if (req.query.json === "1") return res.json({ url: payfastUrl, phone, name });
      // All other callers (WhatsApp link taps, SMS links) get a direct redirect to PayFast
      return res.redirect(302, payfastUrl);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: payment reconciliation ──
  // Lists active subscribers who have no payment_events record — likely manually activated.
  // Also lists admin_events history so every force-activate is visible.
  app.get("/api/admin/reconcile", async (req: any, res: any) => {
    if (!checkAdminKey(req.headers["x-coach-key"])) return res.status(403).json({ error: "Forbidden" });
    try {
      const { pool } = await import("../db");
      // Active users with no matching payment event
      const unpairedResult = await pool.query(`
        SELECT u.id, u.phone_number, u.name, u.subscription_status,
               u.subscription_renews_at, u.payment_reference, u.created_at
        FROM users u
        LEFT JOIN payment_events pe ON pe.phone = u.phone_number
        WHERE u.subscription_status = 'active' AND pe.id IS NULL
        ORDER BY u.subscription_renews_at ASC
        LIMIT 100
      `);
      // Recent admin events
      const eventsResult = await pool.query(`
        SELECT action, target_phone, reason, meta, performed_at
        FROM admin_events
        ORDER BY performed_at DESC
        LIMIT 50
      `);
      return res.json({
        activeWithNoPaymentEvent: unpairedResult.rows,
        adminActions: eventsResult.rows,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
