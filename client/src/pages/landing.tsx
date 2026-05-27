import { Button } from "@/components/ui/button";
import {
  MessageCircle, CheckCircle, TrendingUp, Shield, Zap, Users, Star,
  ChevronRight, Phone, Target, Heart, Flame, Dumbbell, Apple, Footprints,
  Moon, Camera, ShoppingCart, Trophy
} from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || "27600000000";
const WA_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C%20I%27d%20like%20to%20start%20coaching`;

// Set VITE_HERO_VIDEO_URL in Railway env to point to your compressed .mp4
// Rules: autoplay, muted, looping — compress to <5MB for performance
const HERO_VIDEO_URL = import.meta.env.VITE_HERO_VIDEO_URL || "";

const GOALS = [
  {
    icon: Flame,
    color: "text-orange-500",
    bg: "bg-orange-50 dark:bg-orange-900/20",
    border: "border-orange-200 dark:border-orange-800",
    title: "Lose fat",
    who: "Overweight · Post-baby · Slow metabolism · Diabetic",
    what: "Coach K builds your deficit, keeps you full on SA food, and adjusts every week based on your results. No starvation. No guessing.",
  },
  {
    icon: Dumbbell,
    color: "text-blue-500",
    bg: "bg-blue-50 dark:bg-blue-900/20",
    border: "border-blue-200 dark:border-blue-800",
    title: "Build muscle",
    who: "Skinny · Underweight · Wants to bulk · Men and women",
    what: "Progressive overload programme. High-protein SA meal plans. Weekly strength check-ins. Built for home, dumbbells, or a full gym.",
  },
  {
    icon: Heart,
    color: "text-rose-500",
    bg: "bg-rose-50 dark:bg-rose-900/20",
    border: "border-rose-200 dark:border-rose-800",
    title: "Get healthy",
    who: "Hypertension · PCOS · ARVs · Over 40 · Sedentary lifestyle",
    what: "Coach K knows your condition. Adjusts for medication, doctor clearance, and lifestyle. No dangerous advice. Practical and safe.",
  },
  {
    icon: Target,
    color: "text-emerald-500",
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    border: "border-emerald-200 dark:border-emerald-800",
    title: "Body recomp",
    who: "Wants to lose fat AND gain muscle · Plateau · Frustrated with the scale",
    what: "Protein-high, calorie-controlled, training-heavy. The hardest goal done right. Requires consistency — Coach K makes that easy.",
  },
];

const PERSONAS = [
  { emoji: "👩‍👧", label: "Busy mom, 34", desc: "No time for gym. Eats what the family eats. Needs something that fits real life." },
  { emoji: "🧑‍💼", label: "Office worker, 28", desc: "Sits all day. Eats takeaways. Wants to lose the belly without giving up Nando's." },
  { emoji: "💪", label: "Gym guy, 22", desc: "Trains but doesn't track food. Hasn't seen results in 6 months. Wants a programme that works." },
  { emoji: "👵", label: "Over 50, health-first", desc: "Doctor said lose weight. On medication. Needs safe, realistic guidance." },
  { emoji: "🏘️", label: "Township, budget-conscious", desc: "Shoprite and Boxer budget. Pap, pilchards, eggs. Needs a plan that's actually affordable." },
  { emoji: "🎓", label: "Student, broke", desc: "R50 a week for food. Wants to stay fit without a gym membership or expensive supplements." },
];

const FEATURES = [
  {
    icon: Apple,
    title: "SA food logging — any meal",
    desc: "Type what you ate or snap a photo. Pap, pilchards, kota, braai, Nando's — Coach K knows it all. No calorie app needed.",
  },
  {
    icon: Dumbbell,
    title: "3–5 day programme — all levels",
    desc: "Home, dumbbells, or full gym. Beginners through advanced. Coach K assigns your programme on Day 1 and adjusts as you improve.",
  },
  {
    icon: Footprints,
    title: "Auto step sync",
    desc: "Connect Google Fit, Samsung Health, or Apple Health once. Your steps sync automatically every evening — no manual logging.",
  },
  {
    icon: ShoppingCart,
    title: "Grocery list rebuild",
    desc: "Send your shopping list. Coach K rewrites it optimised for your goal and budget — with SA store prices and quantities included.",
  },
  {
    icon: Camera,
    title: "Photo food logging",
    desc: "Snap your plate and send it. Coach K identifies the food, estimates macros, and gives you feedback in 10 seconds.",
  },
  {
    icon: TrendingUp,
    title: "Weekly progress reports",
    desc: "Every Sunday: steps, workouts, weight change, food compliance, and a verdict. No guessing where you stand.",
  },
  {
    icon: Shield,
    title: "Braai, kota, and takeout coaching",
    desc: "Nando's, KFC, Steers, Chicken Licken — real guides for every SA eating scenario. You never have to feel stuck.",
  },
  {
    icon: Moon,
    title: "Daily accountability",
    desc: "Morning check-in with yesterday's summary. Evening nudge when habits slip. Water reminders. Sleep reminders. All automatic.",
  },
  {
    icon: Trophy,
    title: "Streaks and milestones",
    desc: "Coach K tracks your workout streak, food logging streak, and step streak. Misses get a shield. Wins get celebrated.",
  },
];

const TESTIMONIALS = [
  {
    name: "Thandiwe M.",
    location: "Soweto",
    goal: "Fat loss",
    quote: "I've tried diets my whole life. This is the first time someone actually speaks to me in my language about pap and pilchards instead of salads I can't afford.",
    result: "Dropped 8kg in 10 weeks",
  },
  {
    name: "Sipho K.",
    location: "Cape Town",
    goal: "Muscle gain",
    quote: "I was training for 2 years with nothing to show. Coach K fixed my eating and gave me a real programme. My chest and shoulders are finally growing.",
    result: "+5kg lean mass in 3 months",
  },
  {
    name: "Ayanda N.",
    location: "Durban",
    goal: "Health & PCOS",
    quote: "I have PCOS and was told to lose weight but nobody ever told me HOW. Coach K adjusted everything for my condition. I'm off two medications now.",
    result: "Lost 12kg over 4 months",
  },
  {
    name: "Ruan v.d.W.",
    location: "Pretoria",
    goal: "Recomp",
    quote: "The braai coaching alone is worth R199. I go to every family braai and stay on track. The weekly report keeps me honest.",
    result: "Lost 6kg, gained visible muscle",
  },
];

export default function LandingPage() {
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
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-18 flex items-center justify-between py-4 sticky top-0 bg-background/90 backdrop-blur-md z-50 border-b border-border/50">
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

      {/* ── HERO — full-screen video background ── */}
      <main className="relative min-h-[92vh] flex flex-col items-center justify-center text-center px-4 overflow-hidden">

        {/* Video background — autoplay, muted, looping (per best-practice) */}
        {HERO_VIDEO_URL ? (
          <video
            className="absolute inset-0 w-full h-full object-cover object-center"
            src={HERO_VIDEO_URL}
            autoPlay
            muted          // always mute on load — audio rarely plays anyway
            loop           // loop for continuous feel
            playsInline    // required for iOS autoplay
            preload="metadata"
          />
        ) : (
          /* Fallback gradient when no video is uploaded yet */
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-950" />
        )}

        {/* Dark overlay so text stays readable over any video */}
        <div className="absolute inset-0 bg-black/40" />

        {/* Bottom fade to blend into next section */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />

        {/* Hero content */}
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="relative z-10 max-w-4xl mx-auto space-y-7 pt-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/10 backdrop-blur-sm text-white text-sm font-semibold border border-white/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
            </span>
            Now Accepting Clients — South Africa
          </div>

          <h1 className="text-5xl sm:text-7xl font-display font-bold leading-[1.06] tracking-tight text-white drop-shadow-lg">
            Your personal SA fitness coach,{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-300">
              right in WhatsApp
            </span>
          </h1>

          <p className="text-xl text-white/80 max-w-2xl mx-auto leading-relaxed">
            Lose fat. Build muscle. Get healthier. Programmes for every body, every budget, every lifestyle —
            built specifically for South Africa. No app to download. No gym required.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
            <Button
              size="lg"
              className="h-14 px-8 rounded-2xl text-base font-bold bg-emerald-500 hover:bg-emerald-400 text-white shadow-2xl shadow-emerald-500/30 hover:scale-[1.02] transition-all border-0"
              asChild
            >
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 mr-2" />
                Start Free Trial — R199/month
              </a>
            </Button>
            <Button
              size="lg"
              className="h-14 px-8 rounded-2xl text-base font-semibold bg-white/10 hover:bg-white/20 text-white border border-white/30 backdrop-blur-sm transition-all"
              asChild
            >
              <a href="#goals">
                See all goals
                <ChevronRight className="w-4 h-4 ml-1" />
              </a>
            </Button>
          </div>

          <p className="text-sm text-white/50">
            7 days free · R199/month · Cancel anytime by WhatsApp · Programme sent on Day 1
          </p>
        </motion.div>

        {/* Social proof bar — anchored to bottom of hero */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="relative z-10 mt-16 mb-8 flex flex-wrap justify-center gap-10 text-sm"
        >
          {[
            { label: "Free trial", value: "7 days" },
            { label: "Cost per day", value: "R6.63" },
            { label: "Setup time", value: "3 mins" },
            { label: "Cancel anytime", value: "WhatsApp" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-3xl font-bold font-display text-white">{s.value}</div>
              <div className="text-xs mt-0.5 text-white/60">{s.label}</div>
            </div>
          ))}
        </motion.div>
      </main>

      {/* Who is this for */}
      <section className="py-20 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold font-display mb-3">Who is Coach K for?</h2>
            <p className="text-muted-foreground">If you've tried before and it didn't stick — this is built for you.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PERSONAS.map((p) => (
              <div key={p.label} className="flex gap-4 p-5 rounded-2xl bg-card border border-border/50 hover:border-primary/20 transition-all">
                <div className="text-3xl shrink-0">{p.emoji}</div>
                <div>
                  <div className="font-semibold text-sm mb-1">{p.label}</div>
                  <p className="text-muted-foreground text-sm leading-relaxed">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Goals */}
      <section id="goals" className="py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">What's your goal?</h2>
            <p className="text-muted-foreground text-lg">Coach K adapts to you — not the other way around.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {GOALS.map((g) => (
              <div key={g.title} className={`p-7 rounded-3xl border ${g.border} ${g.bg} hover:shadow-lg transition-all`}>
                <div className={`w-12 h-12 rounded-2xl bg-white/60 dark:bg-black/20 flex items-center justify-center mb-5`}>
                  <g.icon className={`w-6 h-6 ${g.color}`} />
                </div>
                <h3 className="text-xl font-bold mb-2">{g.title}</h3>
                <p className={`text-xs font-semibold uppercase tracking-wide mb-3 ${g.color} opacity-80`}>{g.who}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{g.what}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Button size="lg" className="h-14 px-8 rounded-2xl font-bold text-base" asChild>
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 mr-2" />
                Start — Coach K asks your goal on Day 1
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">How it works</h2>
            <p className="text-muted-foreground text-lg">Three steps. No new apps. Under 3 minutes.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "WhatsApp Coach K",
                desc: "Send a message to start. Coach K asks about your goal, body, lifestyle, and budget. No forms. No downloads. Done in under 3 minutes.",
                icon: MessageCircle,
              },
              {
                step: "02",
                title: "Get your programme",
                desc: "Personalised workout plan — gym, home, or dumbbells. Meal plan with SA foods at real SA prices. Day 1 drops the moment you activate.",
                icon: Zap,
              },
              {
                step: "03",
                title: "Coach K keeps you going",
                desc: "Daily morning check-ins. Evening nudges. Water reminders. Weekly progress reports. Automatic accountability every single day.",
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
            <h2 className="text-4xl font-bold font-display mb-4">Everything included. Nothing extra to buy.</h2>
            <p className="text-muted-foreground text-lg">Built specifically for South African lifestyles, food, and budgets.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
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

      {/* Testimonials */}
      <section className="py-24 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">Real clients. Real results.</h2>
            <p className="text-muted-foreground text-lg">Across every goal, every budget, every part of South Africa.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {TESTIMONIALS.map((t) => (
              <div key={t.name} className="p-7 rounded-3xl bg-card border border-border/60 hover:shadow-lg transition-all flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-bold">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.location} · {t.goal}</div>
                  </div>
                  <div className="flex gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
                    ))}
                  </div>
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed italic">"{t.quote}"</p>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs font-semibold w-fit border border-emerald-200 dark:border-emerald-800">
                  <CheckCircle className="w-3.5 h-3.5" />
                  {t.result}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 px-4">
        <div className="max-w-lg mx-auto text-center">
          <h2 className="text-4xl font-bold font-display mb-4">One plan. Everything included.</h2>
          <p className="text-muted-foreground mb-12">All goals. All fitness levels. WhatsApp only. Cancel anytime.</p>

          <div className="bg-card rounded-3xl border-2 border-primary p-10 relative overflow-hidden text-left shadow-xl shadow-primary/10">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-emerald-500 rounded-t-3xl" />
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-semibold text-primary uppercase tracking-wide">KamLife Coach</div>
              <span className="text-xs font-bold bg-primary text-white px-3 py-1 rounded-full">Beta price</span>
            </div>
            <div className="flex items-end gap-1 mb-1">
              <span className="text-6xl font-bold font-display">R199</span>
              <span className="text-muted-foreground mb-2 text-lg">/month</span>
            </div>
            <p className="text-muted-foreground text-sm mb-8">R6.63/day — less than a taxi fare. Cancel anytime on WhatsApp.</p>
            <ul className="space-y-3 mb-10">
              {[
                "Personalised programme — gym, home, or dumbbells",
                "All goal types: fat loss · muscle gain · recomp · health",
                "SA meal plans at Shoprite, Boxer & Pick n Pay prices",
                "Daily WhatsApp coaching — morning + evening",
                "Photo food logging — snap and send",
                "Automatic step sync from your health app",
                "Grocery list rebuild for your goal and budget",
                "Braai, kota, fast food, and takeout coaching",
                "Weekly Sunday progress reports",
                "Injury modifications and medical condition support",
                "Supplement advice — honest, SA-priced",
                "7-day free trial — Day 1 sent immediately",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <Button size="lg" className="w-full h-14 rounded-2xl font-bold text-base" asChild>
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 mr-2" />
                Start your free trial
              </a>
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-4">7 days free · Then R199/month · Cancel anytime on WhatsApp</p>
          </div>

          <p className="text-sm text-muted-foreground mt-6">Refer a friend and you both get one month free</p>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 px-4 bg-muted/30">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl font-bold font-display text-center mb-12">Common questions</h2>
          <div className="space-y-6">
            {[
              {
                q: "Do I need a gym membership?",
                a: "No. Coach K builds home workouts with zero equipment, dumbbell programmes, or full gym programmes. You choose at signup and can change anytime.",
              },
              {
                q: "What if I can only afford cheap food?",
                a: "The under-R100 weekly meal plan is built around eggs, pilchards, pap, sugar beans, and spinach — all available at Shoprite. Good results do not require an expensive diet.",
              },
              {
                q: "Is this a real coach or a bot?",
                a: "It is an AI coach trained specifically on South African food, lifestyle, and fitness. It knows pap from polenta, pilchards from salmon, and Nando's from a generic chicken restaurant. Over time it remembers your wins, your patterns, and adapts.",
              },
              {
                q: "What if I have diabetes, hypertension, PCOS, or I'm on ARVs?",
                a: "Coach K adjusts for all of these. It flags when doctor clearance is needed, avoids foods that interact with common medications, and keeps nutrition within safe ranges for your condition.",
              },
              {
                q: "I'm over 50 and out of shape — is this for me?",
                a: "Yes. Coach K builds beginner programmes that start where you are. Slow, safe progress beats aggressive programmes that hurt your joints or burn you out in week 2.",
              },
              {
                q: "How do I cancel?",
                a: "Reply CANCEL to Coach K at any time. No phone calls. No forms. No hassle. Your programme and progress are saved for 90 days — come back whenever you're ready.",
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
          <h2 className="text-4xl font-bold font-display mb-4">Your programme is waiting.</h2>
          <p className="text-primary-foreground/80 text-lg mb-8">
            3 questions on WhatsApp. Programme built in 2 minutes. Day 1 delivered immediately.
            Whatever your goal, whatever your budget — Coach K is built for you.
          </p>
          <Button size="lg" variant="secondary" className="h-14 px-10 rounded-2xl text-base font-bold" asChild>
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
              <Phone className="w-5 h-5 mr-2" />
              Start Coaching on WhatsApp
            </a>
          </Button>
          <p className="text-primary-foreground/60 text-sm mt-4">7 days free · R199/month · Cancel anytime · No app needed</p>
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
          <p>Built for South Africa 🇿🇦 · POPIA compliant · R199/month</p>
          <Link href="/login" className="hover:text-foreground transition-colors">Coach Login</Link>
        </div>
      </footer>
    </div>
  );
}
