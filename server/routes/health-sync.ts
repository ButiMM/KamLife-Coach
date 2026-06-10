import type { Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { users, stepLogs, userIntegrations } from "../../shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { sendWhatsApp } from "../scheduler/shared";
import { getStepResponse } from "../handlers/steps";
import { getStepStreak } from "../handlers/steps";
import { logChat } from "../handlers/chat-log";
import { sastDayStart } from "../utils";

// HMAC token tied to phone number + server secret — no DB storage needed.
// Anyone who knows only a phone number cannot fake a step sync.
function makeStepToken(phone: string): string {
  const secret = process.env.WEBHOOK_SECRET || process.env.TWILIO_AUTH_TOKEN;
  if (!secret) {
    console.error("[STEPS] WEBHOOK_SECRET is not set — step-sync tokens cannot be generated safely. Set WEBHOOK_SECRET in Railway.");
    throw new Error("WEBHOOK_SECRET not configured");
  }
  return crypto.createHmac("sha256", secret).update(phone).digest("hex").slice(0, 32);
}

export function buildStepsWebhookUrl(appUrl: string, phone: string): string {
  const token = makeStepToken(phone);
  return `${appUrl}/webhook/steps?phone=${encodeURIComponent(phone)}&token=${token}`;
}

const CONNECT_STEPS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Connect Steps · KamLife Coach</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
    .header{background:linear-gradient(135deg,#1d4ed8,#7c3aed);padding:28px 20px 22px;text-align:center}
    .header h1{font-size:22px;font-weight:700}
    .header p{font-size:14px;opacity:.85;margin-top:5px}
    .tabs{display:flex;background:#1e293b;border-bottom:1px solid #334155}
    .tab{flex:1;padding:14px;text-align:center;font-size:15px;font-weight:600;color:#94a3b8;cursor:pointer;border-bottom:3px solid transparent;-webkit-tap-highlight-color:transparent}
    .tab.active{color:#60a5fa;border-bottom-color:#60a5fa}
    .content{padding:20px;max-width:480px;margin:0 auto}
    .url-box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;margin-bottom:24px}
    .url-box label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:8px}
    .url-text{font-size:12px;color:#93c5fd;word-break:break-all;font-family:monospace;line-height:1.6}
    .copy-btn{display:block;width:100%;margin-top:12px;background:#1d4ed8;color:#fff;border:none;border-radius:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
    .copy-btn.copied{background:#16a34a}
    .steps{list-style:none}
    .step{display:flex;gap:14px;margin-bottom:22px}
    .step-num{flex-shrink:0;width:32px;height:32px;border-radius:50%;background:#1d4ed8;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}
    .step-body{padding-top:4px}
    .step-body strong{display:block;font-size:15px;margin-bottom:4px}
    .step-body p{font-size:14px;color:#94a3b8;line-height:1.6}
    .step-body a{color:#60a5fa;text-decoration:none}
    .badge{display:inline-block;background:#0f172a;border:1px solid #334155;border-radius:5px;padding:2px 7px;font-size:12px;font-family:monospace;color:#93c5fd;white-space:nowrap}
    .tip{background:#1e293b;border-left:3px solid #22c55e;border-radius:0 8px 8px 0;padding:14px 16px;margin-top:24px;font-size:14px;color:#86efac;line-height:1.5}
    .panel{display:none}
    .panel.active{display:block}
  </style>
</head>
<body>
  <div class="header">
    <h1>📱 Connect Your Steps</h1>
    <p>Set it up once. Your steps arrive automatically every night.</p>
  </div>
  <div class="tabs">
    <div class="tab active" onclick="show('android',this)">🤖 Android</div>
    <div class="tab" onclick="show('iphone',this)">🍎 iPhone</div>
  </div>
  <div class="content">
    <div class="url-box">
      <label>Your Personal Link</label>
      <div class="url-text" id="webhookUrl">{{WEBHOOK_URL}}</div>
      <button class="copy-btn" id="copyBtn" onclick="copy()">Copy My Link</button>
    </div>
    <div id="android" class="panel active">
      <ol class="steps">
        <li class="step">
          <div class="step-num">1</div>
          <div class="step-body">
            <strong>Install the free app</strong>
            <p>Open Play Store → search <strong>Health Connect Webhooks</strong> → Install. It's free.</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">2</div>
          <div class="step-body">
            <strong>Copy your link above</strong>
            <p>Tap <strong>Copy My Link</strong> at the top of this page.</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">3</div>
          <div class="step-body">
            <strong>Add your webhook</strong>
            <p>Open the app → tap <span class="badge">Add Webhook</span> → paste your link → Data type: <span class="badge">Steps</span> → Frequency: <span class="badge">Daily at 9pm</span> → Save</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">4</div>
          <div class="step-body">
            <strong>Tell Coach K you're done</strong>
            <p>Go back to WhatsApp and reply <span class="badge">steps connected</span></p>
          </div>
        </li>
      </ol>
      <div class="tip">✅ Tonight at 9pm your steps will sync automatically — Coach K will confirm in WhatsApp.</div>
    </div>
    <div id="iphone" class="panel">
      <ol class="steps">
        <li class="step">
          <div class="step-num">1</div>
          <div class="step-body">
            <strong>Copy your link above first</strong>
            <p>Tap <strong>Copy My Link</strong> at the top. Keep this page open — you'll come back to it.</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">2</div>
          <div class="step-body">
            <strong>Open Shortcuts app</strong>
            <p>Search your phone for <strong>Shortcuts</strong>. Tap the <strong>Automation</strong> tab at the bottom → <strong>+</strong> → <strong>New Automation</strong> → <strong>Time of Day</strong> → set <span class="badge">9:00 PM</span> → tick <span class="badge">Daily</span> → Next</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">3</div>
          <div class="step-body">
            <strong>Add the Steps action</strong>
            <p>Tap <strong>Add Action</strong> → search <span class="badge">health</span> → tap <strong>Find Health Samples</strong> → change Type to <span class="badge">Steps</span> → set limit to <span class="badge">1</span></p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">4</div>
          <div class="step-body">
            <strong>Add your URL</strong>
            <p>Tap <strong>+</strong> → search <span class="badge">url</span> → tap <strong>URL</strong> → paste your link</p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">5</div>
          <div class="step-body">
            <strong>Add the Send action</strong>
            <p>Tap <strong>+</strong> → search <span class="badge">get contents</span> → tap <strong>Get Contents of URL</strong> → Method: <span class="badge">POST</span> → tap <strong>Add new field</strong> → <span class="badge">JSON</span> → Key: <span class="badge">steps</span> → tap the Value field → tap the <strong>blue token icon</strong> → select <strong>Health Samples → Steps Count</strong></p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">6</div>
          <div class="step-body">
            <strong>Save it</strong>
            <p>Tap <strong>Next</strong> → turn <strong>OFF</strong> "Ask Before Running" → tap <strong>Done</strong></p>
          </div>
        </li>
        <li class="step">
          <div class="step-num">7</div>
          <div class="step-body">
            <strong>Tell Coach K you're done</strong>
            <p>Go back to WhatsApp and reply <span class="badge">steps connected</span></p>
          </div>
        </li>
      </ol>
      <div class="tip">✅ Tonight at 9pm your steps sync automatically. Coach K will confirm in WhatsApp.</div>
    </div>
  </div>
  <script>
    function show(id,el){
      ['android','iphone'].forEach(t=>document.getElementById(t).classList.toggle('active',t===id));
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      el.classList.add('active');
    }
    function copy(){
      const url=document.getElementById('webhookUrl').textContent;
      navigator.clipboard.writeText(url).then(()=>{
        const b=document.getElementById('copyBtn');
        b.textContent='✓ Copied!';b.classList.add('copied');
        setTimeout(()=>{b.textContent='Copy My Link';b.classList.remove('copied');},2500);
      }).catch(()=>{
        const b=document.getElementById('copyBtn');
        b.textContent='Long-press the link above to copy';
        setTimeout(()=>{b.textContent='Copy My Link';},3000);
      });
    }
  </script>
</body>
</html>`;

export function registerHealthSyncRoutes(app: Express): void {
  // GET /connect-steps?phone=+27XXXXXXX — mobile setup page
  app.get("/connect-steps", (req, res) => {
    const phone = (req.query.phone as string | undefined) || "";
    const appUrl = process.env.APP_URL || "https://kamlife.co.za";
    const webhookUrl = buildStepsWebhookUrl(appUrl, phone);
    const safeUrl = webhookUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const html = CONNECT_STEPS_HTML.replace("{{WEBHOOK_URL}}", safeUrl);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.send(html);
  });

  // POST /webhook/steps?phone=+27XXXXXXX&token=XXXXXXXXXXXXXXXX
  // Receives step data from Android Health Connect Webhooks app or iOS Shortcut.
  // Body: { steps: number } or { value: number } or { data: { steps: number } }
  app.post("/webhook/steps", async (req, res) => {
    try {
      const phone = req.query.phone as string | undefined;
      if (!phone) {
        res.status(400).json({ error: "phone query param required" });
        return;
      }

      // Token verification — reject requests without a valid HMAC token
      const providedToken = (req.query.token as string | undefined) || "";
      const expectedToken = makeStepToken(phone);
      const tokensMatch = providedToken.length === expectedToken.length &&
        crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(expectedToken));
      if (!tokensMatch) {
        console.warn(`[SECURITY] /webhook/steps rejected — invalid token for ${phone.slice(0, 8)}***`);
        res.status(403).json({ error: "forbidden" });
        return;
      }

      // Parse steps from multiple possible body formats
      const body = req.body || {};
      const steps: number = parseInt(
        body.steps ?? body.value ?? body.count ?? body.data?.steps ?? body.data?.value ?? "0",
        10,
      );

      if (!Number.isFinite(steps) || steps < 0 || steps > 100_000) {
        res.status(400).json({ error: "invalid steps value" });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (!user) {
        res.status(404).json({ error: "user not found" });
        return;
      }

      // Dedup: only one step log per user per SAST day
      const todayStart = sastDayStart();
      const existing = await db.select({ id: stepLogs.id }).from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1);

      if (existing.length > 0) {
        res.json({ ok: true, message: "already logged today" });
        return;
      }

      await db.insert(stepLogs).values({ userId: user.id, steps });

      // Mark the integration as active so the morning job knows steps are synced
      await db.insert(userIntegrations).values({
        userId: user.id,
        provider: "webhook",
        isActive: true,
        lastSyncAt: new Date(),
      }).onConflictDoUpdate({
        target: [userIntegrations.userId, userIntegrations.provider],
        set: { lastSyncAt: new Date(), isActive: true },
      }).catch(() => { /* ignore if table not yet migrated */ });

      // Send an instant response so the user knows it worked
      const target = user.stepsTarget || 8500;
      const weight = parseFloat(String(user.currentWeight || "0")) || 75;
      const streak = await getStepStreak(user.id);
      const response = getStepResponse(steps, target, weight, streak, undefined, user);
      const autoMsg = `_[Auto-synced from your health app]_\n\n${response}`;

      await sendWhatsApp(user.phoneNumber, autoMsg);
      await logChat(user.id, `[auto-sync: ${steps} steps]`, autoMsg, "STEPS_AUTO_SYNC");

      res.json({ ok: true, steps });
    } catch (err) {
      console.error("[HEALTH SYNC] Webhook error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });
}
