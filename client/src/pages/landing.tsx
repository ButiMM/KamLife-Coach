import { Button } from "@/components/ui/button";
import { MessageCircle, CheckCircle, TrendingUp, Shield, Zap, Users, Star, ChevronRight, Phone, Crown } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || "27600000000";
const WA_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C%20I%27d%20like%20to%20start%20coaching`;

export default function LandingPage() {
  // Pull live public stats
  const { data: stats } = useQuery({
    queryKey: ["/api/public/stats"],
    queryFn: async () => {
      const res = await fetch("/api/public/stats");
      if (!res.ok) return null;
      return res.json() as Promise<{ activeClients: number; workoutsLogged: number }>;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <div className="min-h-screen bg-background text-foreground overflow-hidden">
      {/* Nav */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-18 flex items-center justify-between py-4 sticky top-0 bg-background/80 backdrop-blur-md z-50 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-white font-bold font-display text-sm">K</span>
          </div>
          <span className="font-bold font-display text-xl tracking-tight">KamLife Coach</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login">
            <Button variant="ghost" size="sm" className="font-medium hidden sm:flex">Coach Login</Button>
          </Link>
          <Button size="sm" className="rounded-full font-semibold" asChild>
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="w-4 h-4 mr-1.5" />
              Start Free Trial
            </a>
          </Button>
        </div>
      </nav>

      {/* Hero */}
      <main className="relative pt-20 pb-16 flex flex-col items-center text-center px-4">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-gradient-to-b from-primary/8 to-transparent -z-10 blur-3xl rounded-full pointer-events-none" />

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-4xl mx-auto space-y-6"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-sm font-semibold border border-emerald-200 dark:border-emerald-800">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            Now Accepting Clients — South Africa
          </div>

          <h1 className="text-5xl sm:text-7xl font-display font-bold leading-[1.08] tracking-tight">
            Your personal SA fitness coach,{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-500">
              right in WhatsApp
            </span>
          </h1>

          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Real programmes. SA food advice. Accountability that keeps you consistent.
            No new app to download — runs entirely in WhatsApp. No gym required to start.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-6">
            <Button
              size="lg"
              className="h-14 px-8 rounded-2xl text-base font-bold shadow-xl shadow-primary/20 hover:shadow-2xl hover:scale-[1.02] transition-all"
              asChild
            >
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 mr-2" />
                Start Free Trial — from R149/month
              </a>
            </Button>
            <Button size="lg" variant="outline" className="h-14 px-8 rounded-2xl text-base border-2" asChild>
              <a href="#how-it-works">
                How it works
                <ChevronRight className="w-4 h-4 ml-1" />
              </a>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            From R149/month · Cancel anytime · Day 1 sent immediately on payment
          </p>
        </motion.div>

        {/* Social proof bar */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mt-16 flex flex-wrap justify-center gap-8 text-sm text-muted-foreground"
        >
          {[
            { label: "Active clients", value: stats ? `${stats.activeClients}+` : "200+" },
            { label: "Workouts logged", value: stats ? `${stats.workoutsLogged.toLocaleString()}+` : "4,800+" },
            { label: "Average cost per day", value: "R3.30" },
            { label: "No new apps", value: "Just WhatsApp" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-2xl font-bold font-display text-foreground">{s.value}</div>
              <div className="text-xs mt-0.5">{s.label}</div>
            </div>
          ))}
        </motion.div>
      </main>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">How it works</h2>
            <p className="text-muted-foreground text-lg">Three steps. No new apps. No gym required.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "Message Coach K",
                desc: "Send a WhatsApp to start your free trial. Three questions and your personalised programme is ready in under 2 minutes.",
                icon: MessageCircle,
              },
              {
                step: "02",
                title: "Follow your programme",
                desc: "Get your workout plan, meal guidance, and daily check-ins via WhatsApp. Log food by typing what you ate. No calorie counting apps.",
                icon: Zap,
              },
              {
                step: "03",
                title: "Coach K keeps you accountable",
                desc: "Weekly reports every Sunday. Automated alerts when you go quiet. Real coaching that adjusts as your results come in.",
                icon: TrendingUp,
              },
            ].map((item) => (
              <div key={item.step} className="relative p-8 rounded-3xl bg-card border border-border/60 hover:border-primary/30 hover:shadow-lg transition-all">
                <div className="text-6xl font-bold font-display text-primary/10 absolute top-4 right-6">{item.step}</div>
                <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-6">
                  <item.icon className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold mb-3">{item.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">Everything you need to get results</h2>
            <p className="text-muted-foreground text-lg">Built specifically for South African lifestyles and budgets</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: CheckCircle, title: "SA-specific meal plans", desc: "Jungle Oats, pilchards, pap, vetkoek — plans built around real SA food at Shoprite prices. Under-R100/week plan included." },
              { icon: Zap, title: "3-day full body programme", desc: "Gym, home, or dumbbells only. Science-based full body programme that actually works for beginners and intermediates." },
              { icon: TrendingUp, title: "Photo food logging", desc: "Snap your plate and send it. Coach K identifies the food and gives you macros and feedback instantly." },
              { icon: Shield, title: "Braai and takeout coaching", desc: "Nando's, KFC, Steers, braais — guides for every SA eating scenario so you never feel stuck." },
              { icon: Users, title: "Weekly progress reports", desc: "Every Sunday: steps, workouts, weight change, and a verdict. No guessing where you stand." },
              { icon: Star, title: "Automatic accountability", desc: "Go quiet for 7 days and Coach K messages you. Completes a streak milestone and you get a celebration." },
            ].map((f) => (
              <div key={f.title} className="p-6 rounded-2xl bg-card border border-border/50 hover:border-primary/20 hover:shadow-md transition-all group">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-4 group-hover:scale-110 transition-transform">
                  <f.icon className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-lg mb-2">{f.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-4xl font-bold font-display mb-4">Choose your level</h2>
          <p className="text-muted-foreground mb-12">All plans on WhatsApp. No app needed. Cancel anytime.</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">

            {/* Basic */}
            <div className="bg-card rounded-3xl border border-border p-8 relative overflow-hidden text-left">
              <div className="text-sm font-semibold text-muted-foreground mb-2">Basic</div>
              <div className="flex items-end gap-1 mb-1">
                <span className="text-5xl font-bold font-display">R149</span>
                <span className="text-muted-foreground mb-2">/month</span>
              </div>
              <p className="text-muted-foreground text-sm mb-6">R3.30/day — less than a taxi fare</p>
              <ul className="space-y-3 mb-8">
                {[
                  "Personalised workout programme",
                  "SA meal plans at Shoprite prices",
                  "Daily WhatsApp check-ins",
                  "Step & food logging",
                  "Weekly Sunday report",
                  "Braai & takeout guides",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Button className="w-full rounded-2xl" asChild>
                <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="w-4 h-4 mr-2" />
                  Start Basic
                </a>
              </Button>
            </div>

            {/* Pro — most popular */}
            <div className="bg-card rounded-3xl border-2 border-primary p-8 relative overflow-hidden text-left shadow-xl shadow-primary/10">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-emerald-500 rounded-t-3xl" />
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-primary">Pro</div>
                <span className="text-xs font-bold bg-primary text-white px-2 py-0.5 rounded-full">Most popular</span>
              </div>
              <div className="flex items-end gap-1 mb-1">
                <span className="text-5xl font-bold font-display">R199</span>
                <span className="text-muted-foreground mb-2">/month</span>
              </div>
              <p className="text-muted-foreground text-sm mb-6">R6.60/day — less than a Nando's quarter</p>
              <ul className="space-y-3 mb-8">
                {[
                  "Everything in Basic",
                  "Weekly coach review of your logs",
                  "Progress photo analysis",
                  "Personalised monthly check-in call",
                  "Priority response within 2 hours",
                  "Custom meal swaps for your budget",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Button size="lg" className="w-full h-12 rounded-2xl font-bold" asChild>
                <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="w-4 h-4 mr-2" />
                  Start Pro
                </a>
              </Button>
            </div>

            {/* Premium */}
            <div className="bg-card rounded-3xl border border-border p-8 relative overflow-hidden text-left">
              <div className="flex items-center gap-2 mb-2">
                <Crown className="w-4 h-4 text-amber-500" />
                <div className="text-sm font-semibold text-amber-500">Premium</div>
              </div>
              <div className="flex items-end gap-1 mb-1">
                <span className="text-5xl font-bold font-display">R349</span>
                <span className="text-muted-foreground mb-2">/month</span>
              </div>
              <p className="text-muted-foreground text-sm mb-6">Full coaching experience</p>
              <ul className="space-y-3 mb-8">
                {[
                  "Everything in Pro",
                  "Weekly personal voice note from Coach Kam",
                  "Unlimited WhatsApp voice replies",
                  "Injury rehab protocol",
                  "Supplement & blood work guidance",
                  "Direct line — replies within 30 minutes",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="w-full rounded-2xl border-2" asChild>
                <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                  <Crown className="w-4 h-4 mr-2" />
                  Start Premium
                </a>
              </Button>
            </div>

          </div>
          <p className="text-sm text-muted-foreground mt-6">All plans: cancel anytime · Day 1 workout sent immediately on payment · Refer a friend and you both get one month free</p>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl font-bold font-display text-center mb-12">Common questions</h2>
          <div className="space-y-6">
            {[
              {
                q: "Do I need a gym membership?",
                a: "No. Coach K builds home workouts with zero equipment, dumbbell programmes for basic gyms like Planet Fitness, and full gym programmes. You choose at signup.",
              },
              {
                q: "What if I can only afford cheap food?",
                a: "The under-R100 weekly meal plan is built around eggs, pilchards, pap, sugar beans, and spinach — all available at Shoprite. Eating well in SA does not require a big budget.",
              },
              {
                q: "Is this a real coach or a bot?",
                a: "It is an AI coach trained specifically on South African food, lifestyle, and fitness. It knows pap from polenta and Nando's from a generic chicken restaurant. Over time it remembers your wins and adapts to you.",
              },
              {
                q: "What if I have a medical condition?",
                a: "Coach K adjusts for diabetes, hypertension, PCOS, ARV medication, injuries, and more. If you need doctor clearance for exercise, it flags that clearly.",
              },
              {
                q: "How do I cancel?",
                a: "Reply CANCEL to Coach K at any time. No phone calls, no forms, no hassle. Your data and progress stay saved for 90 days — come back whenever you are ready.",
              },
            ].map((faq) => (
              <div key={faq.q} className="p-6 rounded-2xl bg-card border border-border/50">
                <h3 className="font-bold mb-2">{faq.q}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 px-4 bg-primary text-white text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl font-bold font-display mb-4">Start today. Results in week one.</h2>
          <p className="text-primary-foreground/80 text-lg mb-8">
            3 questions and your programme is built. Day 1 delivered the moment you pay. From R149/month.
          </p>
          <Button size="lg" variant="secondary" className="h-14 px-10 rounded-2xl text-base font-bold" asChild>
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
              <Phone className="w-5 h-5 mr-2" />
              Start Coaching on WhatsApp
            </a>
          </Button>
          <p className="text-primary-foreground/60 text-sm mt-4">From R149/month · Cancel anytime · No app needed</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10 px-4 text-center text-muted-foreground text-sm">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
              <span className="text-white font-bold text-xs">K</span>
            </div>
            <span className="font-semibold text-foreground">KamLife Coach</span>
          </div>
          <p>Built for South Africa 🇿🇦 · POPIA compliant · From R149/month</p>
          <Link href="/login" className="hover:text-foreground transition-colors">Coach Login</Link>
        </div>
      </footer>
    </div>
  );
}
