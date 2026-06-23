import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

const EFFECTIVE_DATE = "1 June 2026";
const BUSINESS_NAME = "KamLife Lifestyle Coach";
const BUSINESS_EMAIL = "support@kamlifecoach.co.za";
const PRICE = "R199";
const TRIAL_DAYS = 7;

export default function TermsOfService() {
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
          <h1 className="text-4xl font-bold mb-3">Terms of Service</h1>
          <p className="text-muted-foreground">Effective date: {EFFECTIVE_DATE} · Governed by South African law</p>
        </div>

        <div className="prose prose-neutral max-w-none space-y-10 text-sm leading-relaxed">

          <section>
            <h2 className="text-xl font-bold mb-3">1. Who we are and what this is</h2>
            <p>{BUSINESS_NAME} ("<strong>KamLife</strong>", "<strong>we</strong>", "<strong>us</strong>") operates an AI-powered fitness and nutrition coaching service delivered via WhatsApp ("<strong>Coach K</strong>").</p>
            <p className="mt-3 text-muted-foreground">By starting a trial, subscribing, or sending a message to Coach K, you agree to these Terms. If you do not agree, please do not use the service.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">2. Not medical advice</h2>
            <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-sm">
              <p className="font-semibold text-destructive mb-2">Important — please read this carefully.</p>
              <p className="text-muted-foreground">KamLife provides general fitness and nutrition guidance. It is <strong>not medical advice</strong> and is not a substitute for a doctor, dietitian, physiotherapist, or any other registered healthcare professional.</p>
              <p className="mt-2 text-muted-foreground">If you have a medical condition, injury, chronic illness, or are pregnant, consult a qualified healthcare provider before following any exercise or nutrition guidance from Coach K. We are not liable for any health outcome resulting from your use of the service.</p>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">3. Eligibility</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>You must be at least <strong>18 years old</strong> to subscribe.</li>
              <li>You must have a valid South African phone number and WhatsApp account.</li>
              <li>You may only hold one active account. Creating multiple accounts to extend trial periods is prohibited.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">4. Free trial</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>New subscribers receive a <strong>{TRIAL_DAYS}-day free trial</strong>. No payment is taken during the trial.</li>
              <li>If you cancel before the trial ends (reply "<em>cancel</em>" to Coach K), you will not be charged.</li>
              <li>If you do not cancel before the trial ends, your subscription begins automatically and your first payment of <strong>{PRICE}/month</strong> is processed.</li>
              <li>One free trial per person. We reserve the right to refuse a trial if we reasonably believe it is being claimed fraudulently.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">5. Subscription and payment</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>The subscription fee is <strong>{PRICE} per month</strong>, billed monthly.</li>
              <li>Payment is processed via <strong>PayFast</strong>. We do not store your card or banking details.</li>
              <li>Your subscription renews automatically each month on the same date your trial ended, unless you cancel.</li>
              <li>We may change the subscription price with <strong>30 days' notice</strong> via WhatsApp. Continued use after the notice period constitutes acceptance of the new price.</li>
              <li>If a payment fails, we will retry and notify you. If payment cannot be collected, your access will be suspended until payment is resolved.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">6. Cancellation</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>You may cancel at any time by replying "<strong>cancel</strong>" to Coach K on WhatsApp, or by emailing us at <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a>.</li>
              <li>Cancellation takes effect at the end of your current billing period. You retain full access until then.</li>
              <li>For our refund policy, see the <Link href="/cancellation" className="text-primary underline">Refund &amp; Cancellation Policy</Link>.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">7. Acceptable use</h2>
            <p className="text-muted-foreground mb-3">You agree not to:</p>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li>Share your account or WhatsApp access with other people</li>
              <li>Use the service to collect data for commercial purposes or to train AI models</li>
              <li>Send abusive, harassing, or offensive messages to Coach K</li>
              <li>Attempt to extract, reverse-engineer, or replicate the coaching system, meal plans, or content</li>
              <li>Use the service in any way that violates South African law</li>
            </ul>
            <p className="mt-3 text-muted-foreground">We reserve the right to suspend or terminate your account without refund if you violate these terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">8. Intellectual property</h2>
            <p className="text-muted-foreground">All coaching content, meal plans, workout programmes, and responses generated by Coach K are the intellectual property of {BUSINESS_NAME}. You may use them for your personal fitness journey only. You may not reproduce, distribute, or sell them.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">9. Service availability</h2>
            <p className="text-muted-foreground">We aim to keep Coach K available 24/7 but cannot guarantee uninterrupted service. Scheduled maintenance, WhatsApp outages, or third-party service failures may cause temporary unavailability. We are not liable for losses arising from service downtime.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">10. Limitation of liability</h2>
            <p className="text-muted-foreground">To the maximum extent permitted by South African law, KamLife's total liability to you for any claim arising from the service is limited to the amount you paid in the 3 months preceding the claim. We are not liable for indirect, consequential, or incidental loss of any kind.</p>
            <p className="mt-3 text-muted-foreground">Nothing in these Terms excludes liability for fraud, death, or personal injury caused by our negligence, or any other liability that cannot be excluded under the Consumer Protection Act 68 of 2008.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">11. Privacy</h2>
            <p className="text-muted-foreground">Your personal information is processed in accordance with our <Link href="/privacy" className="text-primary underline">Privacy Policy (POPIA)</Link>. By using the service you consent to that processing.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">12. Governing law and disputes</h2>
            <p className="text-muted-foreground">These Terms are governed by the laws of the Republic of South Africa. Any dispute will first be referred to mediation. If unresolved, it will be submitted to the jurisdiction of the South Gauteng High Court (Johannesburg) or the Magistrate's Court, depending on the value of the claim.</p>
            <p className="mt-3 text-muted-foreground">Unhappy with us? Email <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a> first — most issues are resolved within 24 hours.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-3">13. Changes to these Terms</h2>
            <p className="text-muted-foreground">We may update these Terms from time to time. We will notify you via WhatsApp at least 14 days before material changes take effect. Continued use of the service after the effective date constitutes acceptance.</p>
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
