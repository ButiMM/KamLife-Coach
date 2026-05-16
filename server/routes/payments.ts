import type { Express } from "express";
import { db } from "../db";
import { users, chatHistory } from "../../shared/schema";
import { eq } from "drizzle-orm";
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

      // Validate signature
      const crypto = require("crypto");
      const passphrase = process.env.PAYFAST_PASSPHRASE || "";
      const paramString = Object.entries(data)
        .filter(([k]) => k !== "signature")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, "+")}`)
        .join("&");
      const signatureBase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
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

      const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER
        ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
        : "";

      if (paymentStatus === "COMPLETE") {
        const renewsAt = new Date(Date.now() + 30 * 86_400_000);
        await db.update(users).set({
          subscriptionStatus: "active",
          subscriptionRenewsAt: renewsAt,
          paymentReference: pfPaymentId || null,
          cancelledAt: null,
        }).where(eq(users.phoneNumber, normalisedPhone));

        console.log(`[PAYFAST] Payment COMPLETE — ${normalisedPhone} | R${amountGross} | renews ${renewsAt.toISOString().slice(0, 10)}`);

        // Referral reward
        const wasInactive = targetUser.subscriptionStatus !== "active";
        if (wasInactive && targetUser.referredBy) {
          try {
            const [referrer] = await db.select().from(users)
              .where(eq(users.referralCode, targetUser.referredBy))
              .limit(1);
            if (referrer && referrer.subscriptionStatus === "active") {
              const referrerNewExpiry = new Date(
                Math.max(Date.now(), new Date(referrer.subscriptionRenewsAt || Date.now()).getTime()) + 30 * 86_400_000
              );
              await db.update(users)
                .set({ subscriptionRenewsAt: referrerNewExpiry })
                .where(eq(users.id, referrer.id));
              if (fromNum) {
                await twilioC.messages.create({
                  from: fromNum,
                  to: referrer.phoneNumber.startsWith("whatsapp:") ? referrer.phoneNumber : `whatsapp:${referrer.phoneNumber}`,
                  body: `${referrer.name || "Hey"} Your referral just joined KamLife Coach! You have earned one free month — your subscription has been extended to ${referrerNewExpiry.toISOString().slice(0, 10)}. Keep sharing your code and keep stacking free months.`,
                });
              }
              console.log(`[REFERRAL] Rewarded ${referrer.phoneNumber} — extended to ${referrerNewExpiry.toISOString().slice(0, 10)}`);
            }
          } catch (refErr) {
            console.error("[REFERRAL] Reward error:", refErr);
          }
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
    const authKey = req.headers["x-coach-key"] || req.query.key;
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

      res.json({ url: `${baseUrl}?${params.toString()}`, phone, name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
