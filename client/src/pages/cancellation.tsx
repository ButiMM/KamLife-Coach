import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

const EFFECTIVE_DATE = "2 September 2026";
const BUSINESS_NAME = "KamLife Lifestyle Coach";
const BUSINESS_EMAIL = "support@kamlifecoach.co.za";
const PRICE = "R149";

export default function CancellationPolicy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to KamLife
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-10">
          <p className="text-sm text-muted-foreground uppercase tracking-widest font-semibold mb-2">Legal</p>
          <h1 className="text-4xl font-bold mb-3">Refund &amp; Cancellation Policy</h1>
          <p className="text-muted-foreground">Effective date: {EFFECTIVE_DATE}</p>
        </div>

        <div className="prose prose-neutral max-w-none space-y-10 text-sm leading-relaxed">

          {/* Quick summary box */}
          <div className="p-5 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
            <p className="font-semibold text-base">The short version</p>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>✅ <strong>Cancel anytime</strong> — reply "<em>cancel</em>" to Coach K on WhatsApp</li>
              <li>✅ <strong>14-day money-back guarantee</strong> — ask inside your first 14 days and you get your {PRICE} back</li>
              <li>✅ <strong>Access until billing period ends</strong> after you cancel</li>
              <li>✅ <strong>No interrogation</strong> — one optional question about why, and that is all</li>
            </ul>
          </div>

          <section>
            <h2 className="text-xl font-bold mb-3">1. How to cancel</h2>
            <p className="text-muted-foreground">There are two ways to cancel:</p>
            <div className="mt-4 space-y-3">
              <div className="p-4 rounded-xl bg-muted/40 border border-border">
                <div className="font-semibold text-sm">Option 1 — WhatsApp (fastest)</div>
                <p className="text-muted-foreground text-sm mt-1">Reply "<strong>cancel</strong>" or "<strong>cancel my subscription</strong>" to Coach K. We'll confirm immediately and process the cancellation on the spot.</p>
              </div>
              <div className="p-4 rounded-xl bg-muted/40 border border-border">
                <div className="font-semibold text-sm">Option 2 — Email</div>
                <p className="text-muted-foreground text-sm mt-1">Email <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a> with your WhatsApp number. We'll process your cancellation within 24 hours and confirm by reply.</p>
              </div>
            </div>
            <p className="mt-4 text-muted-foreground">Cancellation takes effect at the end of your current billing period. You keep full coaching access until then — Coach K stays active, your programme continues, nothing changes until the billing date.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">2. The 14-day money-back guarantee</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>KamLife is <strong>{PRICE} upfront per month</strong>. There is no trial period — you pay first, and the guarantee is what protects you.</li>
              <li>If you are not happy, tell us <strong>within 14 days</strong> of your first payment and we refund it in full.</li>
              <li>You do not need a reason. We may ask one optional question about what did not work, and you are free to ignore it.</li>
              <li>We aim to process approved refunds <strong>within 2 business days</strong> of your request.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">3. Refund policy</h2>
            <p className="text-muted-foreground">Your first 14 days are covered by the money-back guarantee above — inside that window you get your money back on request, no reason required. After 14 days, a month you have already started is not refunded as a general rule, because the coaching is delivered continuously from the day it starts. The exceptions below always apply.</p>

            <h3 className="font-semibold mt-5 mb-2">We will always refund you when</h3>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li><strong>You ask within 14 days:</strong> the money-back guarantee, in full, no reason needed.</li>
              <li><strong>Duplicate charge:</strong> If you were charged twice for the same period, we will refund the duplicate immediately.</li>
              <li><strong>Service failure:</strong> If Coach K was completely unavailable (not just slow or degraded, but fully inaccessible) for more than 72 consecutive hours in a billing month, we will provide a pro-rated credit for the downtime.</li>
              <li><strong>Charged after cancellation:</strong> If you were charged after a valid cancellation request, we will refund the incorrect charge in full within 5 business days.</li>
              <li><strong>Goodwill discretion:</strong> We are a small South African business and we care about being fair. If you have a compelling reason outside the guarantee window, email us and we will consider your request honestly.</li>
            </ul>

            <h3 className="font-semibold mt-5 mb-2">How refunds are processed</h3>
            <p className="text-muted-foreground">Approved refunds are returned to your original payment method via PayFast. We aim to initiate approved refunds within 2 business days; your bank then typically takes a further 3–7 business days. We will email you a confirmation once the refund is initiated.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">4. What happens to your data after cancellation</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>After your subscription ends, your profile, workout logs, food logs, and progress history are retained for <strong>90 days</strong>.</li>
              <li>During those 90 days you can reactivate your subscription and pick up exactly where you left off — same programme, same history.</li>
              <li>After 90 days, all personal data is permanently deleted from our systems.</li>
              <li>You can request immediate deletion at any time by replying "<em>delete my data</em>" to Coach K, even during an active subscription. See our <Link href="/privacy" className="text-primary underline">Privacy Policy</Link> for full details.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">5. Reactivating after cancellation</h2>
            <p className="text-muted-foreground">Changed your mind? Message Coach K on WhatsApp at any time within 90 days of cancellation and reply "<strong>restart</strong>" — your programme will be restored and we'll send you a new payment link. After 90 days, you'll need to start a new onboarding.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">6. Consumer Protection Act</h2>
            <p className="text-muted-foreground">These terms are subject to the <strong>Consumer Protection Act 68 of 2008</strong>. Nothing in this policy limits any right you have under that Act. If there is any conflict between this policy and the CPA, the CPA applies.</p>
            <p className="mt-3 text-muted-foreground">If you have a complaint that we cannot resolve, you may contact the <strong>National Consumer Commission</strong>:</p>
            <div className="mt-3 p-4 rounded-xl bg-muted/40 border border-border text-muted-foreground text-sm space-y-1">
              <div className="font-semibold text-foreground">National Consumer Commission</div>
              <div>Website: <a href="https://www.thencc.org.za" target="_blank" rel="noopener noreferrer" className="text-primary underline">www.thencc.org.za</a></div>
              <div>Hotline: 0860 266 786</div>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">7. Questions</h2>
            <p className="text-muted-foreground">If anything here is unclear, email us at <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a> or reply to Coach K on WhatsApp. We're a real team and we respond within 24 hours.</p>
          </section>

          <div className="pt-6 border-t border-border text-xs text-muted-foreground">
            <p>{BUSINESS_NAME} · Last updated: {EFFECTIVE_DATE}</p>
            <p className="mt-1">Questions: <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a></p>
          </div>

        </div>
      </main>
    </div>
  );
}
