import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MessageCircle, CheckCircle, TrendingUp, Shield, Zap, Users, Star,
  ChevronRight, Phone, Target, Heart, Flame, Dumbbell, Apple, Footprints,
  Moon, Camera, ShoppingCart, Trophy, Plus, Minus, Mic
} from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
);

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || "27600000000";
const WA_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C%20I%27d%20like%20to%20start%20coaching`;

// Set VITE_HERO_VIDEO_URL in Railway env to point to your compressed .mp4
// Rules: autoplay, muted, looping — compress to <5MB for performance
const HERO_VIDEO_URL = import.meta.env.VITE_HERO_VIDEO_URL || "";

const GOALS = [
  {
    icon: Target,
    color: "text-orange-500",
    headerGradient: "from-orange-100 to-amber-50 dark:from-orange-900/40 dark:to-amber-900/20",
    iconBg: "bg-white dark:bg-black/30",
    border: "border-orange-300 dark:border-orange-700",
    title: "Body recomp",
    badge: "Most popular",
    who: "Lose fat AND build muscle · Plateau · Trained but not seeing results",
    what: "Lose fat and build muscle at the same time. This is what most people actually want when they say they want to 'get fit'. Coach K handles the precision — protein targets, training load, weekly adjustments. You just show up.",
  },
  {
    icon: Flame,
    color: "text-orange-500",
    headerGradient: "from-orange-100 to-amber-50 dark:from-orange-900/40 dark:to-orange-800/20",
    iconBg: "bg-white dark:bg-black/30",
    border: "border-orange-200 dark:border-orange-800",
    title: "Lose fat",
    badge: null,
    who: "Overweight · Post-baby · Slow metabolism · Diabetic",
    what: "Coach K builds your deficit, keeps you full on SA food, and adjusts every week based on your results. No starvation. No guessing.",
  },
  {
    icon: Dumbbell,
    color: "text-secondary",
    headerGradient: "from-slate-100 to-blue-50 dark:from-secondary/40 dark:to-secondary/20",
    iconBg: "bg-white dark:bg-black/30",
    border: "border-secondary/20 dark:border-secondary/40",
    title: "Build muscle",
    badge: null,
    who: "Skinny · Underweight · Wants to bulk · Men and women",
    what: "Progressive overload programme. High-protein SA meal plans. Weekly strength check-ins. Built for home, dumbbells, or a full gym.",
  },
  {
    icon: Heart,
    color: "text-orange-500",
    headerGradient: "from-orange-100 to-rose-50 dark:from-orange-900/40 dark:to-rose-900/20",
    iconBg: "bg-white dark:bg-black/30",
    border: "border-orange-200 dark:border-orange-800",
    title: "Get healthy",
    badge: null,
    who: "Diabetes · Hypertension · PCOS · Over 40 · Sedentary lifestyle",
    what: "Coach K adjusts for your condition — safe calorie ranges, foods that work with your medication, and a pace that won't break you. Practical. Not clinical.",
  },
];

const PERSONAS = [
  {
    emoji: "🔥", bg: "bg-orange-500/25",
    label: "The mkhaba mission", age: "30, Pretoria",
    desc: "Belly fat that won't move no matter what. Tried everything. 'I barely eat' — but the mkhaba stays. Needs to understand what's actually causing it.",
  },
  {
    emoji: "🔄", bg: "bg-sky-500/25",
    label: "Body recomp goals", age: "26, Joburg",
    desc: "Saw body recomp online. Wants to lose fat AND build muscle at the same time. Tired of being told to pick one or the other.",
  },
  {
    emoji: "👩‍👧", bg: "bg-pink-500/25",
    label: "Busy mom", age: "34, Cape Town",
    desc: "No time for gym. Eats what the family eats. Needs something that fits real life — not a 6am gym session and a meal plan nobody else will eat.",
  },
  {
    emoji: "🧑‍💼", bg: "bg-slate-500/25",
    label: "Office worker", age: "28, Sandton",
    desc: "Sits all day. Eats takeaways. Wants to lose the belly without giving up Nando's or spending hours cooking.",
  },
  {
    emoji: "💪", bg: "bg-green-500/25",
    label: "Gym member who barely goes", age: "22, Durban",
    desc: "Trains hard when they go — but been 4 times in 3 months. Paying for membership, getting no results. Needs accountability and a plan.",
  },
  {
    emoji: "🎓", bg: "bg-purple-500/25",
    label: "Student, broke", age: "20, Soweto",
    desc: "R50 a week for food. Wants to stay fit without a gym membership or expensive supplements. Needs it to work on a student budget.",
  },
];

const FEATURES = [
  {
    icon: Apple,
    title: "Eat what you already eat — just smarter",
    desc: "No clean eating. No expensive salads. Log your pap, your kota, your braai — Coach K shows you exactly how it fits your goal and what to adjust.",
  },
  {
    icon: Dumbbell,
    title: "2–5 day programme — all levels",
    desc: "Home, dumbbells, or full gym. 2 days or 5 days — you choose. Coach K assigns your programme on Day 1 and adjusts as you improve.",
  },
  {
    icon: Footprints,
    title: "Auto step sync",
    desc: "Connect Google Fit, Samsung Health, or Apple Health once. Your steps sync automatically every evening — no manual logging.",
  },
  {
    icon: ShoppingCart,
    title: "Your exact grocery list — done for you",
    desc: "Tell Coach K your budget. Get back a specific Shoprite or Boxer list — exact items, exact quantities, exact rand amounts. No guessing. No wasted money.",
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
    title: "Braai, KFC, kota — you're covered",
    desc: "Going to a braai? Coach K tells you what to eat and how much. Nando's? Steers? Chicken Licken? There's a guide for all of it. Real life, not a diet magazine.",
  },
  {
    icon: Moon,
    title: "Coach K notices when you go quiet",
    desc: "Go quiet for a few days? Coach K checks in — no lecture, no guilt. Just a nudge to come back. No streak to restart. No catching up. Just: what's next?",
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
  const [openFaq, setOpenFaq] = useState<number | null>(null);
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
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between py-3 sticky top-0 bg-white/95 backdrop-blur-md z-50 border-b border-border/50">
        <div className="flex items-center">
          <img
            src="https://res.cloudinary.com/dkxpypiak/image/upload/h_120,c_fit,f_auto/image-1779985068852_v6rnbe"
            alt="KamLife Lifestyle Coach"
            className="h-20 w-auto object-contain"
            style={{ mixBlendMode: "multiply" }}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" className="rounded-full font-semibold bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 px-5" asChild>
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
              <WhatsAppIcon className="w-4 h-4 mr-1.5" />
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
          /* Fallback when no video — layered gradients + subtle mesh so the hero
             doesn't look like a blank placeholder */
          <>
            <div className="absolute inset-0 bg-gradient-to-br from-[#0B1D35] via-[#1E3A6E] to-[#0B2A1A]" />
            {/* radial highlight top-left — gives depth */}
            <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 80% 60% at 20% 30%, rgba(251,146,60,0.12) 0%, transparent 70%)" }} />
            {/* radial highlight bottom-right */}
            <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 60% 50% at 80% 80%, rgba(37,211,102,0.08) 0%, transparent 65%)" }} />
            {/* subtle dot-grid texture */}
            <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
          </>
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
            Change your body.{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-amber-200">
              SA coaching in WhatsApp.
            </span>
          </h1>

          <p className="text-xl text-white/80 max-w-2xl mx-auto leading-relaxed">
            Lose the mkhaba. Body recomp. Build muscle. Coach K builds around your food, your budget, and your life. No gym needed. No perfect diet required.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
            <Button
              size="lg"
              className="h-14 px-8 rounded-2xl text-base font-bold bg-[#25D366] hover:bg-[#1ebe5d] text-white shadow-2xl shadow-green-500/30 hover:scale-[1.02] transition-all border-0"
              asChild
            >
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon className="w-5 h-5 mr-2" />
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

          <div className="flex flex-wrap justify-center gap-1.5 text-xs text-white/60">
            <span>⭐⭐⭐⭐⭐ Trusted by clients in</span>
            <span className="text-white/80 font-medium">Soweto · Cape Town · Durban · Pretoria</span>
          </div>
          <p className="text-sm text-white/40">
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
      <section className="py-20 px-4 bg-[#1E3A6E]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold font-display mb-3 text-white">Who is Coach K for?</h2>
            <p className="text-white/70">If you've tried before and it didn't stick — this is built for you.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PERSONAS.map((p) => (
              <div key={p.label} className="flex gap-4 p-5 rounded-2xl bg-white/10 border border-white/20 hover:border-orange-400/60 hover:bg-white/15 transition-all">
                {/* Avatar circle — replace emoji with <img src={p.photoUrl}> when real photos are ready */}
                <div className={`w-16 h-16 shrink-0 rounded-2xl ${p.bg} flex items-center justify-center text-3xl border border-white/10`}>
                  {p.emoji}
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-white leading-tight">{p.label}</div>
                  <div className="text-orange-400/80 text-xs font-medium mb-1.5">{p.age}</div>
                  <p className="text-white/70 text-sm leading-relaxed">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── THE PERMISSION SECTION — no gym, no perfection, just go ── */}
      <section className="py-20 px-4 bg-gradient-to-br from-[#0B1D35] via-[#0f2644] to-[#0B1D35] text-white">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-orange-400 text-xs font-bold uppercase tracking-widest mb-4">Why people actually stick to this</p>
          <h2 className="text-4xl sm:text-5xl font-bold font-display mb-5 leading-tight">
            Gym or no gym. Perfect diet or real life.<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-amber-300">Just go.</span>
          </h2>
          <p className="text-white/55 text-lg max-w-xl mx-auto mb-14 leading-relaxed">
            The fitness industry makes this feel complicated because complicated sells supplements. Coach K does the opposite — the simpler it is, the longer you last.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 text-left">
            {[
              {
                emoji: "🏋️",
                heading: "Gym or home — both work.",
                body: "Full gym, home dumbbells, or no equipment at all. Coach K builds your programme around what you have and where you train. Switch anytime.",
              },
              {
                emoji: "🍟",
                heading: "No perfect eating.",
                body: "Log your KFC. Log the braai. Log the chips. Knowing what you ate beats guessing every time. Coach K never shames — just coaches the next meal.",
              },
              {
                emoji: "↩️",
                heading: "Miss a day? Just come back.",
                body: "No streaks to restart. No catching up. No guilt trip. Coach K picks up exactly where you left off — even if it's been three weeks.",
              },
            ].map((item) => (
              <div key={item.heading} className="bg-white/[0.06] rounded-2xl p-6 border border-white/10 hover:border-orange-400/40 hover:bg-white/[0.09] transition-all">
                <div className="text-3xl mb-3">{item.emoji}</div>
                <h3 className="font-bold text-lg text-white mb-2">{item.heading}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-12">
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-2xl bg-[#25D366] hover:bg-[#1ebe5d] text-white font-bold text-base shadow-xl shadow-green-500/20 transition-all hover:scale-[1.02]">
              <WhatsAppIcon className="w-5 h-5" />
              Start wherever you are — 7 days free
            </a>
          </div>
        </div>
      </section>

      {/* Goals */}
      <section id="goals" className="py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">What's your goal?</h2>
            <p className="text-muted-foreground text-lg">Body recomp, fat loss, muscle gain, or health — Coach K adapts to you, not the other way around.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {GOALS.map((g) => (
              <div key={g.title} className={`rounded-3xl border ${g.border} overflow-hidden hover:shadow-lg transition-all relative`}>
                {g.badge && (
                  <div className="absolute top-4 right-4 z-10 px-3 py-1 rounded-full bg-orange-500 text-white text-xs font-bold shadow-lg">
                    {g.badge}
                  </div>
                )}
                <div className={`bg-gradient-to-br ${g.headerGradient} px-7 py-8 flex items-center justify-center`}>
                  <div className={`w-16 h-16 rounded-2xl ${g.iconBg} shadow-sm flex items-center justify-center`}>
                    <g.icon className={`w-8 h-8 ${g.color}`} />
                  </div>
                </div>
                <div className="bg-card px-7 py-6">
                  <h3 className="text-xl font-bold mb-1">{g.title}</h3>
                  <p className={`text-xs font-semibold uppercase tracking-wide mb-3 ${g.color}`}>{g.who}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{g.what}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Button size="lg" className="h-14 px-8 rounded-2xl font-bold text-base bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 shadow-lg shadow-green-500/20" asChild>
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon className="w-5 h-5 mr-2" />
                Start on WhatsApp — Coach K asks your goal on Day 1
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 px-4 bg-muted/30">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold font-display mb-4">How it works</h2>
            <p className="text-muted-foreground text-lg">Three steps. No new apps. Under 3 minutes.</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">

            {/* Steps — vertical list */}
            <div className="space-y-0">
              {[
                { step: "01", icon: MessageCircle, title: "WhatsApp Coach K", desc: "Send a message to start. Coach K asks about your goal, body, lifestyle, and budget. No forms. No downloads. Done in under 3 minutes." },
                { step: "02", icon: Zap, title: "Get your programme", desc: "Personalised workout plan — gym, home, or dumbbells. Meal plan with SA foods at real SA prices. Day 1 drops the moment you activate." },
                { step: "03", icon: TrendingUp, title: "Coach K keeps you going", desc: "Daily morning check-ins. Evening nudges. Water reminders. Weekly progress reports. Automatic accountability every single day." },
              ].map((item, i) => (
                <div key={item.step} className="flex gap-5">
                  <div className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                      <item.icon className="w-6 h-6" />
                    </div>
                    {i < 2 && <div className="w-px flex-1 bg-border my-3" />}
                  </div>
                  <div className={i < 2 ? "pb-10" : ""}>
                    <div className="text-xs font-bold text-primary/50 uppercase tracking-widest mb-1 mt-1">{item.step}</div>
                    <h3 className="text-xl font-bold mb-2">{item.title}</h3>
                    <p className="text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* WhatsApp phone mockup */}
            <div className="flex justify-center">
              <div className="relative w-[272px] sm:w-[300px]">
                {/* Glow behind phone */}
                <div className="absolute -inset-6 bg-primary/8 rounded-full blur-3xl" />
                {/* Phone shell */}
                <div className="relative bg-[#1C1C1E] rounded-[52px] p-[10px] shadow-2xl ring-1 ring-white/10">
                  <div className="bg-white rounded-[44px] overflow-hidden">

                    {/* WhatsApp green header */}
                    <div className="bg-[#075E54]">
                      <div className="h-8" /> {/* status bar space */}
                      <div className="px-4 pb-3 flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-orange-500 flex items-center justify-center text-white text-sm font-bold shrink-0">K</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white text-sm font-semibold">Coach K</div>
                          <div className="text-green-300 text-[10px]">online</div>
                        </div>
                        <Phone className="w-4 h-4 text-white/70 shrink-0" />
                      </div>
                    </div>

                    {/* Chat area */}
                    <div className="bg-[#ECE5DD] px-2 py-3 space-y-2 text-[10.5px] leading-snug" style={{ minHeight: 390 }}>

                      {/* Morning check-in from Coach K */}
                      <div className="flex">
                        <div className="bg-white rounded-[14px] rounded-tl-[4px] px-2.5 py-2 max-w-[78%] shadow-sm">
                          <p className="font-medium">Good morning Sipho! 🌅</p>
                          <p className="mt-0.5 text-gray-700">Yesterday: <strong>7,842 steps</strong> ✅</p>
                          <p className="text-gray-700">Food on point. Today is <strong>chest day.</strong></p>
                          <p className="text-[8.5px] text-gray-400 text-right mt-1">08:01 ✓✓</p>
                        </div>
                      </div>

                      {/* User sends voice note */}
                      <div className="flex justify-end">
                        <div className="bg-[#DCF8C6] rounded-[14px] rounded-tr-[4px] px-2.5 py-2 max-w-[72%] shadow-sm">
                          <div className="flex items-center gap-1.5 text-gray-600">
                            <div className="flex gap-[2px] items-end h-3">
                              {[2,4,7,5,6,3,7,4,2,5,3,5,4].map((h,i) => (
                                <div key={i} className="w-[2px] bg-gray-400/70 rounded-full" style={{ height: `${h * 2}px` }} />
                              ))}
                            </div>
                            <span className="text-[9px] text-gray-500">0:08</span>
                          </div>
                          <p className="text-[8.5px] text-gray-400 text-right mt-0.5">08:03 ✓✓</p>
                        </div>
                      </div>

                      {/* Coach K reply */}
                      <div className="flex">
                        <div className="bg-white rounded-[14px] rounded-tl-[4px] px-2.5 py-2 max-w-[84%] shadow-sm">
                          <p className="text-gray-500 italic text-[9px]">I heard: "had eggs and pap for breakfast"</p>
                          <p className="mt-0.5"><strong>Food logged ✅</strong></p>
                          <p className="text-gray-700">~420 kcal · 28g protein</p>
                          <p className="text-[8.5px] text-gray-400 text-right mt-1">08:04 ✓✓</p>
                        </div>
                      </div>

                      {/* User sends food photo */}
                      <div className="flex justify-end">
                        <div className="bg-[#DCF8C6] rounded-[14px] rounded-tr-[4px] p-1.5 max-w-[60%] shadow-sm">
                          <div className="bg-gray-300/80 rounded-[10px] w-full h-16 flex items-center justify-center text-gray-500 text-xs">
                            📸 lunch.jpg
                          </div>
                          <p className="text-[8.5px] text-gray-400 text-right mt-0.5 pr-1">13:22 ✓✓</p>
                        </div>
                      </div>

                      {/* Coach K macro breakdown */}
                      <div className="flex">
                        <div className="bg-white rounded-[14px] rounded-tl-[4px] px-2.5 py-2 max-w-[80%] shadow-sm">
                          <p>~430 cal · 31g protein · 40g carbs</p>
                          <p className="mt-0.5 text-gray-700">Total today: <strong>1,710/2,200 cal</strong> 🎯</p>
                          <p className="text-[8.5px] text-gray-400 text-right mt-1">13:23 ✓✓</p>
                        </div>
                      </div>

                      {/* Weekly Sunday report */}
                      <div className="flex">
                        <div className="bg-white rounded-[14px] rounded-tl-[4px] px-2.5 py-2 max-w-[82%] shadow-sm">
                          <p className="font-bold text-[#075E54]">📊 Week 3 Report</p>
                          <p className="mt-1">Steps: 52,420 ✅</p>
                          <p>Workouts: 4/4 ✅</p>
                          <p>Weight: <strong>-0.8kg</strong> this week</p>
                          <p>Food: 85% on track 🔥</p>
                          <p className="text-[8.5px] text-gray-400 text-right mt-1">Sun 20:00 ✓✓</p>
                        </div>
                      </div>

                    </div>

                    {/* Input bar */}
                    <div className="bg-[#F0F0F0] px-2.5 py-2 flex items-center gap-2 border-t border-gray-200">
                      <div className="flex-1 bg-white rounded-full px-3 py-1.5 text-[10px] text-gray-400">Message</div>
                      <div className="w-7 h-7 rounded-full bg-[#075E54] flex items-center justify-center shrink-0">
                        <MessageCircle className="w-3.5 h-3.5 text-white" />
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── HOW TO LOG — the biggest barrier, solved ── */}
      <section className="py-24 px-4 bg-[#0B1D35]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-orange-400 text-sm font-bold uppercase tracking-widest mb-3">No more excuses about logging</p>
            <h2 className="text-4xl font-bold font-display text-white mb-4">Send it any way you have it.</h2>
            <p className="text-white/55 text-lg max-w-xl mx-auto">Voice note, photo, or text — Coach K handles the rest in seconds. No app. No forms. Just WhatsApp.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

            {/* Voice note */}
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center shrink-0">
                  <Mic className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base leading-tight">Voice note</h3>
                  <p className="text-white/40 text-xs">Just talk — no typing</p>
                </div>
              </div>
              <p className="text-white/55 text-sm mb-5 leading-relaxed">Send a 10-second voice note. Coach K transcribes your words and logs the meal instantly.</p>
              {/* Mini chat */}
              <div className="mt-auto space-y-2 text-[10.5px]">
                <div className="flex justify-end">
                  <div className="bg-[#DCF8C6] rounded-[12px] rounded-tr-[3px] px-2.5 py-2 max-w-[85%] shadow-sm">
                    <div className="flex items-center gap-2 text-gray-600">
                      <div className="flex gap-[2px] items-end h-3">
                        {[2,4,6,4,5,3,6,4,2,5,3,4].map((h,i) => (
                          <div key={i} className="w-[2px] bg-gray-400/60 rounded-full" style={{ height: `${h * 2}px` }} />
                        ))}
                      </div>
                      <span className="text-gray-500">0:12</span>
                    </div>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5">18:09 ✓✓</p>
                  </div>
                </div>
                <div className="flex">
                  <div className="bg-white rounded-[12px] rounded-tl-[3px] px-2.5 py-2 max-w-[92%] shadow-sm space-y-0.5">
                    <p className="text-gray-500 italic text-[9.5px]">I heard: "roasted potatoes, mixed veggies and chicken"</p>
                    <p className="font-semibold text-gray-800">Food logged ✅</p>
                    <p className="text-gray-700">Meal total: ~957 kcal · 90g protein</p>
                    <p className="text-gray-600">Today: 2,257 / 2,446 kcal 🎯</p>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5">18:10 ✓✓</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Photo */}
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Camera className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base leading-tight">Photo</h3>
                  <p className="text-white/40 text-xs">Snap and send</p>
                </div>
              </div>
              <p className="text-white/55 text-sm mb-5 leading-relaxed">Photograph your plate — even 10 photos at once. Coach K identifies each food and replies in seconds.</p>
              {/* Mini chat */}
              <div className="mt-auto space-y-2 text-[10.5px]">
                <div className="flex justify-end">
                  <div className="bg-[#DCF8C6] rounded-[12px] rounded-tr-[3px] p-1.5 max-w-[65%] shadow-sm">
                    <div className="bg-gray-300/60 rounded-[8px] h-14 flex items-center justify-center">
                      <Camera className="w-4 h-4 text-gray-500" />
                    </div>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5 pr-0.5">13:01 ✓✓</p>
                  </div>
                </div>
                <div className="flex">
                  <div className="bg-white rounded-[12px] rounded-tl-[3px] px-2.5 py-2 max-w-[92%] shadow-sm space-y-0.5">
                    <p className="font-semibold text-gray-800">Food logged ✅</p>
                    <p className="text-gray-700">Pap · chakalaka · 2 chicken pieces</p>
                    <p className="text-gray-700">~680 kcal · 41g protein</p>
                    <p className="text-gray-600">Today: 1,490 / 2,200 kcal 🎯</p>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5">13:02 ✓✓</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Text */}
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
                  <MessageCircle className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base leading-tight">Text</h3>
                  <p className="text-white/40 text-xs">Type anything natural</p>
                </div>
              </div>
              <p className="text-white/55 text-sm mb-5 leading-relaxed">Type it how you'd say it. "Had a kota for lunch" or "KFC 2-piece". Coach K understands SA food and slang.</p>
              {/* Mini chat */}
              <div className="mt-auto space-y-2 text-[10.5px]">
                <div className="flex justify-end">
                  <div className="bg-[#DCF8C6] rounded-[12px] rounded-tr-[3px] px-2.5 py-2 max-w-[85%] shadow-sm">
                    <p className="text-gray-800">had 2 boerewors rolls at braai</p>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5">18:32 ✓✓</p>
                  </div>
                </div>
                <div className="flex">
                  <div className="bg-white rounded-[12px] rounded-tl-[3px] px-2.5 py-2 max-w-[92%] shadow-sm space-y-0.5">
                    <p className="font-semibold text-gray-800">Food logged ✅</p>
                    <p className="text-gray-700">~560 kcal · 22g protein</p>
                    <p className="text-gray-600">Today: 1,890 / 2,200 kcal · on track 🔥</p>
                    <p className="text-[8.5px] text-gray-400 text-right mt-0.5">18:32 ✓✓</p>
                  </div>
                </div>
              </div>
            </div>

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
      <section className="py-24 px-4 bg-orange-50/50 dark:bg-orange-900/10">
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
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 text-xs font-semibold w-fit border border-orange-200 dark:border-orange-800">
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
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange-500 to-amber-400 rounded-t-3xl" />
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-semibold text-primary uppercase tracking-wide">Coach K</div>
              <span className="text-xs font-bold bg-amber-500 text-white px-3 py-1 rounded-full">Founding Member Price</span>
            </div>
            <div className="flex items-end gap-1 mb-1">
              <span className="text-6xl font-bold font-display">R199</span>
              <span className="text-muted-foreground mb-2 text-lg">/month</span>
            </div>
            <p className="text-muted-foreground text-sm mb-8">R6.63/day — less than a taxi fare. Cancel anytime on WhatsApp.</p>
            <ul className="space-y-3 mb-10">
              {[
                "Exact grocery list — Shoprite, Boxer & Pick n Pay, your budget",
                "Braai, kota, KFC, Steers — real SA eating, fully coached",
                "Daily accountability — Coach K notices when you go quiet",
                "Personalised 2–5 day programme — gym, home, or dumbbells",
                "All goal types: fat loss · muscle gain · recomp · health",
                "Photo food logging — snap your plate, get feedback in 10 seconds",
                "Automatic step sync from Google Fit, Samsung Health, Apple Health",
                "Weekly Sunday progress report — steps, weight, food, verdict",
                "Injury modifications and medical condition support",
                "Supplement advice — honest, SA-priced",
                "7-day free trial — programme sent on Day 1",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <Button size="lg" className="w-full h-14 rounded-2xl font-bold text-base bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 shadow-lg shadow-green-500/20" asChild>
              <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon className="w-5 h-5 mr-2" />
                Start your free trial on WhatsApp
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
          <div className="space-y-3">
            {[
              {
                q: "What is body recomp and why do most people choose it?",
                a: "Body recomposition means losing fat and building muscle at the same time. It's the goal most people actually want — you want to look different, not just weigh less. Coach K manages this with high-protein eating, progressive training, and weekly adjustments. It's slower than a crash diet but the results last because you're changing your body composition, not just your weight.",
              },
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
            ].map((faq, i) => (
              <div
                key={faq.q}
                className="rounded-2xl bg-card border border-border/50 overflow-hidden"
              >
                <button
                  className="w-full flex items-center justify-between gap-4 p-6 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                >
                  <h3 className="font-bold">{faq.q}</h3>
                  {openFaq === i
                    ? <Minus className="w-4 h-4 text-primary shrink-0" />
                    : <Plus className="w-4 h-4 text-muted-foreground shrink-0" />
                  }
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-6 border-t border-border/50 pt-4">
                    <p className="text-muted-foreground text-sm leading-relaxed">{faq.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 px-4 bg-[#1E3A6E] text-white text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl font-bold font-display mb-4">Start messy. Start imperfect. Just start.</h2>
          <p className="text-white/75 text-lg mb-8">
            3 questions on WhatsApp. Programme in 2 minutes. No gym required. No perfect diet required.
            Whatever you have — Coach K builds around it.
          </p>
          <Button size="lg" className="h-14 px-10 rounded-2xl text-base font-bold bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 shadow-2xl shadow-green-500/30" asChild>
            <a href={WA_LINK} target="_blank" rel="noopener noreferrer">
              <WhatsAppIcon className="w-5 h-5 mr-2" />
              Start Coaching on WhatsApp
            </a>
          </Button>
          <p className="text-white/50 text-sm mt-4">7 days free · R199/month · Cancel anytime · No app needed</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10 px-4 text-center text-muted-foreground text-sm bg-white">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center">
            <img
              src="https://res.cloudinary.com/dkxpypiak/image/upload/h_100,c_fit,f_auto/image-1779985068852_v6rnbe"
              alt="KamLife Lifestyle Coach"
              className="h-14 w-auto object-contain"
              style={{ mixBlendMode: "multiply" }}
            />
          </div>
          <div className="flex flex-wrap justify-center sm:justify-end items-center gap-x-4 gap-y-1 text-sm">
            <span>Built for South Africa</span>
            <a href="/privacy" className="underline underline-offset-2 hover:text-foreground transition-colors">Privacy Policy (POPIA)</a>
            <span className="text-muted-foreground/40">© 2026 KamLife</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
