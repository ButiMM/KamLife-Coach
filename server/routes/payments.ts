import type { Express } from "express";
import { db } from "../db";
import { users, chatHistory, paymentEvents } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import twilio from "twilio";
import { PRICING } from "../../shared/pricing";

export function registerPaymentRoutes(app: Express) {

  // ── Twilio delivery status webhook ──
  app.post("/webhook/status", (req: any, res: any) => {
    res.sendStatus(200);
    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
      if (MessageStatus === "failed" || MessageStatus === "undelivered") {
        const phone = (To || "").replace(/^whatsapp:/, "");
        console.error(`[DELIVERY FAIL] ${phone} | SID: ${MessageSid} | Status: ${MessageStatus} | Error: ${ErrorCode} — ${ErrorMessage || "no detail"}`);
        db.update(users)
          .set({ lastActiveAt: users.lastActiveAt })
          .where(eq(users.phoneNumber, phone))
          .catch(() => {});
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
        const phone = (To || "").replace(/^whatsapp:/, "");
        console.log(`[DELIVERY OK] ${phone} | SID: ${MessageSid}`);
      }
    } catch (e) {
      console.error("[DELIVERY STATUS] Parse error:", e);
    }
  });

  // ── PayFast ITN webhook ──
  app.post("/webhook/payfast", async (req: any, res: any) => {
    res.sendStatus(200);
    const itnId = `ITN-${Date.now()}`;
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
      const crypto = require("crypto");
      const passphrase = process.env.PAYFAST_PASSPHRASE;
      if (!passphrase) {
        console.error(`[PAYFAST:${itnId}] REJECTED — PAYFAST_PASSPHRASE env var not set. Cannot validate ITN signature safely. Configure it in Railway.`);
        return;
      }
      const paramString = Object.entries(data)
        .filter(([k]) => k !== "signature")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, "+")}`)
        .join("&");
      const signatureBase = `${paramString}&passphrase=${encodeURIComponent(passphrase)}`;
      const expectedSig = crypto.createHash("md5").update(signatureBase).digest("hex");
      if (!data.signature || data.signature !== expectedSig) {
        console.error(`[PAYFAST:${itnId}] REJECTED — signature ${!data.signature ? "missing" : "mismatch"} for ${safePhone}. Got: ${data.signature?.slice(0, 8)}... Expected: ${expectedSig.slice(0, 8)}...`);
        return;
      }
      console.log(`[PAYFAST:${itnId}] Signature valid`);

      // Validate merchant ID
      const expectedMerchantId = process.env.PAYFAST_MERCHANT_ID;
      if (expectedMerchantId && data.merchant_id !== expectedMerchantId) {
        console.error(`[PAYFAST:${itnId}] REJECTED — merchant ID mismatch (got ${data.merchant_id}, expected ${expectedMerchantId})`);
        return;
      }

      // Amount sanity check
      if (paymentStatus === "COMPLETE" && (amountGross < 1 || amountGross > 500)) {
        console.error(`[PAYFAST:${itnId}] REJECTED — amount R${amountGross} outside acceptable range (1–500)`);
        return;
      }

      const normalisedPhone = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
      const [targetUser] = await db.select().from(users).where(eq(users.phoneNumber, normalisedPhone)).limit(1);
      if (!targetUser) {
        console.error(`[PAYFAST:${itnId}] REJECTED — no user found for phone: ${safePhone}`);
        return;
      }
      console.log(`[PAYFAST:${itnId}] User found — id=${targetUser.id} current_status=${targetUser.subscriptionStatus}`);

      // Idempotency guard — if we have already processed this pf_payment_id, skip entirely.
      // PayFast retries ITNs multiple times; without this, a retry causes duplicate rewards/messages.
      const eventKey = pfPaymentId || `${phone}-${amountGross}-${Date.now()}`;
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

      const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER
        ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
        : "";

      if (paymentStatus === "COMPLETE") {
        const renewsAt = new Date(Date.now() + 30 * 86_400_000);
        const wasInactive = targetUser.subscriptionStatus !== "active";

        // All DB state changes in one transaction — subscription update + referral reward
        let referrerData: { phone: string; name: string | null; newExpiry: Date } | null = null;
        await db.transaction(async (tx) => {
          await tx.update(users).set({
            subscriptionStatus: "active",
            subscriptionRenewsAt: renewsAt,
            paymentReference: pfPaymentId || null,
            cancelledAt: null,
          }).where(eq(users.phoneNumber, normalisedPhone));

          if (wasInactive && targetUser.referredBy) {
            const [referrer] = await tx.select().from(users)
              .where(eq(users.referralCode, targetUser.referredBy))
              .limit(1);
            if (referrer && referrer.subscriptionStatus === "active") {
              const newExpiry = new Date(
                Math.max(Date.now(), new Date(referrer.subscriptionRenewsAt || Date.now()).getTime()) + 30 * 86_400_000
              );
              await tx.update(users)
                .set({ subscriptionRenewsAt: newExpiry })
                .where(eq(users.id, referrer.id));
              referrerData = { phone: referrer.phoneNumber, name: referrer.name, newExpiry };
            }
          }
        });

        console.log(`[PAYFAST] Payment COMPLETE — ${normalisedPhone} | R${amountGross} | renews ${renewsAt.toISOString().slice(0, 10)}`);

        // Send notifications AFTER the transaction commits (Twilio calls can't be rolled back)
        if (referrerData) {
          const { phone: refPhone, name: refName, newExpiry } = referrerData as { phone: string; name: string | null; newExpiry: Date };
          const refTo = refPhone.startsWith("whatsapp:") ? refPhone : `whatsapp:${refPhone}`;
          if (fromNum) {
            await twilioC.messages.create({
              from: fromNum, to: refTo,
              body: `${refName || "Hey"} Your referral just joined KamLife Coach! You have earned one free month — your subscription has been extended to ${newExpiry.toISOString().slice(0, 10)}. Keep sharing your code and keep stacking free months.`,
            }).catch(e => console.error("[REFERRAL] Notify error:", e));
          }
          console.log(`[REFERRAL] Rewarded ${refPhone} — extended to ${(referrerData as any).newExpiry.toISOString().slice(0, 10)}`);
        }

        // Welcome / renewal WhatsApp
        const name = targetUser.name || "there";
        const isRenewal = targetUser.subscriptionStatus === "active";

        if (isRenewal) {
          if (fromNum) {
            await twilioC.messages.create({
              from: fromNum, to: normalisedPhone,
              body: `Payment confirmed, ${name}. Subscription renewed for another month. Coach K is here — let's go.`
            });
          }
        } else {
          if (fromNum) {
            const goalLabel: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomp" };
            const modeLabel: Record<string, string> = { gym: "Gym", gym_dumbbell: "Dumbbell gym", home: "Home", walk_only: "Walk + home" };
            const welcomeMsg = `Payment confirmed, ${name}. Welcome to KamLife Coach.\n\nGoal: ${goalLabel[targetUser.goalType || "fat_loss"] || "fat loss"} · Mode: ${modeLabel[targetUser.trainingMode || "home"] || "Home"} · Phase 1\n\n*What to expect:*\nWeek 1–2: Your body adapts. Energy improves. Scale may not move yet — this is normal.\nWeek 3: The hard week. Mirror hasn't changed. Most people quit here. Don't.\nWeek 4–6: Visible changes start. This is where the work pays off.\nWeek 8–12: Real transformation. Clothes fit differently. Strength up.\n\nCoach K checks in every morning and evening. Log everything — meals, steps, workouts. The more you log, the better I coach you.\n\n_Coach K is AI-powered — not a human coach and not a doctor. Always consult your doctor for medical advice._\n\nYour Day 1 workout is below. Do it today and reply *done* when finished.`;
            await twilioC.messages.create({ from: fromNum, to: normalisedPhone, body: welcomeMsg });

            try {
              const { buildDay1Workout } = await import("../programme");
              const day1 = buildDay1Workout(targetUser);
              if (day1) {
                await twilioC.messages.create({ from: fromNum, to: normalisedPhone, body: day1 });
              }
            } catch (e) {
              console.error("[PAYFAST] Day 1 workout delivery error:", e);
            }
          }
        }
      } else if (paymentStatus === "CANCELLED") {
        await db.update(users).set({
          subscriptionStatus: "inactive",
          cancelledAt: new Date(),
        }).where(eq(users.phoneNumber, normalisedPhone));

        console.log(`[PAYFAST] Subscription CANCELLED — ${normalisedPhone}`);

        if (fromNum) {
          const name = targetUser.name || "there";
          await twilioC.messages.create({
            from: fromNum, to: normalisedPhone,
            body: `${name}, your KamLife Coach subscription has been cancelled. Your progress is saved — you can rejoin anytime. Reply *join* when you are ready.`
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[PAYFAST:${itnId}] Webhook processing error:`, err);
    }
  });

  // ── Admin: force-activate stuck subscription ──
  // Use when PayFast ITN fires but webhook fails (network blip, etc.) and user paid but DB didn't update.
  // Protected by COACH_DASHBOARD_KEY so only the coach can call it.
  app.post("/api/admin/force-activate", async (req: any, res: any) => {
    const authKey = req.headers["x-coach-key"];
    if (authKey !== process.env.COACH_DASHBOARD_KEY) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const { phone, reason } = req.body as { phone?: string; reason?: string };
      if (!phone) return res.status(400).json({ error: "phone required" });
      const normalisedPhone = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
      const [targetUser] = await db.select().from(users).where(eq(users.phoneNumber, normalisedPhone)).limit(1);
      if (!targetUser) return res.status(404).json({ error: "User not found" });
      const renewsAt = new Date(Date.now() + 30 * 86_400_000);
      await db.update(users).set({
        subscriptionStatus: "active",
        subscriptionRenewsAt: renewsAt,
        cancelledAt: null,
      }).where(eq(users.phoneNumber, normalisedPhone));
      console.log(`[PAYFAST] FORCE-ACTIVATE — ${normalisedPhone} | reason: ${reason || "manual"} | renews: ${renewsAt.toISOString().slice(0, 10)}`);
      return res.json({ ok: true, phone: normalisedPhone, renewsAt: renewsAt.toISOString().slice(0, 10) });
    } catch (err) {
      console.error("[PAYFAST] Force-activate error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Admin: test Twilio button (Content API) ──
  app.get("/api/admin/test-buttons", async (req: any, res: any) => {
    const authKey = req.headers["x-coach-key"];
    if (authKey !== process.env.COACH_DASHBOARD_KEY) return res.status(403).json({ error: "Forbidden" });
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
  // Security: PayFast validates the signature on the ITN; this endpoint only builds a URL.
  app.get("/api/payfast/link", async (req: any, res: any) => {
    try {
      const phone = decodeURIComponent(req.query.phone as string || "");
      if (!phone) return res.status(400).json({ error: "phone required" });

      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
      if (!merchantId || !merchantKey) {
        return res.status(503).json({ error: "PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY env vars not set" });
      }

      const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`)).limit(1);
      const name = user?.name || "KamLife Client";
      const isSandbox = process.env.PAYFAST_SANDBOX === "true";
      const baseUrl = isSandbox ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process";
      const returnUrl = process.env.APP_URL ? `${process.env.APP_URL}/payment-success` : "https://kamlifecoach.co.za/payment-success";
      const cancelUrl = process.env.APP_URL ? `${process.env.APP_URL}/payment-cancel` : "https://kamlifecoach.co.za/payment-cancel";
      const notifyUrl = process.env.APP_URL ? `${process.env.APP_URL}/webhook/payfast` : "";
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
}
