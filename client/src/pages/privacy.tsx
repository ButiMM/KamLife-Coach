import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

const EFFECTIVE_DATE = "2 September 2026";
const BUSINESS_NAME = "KamLife Lifestyle Coach";
const BUSINESS_EMAIL = "privacy@kamlifecoach.co.za";
// NO PLACEHOLDERS ON A LIVE PAGE (2026-09-02). Two bracketed template stubs — a company
// registration number and an information officer name — rendered verbatim to every visitor,
// including a Meta/Twilio reviewer reading the POPIA page. Unverified details are REMOVED rather
// than invented: a policy that states a registration number we cannot evidence is worse than one
// that does not claim one. Add the lines back when the real values exist.

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to KamLife
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-10">
          <p className="text-sm text-muted-foreground uppercase tracking-widest font-semibold mb-2">Legal</p>
          <h1 className="text-4xl font-bold mb-3">Privacy Policy</h1>
          <p className="text-muted-foreground">Effective date: {EFFECTIVE_DATE} · Governed by the Protection of Personal Information Act 4 of 2013 (POPIA)</p>
        </div>

        <div className="prose prose-neutral max-w-none space-y-10 text-sm leading-relaxed">

          {/* Section 1 */}
          <section>
            <h2 className="text-xl font-bold mb-3">1. Who we are</h2>
            <p>{BUSINESS_NAME} ("<strong>KamLife</strong>", "<strong>we</strong>", "<strong>us</strong>") is a South African AI-powered fitness coaching service delivered via WhatsApp.</p>
            <ul className="mt-3 space-y-1 list-disc pl-5 text-muted-foreground">
              <li>Business name: {BUSINESS_NAME}</li>
              <li>Contact: <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a></li>
            </ul>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-xl font-bold mb-3">2. What personal information we collect</h2>
            <p>When you use KamLife, we collect the following categories of personal information:</p>

            <h3 className="font-semibold mt-4 mb-2">General personal information</h3>
            <ul className="space-y-1 list-disc pl-5 text-muted-foreground">
              <li>Your first name (used for personalised coaching)</li>
              <li>Your WhatsApp phone number (used to deliver coaching messages)</li>
              <li>Your training preference (gym, home, or dumbbells)</li>
              <li>Your fitness goal (fat loss, muscle gain, body recomp, health)</li>
              <li>Your weekly grocery budget</li>
              <li>Your work schedule / lifestyle situation</li>
              <li>Food and meal logs you send to the service</li>
              <li>Step count data you log or sync</li>
              <li>Workout completion records</li>
              <li>Payment reference numbers (via PayFast)</li>
            </ul>

            <h3 className="font-semibold mt-4 mb-2">Special personal information (Section 26, POPIA)</h3>
            <p className="text-muted-foreground">The following is <strong>health-related information</strong> and is classified as special personal information under POPIA. We only collect this if you voluntarily provide it for the purpose of personalising your coaching:</p>
            <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">
              <li>Body weight (current and historical)</li>
              <li>Medical conditions you disclose (e.g. diabetes, hypertension, PCOS, injury history)</li>
              <li>Medication you mention that may affect nutrition or exercise</li>
              <li>Pregnancy or postpartum status</li>
            </ul>
            <p className="mt-2 text-muted-foreground">You are not required to disclose health information. If you do, it is used solely to make your coaching safer and more relevant.</p>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-xl font-bold mb-3">3. Why we collect it (purpose)</h2>
            <p>We collect and process your personal information only for the following purposes:</p>
            <ul className="mt-3 space-y-2 list-disc pl-5 text-muted-foreground">
              <li>Delivering a personalised fitness and nutrition coaching programme via WhatsApp</li>
              <li>Sending daily check-ins, reminders, and progress reports</li>
              <li>Adjusting your programme targets based on your logged results</li>
              <li>Processing your subscription payment via PayFast</li>
              <li>Complying with our legal obligations</li>
            </ul>
            <p className="mt-3 font-medium">We do not sell, rent, or share your personal information with any third party for marketing or commercial purposes.</p>
          </section>

          {/* Section 4 */}
          <section>
            <h2 className="text-xl font-bold mb-3">4. Third parties who process your data</h2>
            <p>In order to deliver this service, your data is processed by the following third-party service providers. Each operates under their own privacy policies and data processing terms:</p>

            <div className="mt-4 space-y-4">
              {[
                { name: "Twilio Inc.", role: "Delivers WhatsApp messages between you and Coach K. Your phone number and message content are transmitted through Twilio's infrastructure.", link: "https://www.twilio.com/legal/privacy" },
                { name: "Anthropic PBC (Claude AI)", role: "Processes your messages to generate coaching responses. Message content is sent to Anthropic's API for AI processing.", link: "https://www.anthropic.com/privacy" },
                { name: "OpenAI LLC (GPT)", role: "Processes your messages for AI coaching responses in certain scenarios.", link: "https://openai.com/policies/privacy-policy" },
                { name: "ElevenLabs Inc.", role: "Converts coaching text to voice audio for your weekly audio recap.", link: "https://elevenlabs.io/privacy" },
                { name: "Railway Corp.", role: "Hosts the KamLife application and database on their cloud infrastructure. Your data is stored on Railway's servers.", link: "https://railway.app/legal/privacy" },
                { name: "PayFast (DPO Group)", role: "Processes your subscription payments. We do not store your card or banking details — PayFast handles all payment data.", link: "https://www.payfast.co.za/legal/privacy-policy" },
              ].map((tp) => (
                <div key={tp.name} className="p-4 rounded-xl bg-muted/40 border border-border">
                  <div className="font-semibold text-sm">{tp.name}</div>
                  <p className="text-muted-foreground text-sm mt-1">{tp.role}</p>
                  <a href={tp.link} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline mt-1 inline-block">{tp.link}</a>
                </div>
              ))}
            </div>
          </section>

          {/* Section 5 */}
          <section>
            <h2 className="text-xl font-bold mb-3">5. How long we keep your data</h2>
            <ul className="space-y-2 list-disc pl-5 text-muted-foreground">
              <li><strong>Active subscription:</strong> Data is retained for the duration of your active subscription.</li>
              <li><strong>After cancellation:</strong> Your profile, workout logs, and food logs are retained for 90 days after cancellation to allow you to resume coaching. After 90 days, all personal data is permanently deleted.</li>
              <li><strong>Payment records:</strong> Payment reference numbers are retained for 5 years as required by South African tax law.</li>
              <li><strong>On request:</strong> If you request deletion at any time (reply <em>delete my data</em> to Coach K), all your personal information is immediately and permanently deleted — including during an active subscription.</li>
            </ul>
          </section>

          {/* Section 6 */}
          <section>
            <h2 className="text-xl font-bold mb-3">6. Your rights under POPIA</h2>
            <p>As a data subject under POPIA, you have the following rights:</p>
            <div className="mt-4 space-y-3">
              {[
                { right: "Right to be notified", detail: "You were notified of our data collection at the start of your coaching via our WhatsApp consent message." },
                { right: "Right to access", detail: "You may request a copy of all personal information we hold about you. Contact us at " + BUSINESS_EMAIL + "." },
                { right: "Right to correction", detail: "You may request correction of inaccurate personal information at any time by messaging Coach K or emailing us." },
                { right: "Right to deletion", detail: "Reply 'delete my data' to Coach K at any time. This immediately and permanently deletes all your data from our systems." },
                { right: "Right to object", detail: "You may object to the processing of your personal information by cancelling your subscription and requesting deletion." },
                { right: "Right to withdraw consent", detail: "You may withdraw your consent at any time. This will end your coaching service and your data will be deleted within 90 days." },
              ].map((r) => (
                <div key={r.right} className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  <div>
                    <span className="font-semibold">{r.right}:</span>{" "}
                    <span className="text-muted-foreground">{r.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Section 7 */}
          <section>
            <h2 className="text-xl font-bold mb-3">7. Security</h2>
            <p className="text-muted-foreground">We take reasonable technical and organisational measures to protect your personal information against loss, damage, and unauthorised access. Your data is stored on encrypted servers and is not accessible to the public. Only automated systems and authorised personnel process your coaching data.</p>
            <p className="mt-3 text-muted-foreground">In the event of a data breach that is likely to prejudice you, we will notify you and the Information Regulator as required by POPIA.</p>
          </section>

          {/* Section 8 */}
          <section>
            <h2 className="text-xl font-bold mb-3">8. How to complain</h2>
            <p className="text-muted-foreground">If you have a complaint about how we handle your personal information, contact us first at <a href={`mailto:${BUSINESS_EMAIL}`} className="text-primary underline">{BUSINESS_EMAIL}</a>. We will respond within 30 days.</p>
            <p className="mt-3 text-muted-foreground">If you are not satisfied with our response, you may lodge a complaint with the South African Information Regulator:</p>
            <div className="mt-3 p-4 rounded-xl bg-muted/40 border border-border text-muted-foreground text-sm space-y-1">
              <div className="font-semibold text-foreground">Information Regulator (South Africa)</div>
              <div>Website: <a href="https://inforegulator.org.za" target="_blank" rel="noopener noreferrer" className="text-primary underline">inforegulator.org.za</a></div>
              <div>Email: <a href="mailto:complaints.IR@justice.gov.za" className="text-primary underline">complaints.IR@justice.gov.za</a></div>
              <div>Address: JD House, 27 Stiemens Street, Braamfontein, Johannesburg, 2001</div>
            </div>
          </section>

          {/* Section 9 */}
          <section>
            <h2 className="text-xl font-bold mb-3">9. Changes to this policy</h2>
            <p className="text-muted-foreground">We may update this policy from time to time. The effective date above shows when it was last revised. We will notify active clients of material changes via WhatsApp.</p>
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
