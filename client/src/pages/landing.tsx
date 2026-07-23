import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Mic, Camera, Keyboard, Plus, Minus, CheckCircle,
  RefreshCw, Flame, Dumbbell, Heart,
  ChevronLeft, Phone, Video, Wifi, CheckCheck,
} from "lucide-react";

// ── Brand tokens ──────────────────────────────────────────────────────────────
// KamLife brand — "Orange energy + Deep navy authority" (from theme tokens)
const ACCENT    = "#F97316";   // brand orange (primary)
const NAVY      = "#13224D";   // deep navy (authority) — for section depth
const WA_GREEN  = "#25D366";   // WhatsApp channel green (action buttons only)
const BG        = "#0A0A0C";
const CARD      = "#141416";
const CARD2     = "#1A1A1D";
const BORDER    = "#26262B";

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || "27600000000";
const WA_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C%20I%27d%20like%20to%20start%20coaching`;
const HERO_VIDEO_URL  = import.meta.env.VITE_HERO_VIDEO_URL || "";

// ── Shared primitives ─────────────────────────────────────────────────────────
const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

function WaBtn({ href, children, large }: { href: string; children: React.ReactNode; large?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ background: WA_GREEN }}
      className={`inline-flex items-center gap-2.5 font-bold rounded-full text-white transition-all hover:opacity-90 hover:scale-[1.02] ${large ? "px-8 py-4 text-base" : "px-5 py-2.5 text-sm"}`}>
      <WhatsAppIcon className={large ? "w-5 h-5" : "w-4 h-4"} />
      {children}
    </a>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: ACCENT }}>
      {children}
    </p>
  );
}

// Mini macro progress bar used inside the hero phone mockup (light bubble)
function MacroBar({ label, val, max }: { label: string; val: number; max: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[8.5px] w-9 shrink-0" style={{ color: "#667781" }}>{label}</span>
      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "#E9EDEF" }}>
        <motion.div className="h-1 rounded-full" initial={{ width: "0%" }} animate={{ width: `${Math.min(100, (val / max) * 100)}%` }} transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }} style={{ background: ACCENT }} />
      </div>
      <span className="text-[8.5px] w-7 text-right shrink-0" style={{ color: "#111B21" }}>{val}g</span>
    </div>
  );
}

// WhatsApp typing indicator (three bouncing dots)
function TypingDots() {
  return (
    <div style={{ background: "#FFFFFF", borderRadius: "8px 8px 8px 2px" }} className="px-3 py-2 shadow-sm flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#8696A0", display: "block" }} />
      ))}
    </div>
  );
}

// Animated hero chat — the phone "plays" a full day of coaching on a loop so prospects SEE it:
// Coach K messages → client logs food by VOICE (live waveform) → macros fill → logs a workout →
// streak reply → logs steps → the plan auto-adjusts off the week's weight loss. The chat scrolls
// as it plays (like real WhatsApp) so the whole conversation fits, then holds and loops.
function HeroChat() {
  const [step, setStep] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const holds = [900, 1500, 1500, 850, 1900, 1500, 850, 1900, 1500, 850, 2100, 1100, 850, 1300, 1700, 900, 4000]; // ms per step; step 17 holds, then loops
    let i = 1;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      i = i >= 17 ? 1 : i + 1;
      setStep(i);
      timer = setTimeout(advance, holds[i - 1]);
    };
    timer = setTimeout(advance, holds[0]);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [step]);

  const enter = {
    initial: { opacity: 0, y: 10, scale: 0.95 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
    transition: { duration: 0.35, ease: "easeOut" },
  };
  const IN = { background: "#FFFFFF", borderRadius: "8px 8px 8px 2px" };
  const OUT = { background: "#D9FDD3", borderRadius: "8px 8px 2px 8px" };

  return (
    <>
      <style>{`.hero-chat-scroll::-webkit-scrollbar{display:none}`}</style>
      <div ref={scrollRef} className="hero-chat-scroll px-3 py-3 space-y-2"
        style={{ background: "#EFEAE2", height: "446px", overflowY: "auto", scrollbarWidth: "none" }}>
        <div className="flex justify-center mb-1">
          <span className="text-[9px] px-2.5 py-0.5 rounded-md shadow-sm" style={{ background: "#FFFFFF", color: "#54656F" }}>TODAY</span>
        </div>
        <AnimatePresence>
          {step === 1 && <motion.div key="t1" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 2 && (
            <motion.div key="m1" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-1.5 max-w-[82%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Morning Thabo! You're at 847 cal so far. Lunch idea:</p>
                <p className="text-[11.5px] font-semibold leading-relaxed mt-0.5" style={{ color: "#111B21" }}>Pap + spinach + 2 eggs = 420 cal</p>
                <span className="text-[9px] block text-right mt-0.5" style={{ color: "#667781" }}>09:02</span>
              </div>
            </motion.div>
          )}
          {step >= 3 && (
            <motion.div key="voice" {...enter} className="flex justify-end">
              <div style={OUT} className="px-2.5 py-2 max-w-[82%] shadow-sm flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: WA_GREEN }}>
                  <svg viewBox="0 0 24 24" className="w-3 h-3" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
                </div>
                <div className="flex items-center gap-[2px]" style={{ height: "16px" }}>
                  {[7, 11, 15, 9, 13, 7, 14, 10, 12, 6, 11, 8, 13].map((h, i) => (
                    <motion.span key={i} animate={{ scaleY: [0.35, 1, 0.35] }}
                      transition={{ duration: 0.85, repeat: Infinity, delay: i * 0.06, ease: "easeInOut" }}
                      style={{ display: "block", width: "2px", height: `${h}px`, background: "#25D366", borderRadius: "1px", transformOrigin: "center" }} />
                  ))}
                </div>
                <span className="text-[9px] shrink-0" style={{ color: "#667781" }}>0:04</span>
              </div>
            </motion.div>
          )}
          {step === 4 && <motion.div key="t2" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 5 && (
            <motion.div key="m2" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-2 max-w-[88%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Even better — pilchards = 35g protein 💪 Logged 420 cal.</p>
                <div className="mt-2 space-y-1">
                  <MacroBar label="Protein" val={98} max={140} />
                  <MacroBar label="Carbs" val={142} max={220} />
                  <MacroBar label="Fat" val={41} max={70} />
                </div>
                <span className="text-[9px] block text-right mt-1" style={{ color: "#667781" }}>09:15</span>
              </div>
            </motion.div>
          )}
          {step >= 6 && (
            <motion.div key="p1" {...enter} className="flex justify-end">
              <div style={OUT} className="p-1 shadow-sm">
                <img src="/demo/food.jpg" alt="Logged meal" loading="lazy" style={{ width: "150px", height: "112px", borderRadius: "6px", objectFit: "cover", display: "block" }} />
                <span className="flex items-center justify-end gap-1 mt-0.5 pr-0.5">
                  <span className="text-[9px]" style={{ color: "#667781" }}>13:12</span>
                  <CheckCheck className="w-3 h-3" style={{ color: "#53BDEB" }} />
                </span>
              </div>
            </motion.div>
          )}
          {step === 7 && <motion.div key="t3" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 8 && (
            <motion.div key="m3" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-1.5 max-w-[90%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Grilled pork chop, morogo &amp; a bulgur salad — ~610 cal, 48g protein. Proper balanced plate 💪 Logged.</p>
                <span className="text-[9px] block text-right mt-0.5" style={{ color: "#667781" }}>13:12</span>
              </div>
            </motion.div>
          )}
          {step >= 9 && (
            <motion.div key="p2" {...enter} className="flex justify-end">
              <div style={OUT} className="p-1 shadow-sm">
                <img src="/demo/gym.jpg" alt="Gym machine" loading="lazy" style={{ width: "150px", height: "112px", borderRadius: "6px", objectFit: "cover", display: "block" }} />
                <span className="flex items-center justify-end gap-1 mt-0.5 pr-0.5">
                  <span className="text-[9px]" style={{ color: "#667781" }}>17:32</span>
                  <CheckCheck className="w-3 h-3" style={{ color: "#53BDEB" }} />
                </span>
              </div>
            </motion.div>
          )}
          {step === 10 && <motion.div key="t4" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 11 && (
            <motion.div key="m4" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-1.5 max-w-[90%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>That's the shoulder press 💪 Grip level with your shoulders, press up smooth — don't lock out hard at the top. 3 × 10.</p>
                <span className="text-[9px] block text-right mt-0.5" style={{ color: "#667781" }}>17:33</span>
              </div>
            </motion.div>
          )}
          {step >= 12 && (
            <motion.div key="m5" {...enter} className="flex justify-end">
              <div style={OUT} className="px-2.5 py-1.5 max-w-[80%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Done 💪</p>
                <span className="flex items-center justify-end gap-1 mt-0.5">
                  <span className="text-[9px]" style={{ color: "#667781" }}>18:05</span>
                  <CheckCheck className="w-3 h-3" style={{ color: "#53BDEB" }} />
                </span>
              </div>
            </motion.div>
          )}
          {step === 13 && <motion.div key="t5" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 14 && (
            <motion.div key="m6" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-1.5 max-w-[86%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Logged 🔥 that's <span className="font-semibold">4 sessions</span> this week. You're moving.</p>
                <span className="text-[9px] block text-right mt-0.5" style={{ color: "#667781" }}>18:06</span>
              </div>
            </motion.div>
          )}
          {step >= 15 && (
            <motion.div key="p3" {...enter} className="flex justify-end">
              <div style={OUT} className="p-1 shadow-sm">
                <img src="/demo/body.jpg" alt="Progress photo" loading="lazy" style={{ width: "118px", height: "158px", borderRadius: "6px", objectFit: "cover", display: "block" }} />
                <span className="flex items-center justify-end gap-1 mt-0.5 pr-0.5">
                  <span className="text-[9px]" style={{ color: "#667781" }}>18:07</span>
                  <CheckCheck className="w-3 h-3" style={{ color: "#53BDEB" }} />
                </span>
              </div>
            </motion.div>
          )}
          {step === 16 && <motion.div key="t6" {...enter} className="flex justify-start"><TypingDots /></motion.div>}
          {step >= 17 && (
            <motion.div key="m7" {...enter} className="flex justify-start">
              <div style={IN} className="px-2.5 py-2 max-w-[90%] shadow-sm">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "#111B21" }}>Now <span className="font-semibold">that's</span> progress 🔥 Core's tightening up — abs starting to show. You're down <span className="font-semibold">1.2kg this week</span>, 12 days straight. Bumping your target to 2,250 cal to keep it moving.</p>
                <span className="text-[9px] block text-right mt-1" style={{ color: "#667781" }}>18:07</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

// "Sound familiar?" archetypes — honest pain-points the target market recognises, NOT
// testimonials. No fabricated results; real proof goes here only once the cohort delivers it.
const PERSONAS = [
  { initials: "TM", name: "The one who's quit before", city: "Tried the gym 4 times", avatarBg: "#162416", avatarText: ACCENT, quote: "I always start strong and quit by month 2. I don't need more information — I need someone to keep me going.", tags: ["QUIT BEFORE", "NO ACCOUNTABILITY", "BUSY LIFE"] },
  { initials: "NP", name: "The one who hates meal prep", city: "Lives on pap and eggs", avatarBg: "#161628", avatarText: "#6B8AFF", quote: "I hate cooking and I don't have time. I need a plan built around real food I actually eat — not chicken and broccoli.", tags: ["HATES MEAL PREP", "NIGHT SHIFT", "SIMPLE FOOD"] },
  { initials: "KM", name: "The one managing a condition", city: "Diabetic, on a budget", avatarBg: "#281616", avatarText: "#FF6B35", quote: "Every plan I find ignores my meds and my budget. I need one built around my real life, not a generic diet.", tags: ["DIABETIC", "BUDGET EATING", "OVER 40"] },
  { initials: "SN", name: "The one who wants size", city: "Skinny their whole life", avatarBg: "#162818", avatarText: "#22c55e", quote: "I eat rice, eggs and pilchards. I want to put on real muscle without a fancy gym or expensive supplements.", tags: ["HARDGAINER", "MUSCLE GAIN", "STUDENT"] },
  { initials: "LZ", name: "The one who lost herself", city: "New baby, no time", avatarBg: "#221622", avatarText: "#d946ef", quote: "Since the baby I've had no time and no energy. I don't want a crash diet — I want daily support that fits my life.", tags: ["POST-PREGNANCY", "NO TIME", "AT HOME"] },
  { initials: "BK", name: "The one with no routine", city: "Night shift, no gym", avatarBg: "#161e28", avatarText: "#06b6d4", quote: "My eating is all over the place with shift work. I need someone to make it simple and keep me honest.", tags: ["NIGHT SHIFT", "NO GYM", "IRREGULAR HOURS"] },
];

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const { data: stats } = useQuery({
    queryKey: ["/api/public/stats"],
    queryFn: async () => {
      const res = await fetch("/api/public/stats");
      if (!res.ok) return null;
      return res.json() as Promise<{ activeClients: number; workoutsLogged: number; heroVideoUrl?: string }>;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Runtime video URL (from server env) takes priority over the build-time VITE_ var,
  // so the hero video works the moment HERO_VIDEO_URL is set in Railway — no rebuild needed.
  const heroVideo = stats?.heroVideoUrl || HERO_VIDEO_URL;

  return (
    <div style={{ background: BG, color: "#fff" }} className="min-h-screen overflow-x-hidden font-sans">

      {/* ── NAV ── */}
      <nav style={{ background: "rgba(11,11,11,0.97)", borderBottom: `1px solid ${BORDER}` }}
        className="sticky top-0 z-50 px-6 lg:px-16 py-4 flex items-center justify-between">
        <span className="text-2xl font-black tracking-tight select-none">
          KAM<span style={{ color: ACCENT }}>LIFE</span>
        </span>
        <div className="hidden md:flex items-center gap-8">
          {[["How It Works", "#how-it-works"], ["Features", "#features"], ["Pricing", "#pricing"], ["FAQ", "#faq"]].map(([label, href]) => (
            <a key={label} href={href} className="text-sm text-white/50 hover:text-white transition-colors font-medium">
              {label}
            </a>
          ))}
        </div>
        <WaBtn href={WA_LINK}>Start free on WhatsApp</WaBtn>
      </nav>

      {/* ── HERO ── */}
      <section className="relative min-h-screen flex items-center px-6 lg:px-16 overflow-hidden">
        {heroVideo ? (
          <video className="absolute inset-0 w-full h-full object-cover"
            src={heroVideo} autoPlay muted loop playsInline preload="metadata" />
        ) : (
          <>
            {/* Richer ambient background for when no hero video is set (set HERO_VIDEO_URL in Railway to enable video) */}
            <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 70% 65% at 12% 42%, rgba(249,115,22,0.14) 0%, transparent 60%)" }} />
            <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 65% 65% at 88% 82%, rgba(19,34,77,0.45) 0%, transparent 62%)" }} />
            <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
          </>
        )}
        {heroVideo && <div className="absolute inset-0 bg-black/55" />}
        <div className="absolute bottom-0 left-0 right-0 h-48"
          style={{ background: `linear-gradient(to top, ${BG}, transparent)` }} />

        <div className="relative z-10 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center py-24 lg:py-0 min-h-screen">
          {/* Left: text */}
          <motion.div initial={{ opacity: 0, y: 36 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.65 }}>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/10 text-xs font-semibold text-white/60 mb-6"
              style={{ background: "rgba(255,255,255,0.04)" }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: ACCENT }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: ACCENT }} />
              </span>
              Now accepting South African clients
            </div>

            <p className="text-white/45 text-base sm:text-lg font-medium mb-4 leading-snug">
              That belly you've been trying to lose for years?
            </p>

            <h1 className="text-[clamp(40px,6.6vw,88px)] font-black uppercase leading-[0.92] tracking-tight mb-8">
              <span className="block text-white">YOU'RE NOT LAZY.</span>
              <span className="block" style={{ color: "rgba(255,255,255,0.55)" }}>YOU JUST NEVER HAD</span>
              <span className="block" style={{ color: ACCENT }}>A COACH.</span>
            </h1>

            <p className="text-lg text-white/60 max-w-lg leading-relaxed mb-4">
              Your own coach, on WhatsApp — checking in every day, so this time you actually finish. Knows pap, pilchards and braai by name. No gym. Nothing to download.
            </p>

            <p className="text-base text-white/40 max-w-lg mb-10">
              One personal-trainer session costs about R500. Coach K is <span className="text-white font-semibold">R199 for the whole month</span> — less than R7 a day.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 mb-3">
              <WaBtn href={WA_LINK} large>Start free on WhatsApp</WaBtn>
              <a href="#how-it-works"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-full text-base font-semibold text-white/60 border border-white/12 hover:border-white/25 hover:text-white transition-all">
                See how it works
              </a>
            </div>

            <p className="text-sm text-white/35 mb-7">
              The button opens WhatsApp — say "hi" and Coach K takes it from there. No app, no forms.
            </p>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/30">
              <span>7 days free</span><span>·</span>
              <span>R199/month</span><span>·</span>
              <span>No app needed</span><span>·</span>
              <span>Cancel on WhatsApp</span>
            </div>

            {stats?.activeClients && stats.activeClients > 3 && (
              <p className="text-xs text-white/20 mt-3">
                {stats.activeClients} active clients · {(stats.workoutsLogged || 0).toLocaleString()} workouts logged
              </p>
            )}
          </motion.div>

          {/* Right: WhatsApp chat mockup */}
          <motion.div initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="hidden lg:flex justify-center items-center relative">
            {/* Soft glow panel so the phone pops off the dark hero (Pelicart insight #3 — visual separation) */}
            <div className="absolute pointer-events-none" style={{ left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: "520px", height: "740px", background: "radial-gradient(ellipse 55% 50% at 50% 45%, rgba(249,115,22,0.24) 0%, rgba(19,34,77,0.34) 46%, transparent 72%)", filter: "blur(44px)", zIndex: 0 }} />

            {/* ── Phone device — scaled up for a big, premium presence (Pelicart-style large device) ── */}
            <div className="relative" style={{ width: "302px", zIndex: 10, transform: "scale(1.1)", transformOrigin: "center" }}>
              {/* Floating stats card — top right (bigger numbers = proof, Pelicart insight #4) */}
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: "15px", position: "absolute", top: "16px", right: "-64px", zIndex: 30 }}
                className="px-3.5 py-2.5 shadow-2xl">
                <div className="text-[9px] font-bold uppercase tracking-wider text-white/35 mb-0.5">Today's intake</div>
                <div className="text-xl font-black text-white leading-none">1,267<span className="text-[11px] font-medium text-white/35"> / 2,200</span></div>
                <div className="rounded-full mt-1.5" style={{ width: "108px", height: "5px", background: "#222" }}>
                  <div className="h-full rounded-full" style={{ width: "57%", background: ACCENT }} />
                </div>
                <div className="text-[9px] text-white/40 mt-1">933 cal left today</div>
              </div>

              {/* Floating progress card — shows the OUTPUT of coaching, not just the process (Pelicart insight #2) */}
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: "15px", position: "absolute", bottom: "20px", left: "-64px", zIndex: 30 }}
                className="px-3.5 py-2.5 shadow-2xl">
                <div className="text-[9px] font-bold uppercase tracking-wider text-white/35 mb-0.5">This week</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-xl font-black leading-none" style={{ color: ACCENT }}>−1.2</span>
                  <span className="text-[11px] font-medium text-white/45">kg</span>
                </div>
                <div className="text-[9px] text-white/40 mt-1">4/5 workouts · 12-day streak 🔥</div>
              </div>

              {/* Side buttons */}
              <div className="absolute" style={{ left: "-2.5px", top: "96px", width: "3px", height: "22px", borderRadius: "2px", background: "#3a3a40" }} />
              <div className="absolute" style={{ left: "-2.5px", top: "140px", width: "3px", height: "44px", borderRadius: "2px", background: "#3a3a40" }} />
              <div className="absolute" style={{ left: "-2.5px", top: "196px", width: "3px", height: "44px", borderRadius: "2px", background: "#3a3a40" }} />
              <div className="absolute" style={{ right: "-2.5px", top: "160px", width: "3px", height: "64px", borderRadius: "2px", background: "#3a3a40" }} />

              {/* Titanium frame */}
              <div style={{ background: "linear-gradient(145deg, #34343a 0%, #18181b 55%, #28282d 100%)", borderRadius: "46px", padding: "11px" }}
                className="shadow-2xl">
                {/* Screen */}
                <div className="relative overflow-hidden" style={{ background: "#FFFFFF", borderRadius: "35px" }}>

                  {/* Dynamic Island */}
                  <div className="absolute left-1/2 -translate-x-1/2 z-20" style={{ top: "9px", width: "94px", height: "27px", background: "#000", borderRadius: "16px" }} />

                  {/* iOS status bar (light) */}
                  <div className="relative flex items-center justify-between px-6 pt-3 pb-1.5" style={{ background: "#FFFFFF" }}>
                    <span className="text-[12px] font-semibold tracking-tight" style={{ color: "#111B21" }}>9:41</span>
                    <div className="flex items-center gap-1.5">
                      <div className="flex items-end gap-[2px]" style={{ height: "11px" }}>
                        {[5, 7, 9, 11].map((h, i) => (
                          <div key={i} style={{ width: "3px", height: `${h}px`, background: "#111B21", borderRadius: "1px" }} />
                        ))}
                      </div>
                      <Wifi className="w-3.5 h-3.5" strokeWidth={2.5} style={{ color: "#111B21" }} />
                      <div className="flex items-center" style={{ gap: "1px" }}>
                        <div style={{ width: "21px", height: "11px", borderRadius: "3px", border: "1px solid rgba(17,27,33,0.5)", padding: "1.5px" }}>
                          <div style={{ width: "78%", height: "100%", background: "#111B21", borderRadius: "1px" }} />
                        </div>
                        <div style={{ width: "1.5px", height: "4px", background: "rgba(17,27,33,0.5)", borderRadius: "0 1px 1px 0" }} />
                      </div>
                    </div>
                  </div>

                  {/* WhatsApp chat header (light) */}
                  <div className="flex items-center gap-2 px-3 py-2" style={{ background: "#FFFFFF", borderBottom: "1px solid #E9EDEF" }}>
                    <ChevronLeft className="w-5 h-5 shrink-0" style={{ color: "#54656F" }} />
                    <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-sm shrink-0"
                      style={{ background: ACCENT, color: "#fff" }}>K</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold leading-tight" style={{ color: "#111B21" }}>Coach K</div>
                      <div className="text-[10px] leading-tight" style={{ color: "#25D366" }}>online</div>
                    </div>
                    <Video className="w-[18px] h-[18px] shrink-0" style={{ color: "#54656F" }} />
                    <Phone className="w-4 h-4 shrink-0" style={{ color: "#54656F" }} />
                  </div>

                  {/* Chat body — animated, "plays" a live voice-logging conversation on a loop */}
                  <HeroChat />

                  {/* Input bar (light) */}
                  <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: "#F0F2F5" }}>
                    <div className="flex-1 flex items-center gap-2 rounded-full px-3 py-1.5" style={{ background: "#FFFFFF" }}>
                      <Plus className="w-3.5 h-3.5 shrink-0" style={{ color: "#54656F" }} />
                      <span className="text-[11px]" style={{ color: "#8696A0" }}>Message</span>
                      <Camera className="w-3.5 h-3.5 ml-auto shrink-0" style={{ color: "#54656F" }} />
                    </div>
                    <motion.div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: WA_GREEN }}
                      animate={{ scale: [1, 1.12, 1] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
                      <Mic className="w-4 h-4 text-white" />
                    </motion.div>
                  </div>

                  {/* Home indicator */}
                  <div className="flex justify-center pb-2 pt-1" style={{ background: "#F0F2F5" }}>
                    <div style={{ width: "112px", height: "4px", borderRadius: "4px", background: "rgba(17,27,33,0.35)" }} />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── SCROLLING MARQUEE ── */}
      <div style={{ background: "#0D0D0D", borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, overflow: "hidden" }} className="py-3">
        <style>{`@keyframes marquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }`}</style>
        <div className="flex" style={{ animation: "marquee 32s linear infinite", whiteSpace: "nowrap" }}>
          {[0, 1].map(ri => (
            <div key={ri} className="flex shrink-0 items-center">
              {["No contracts", "Built for South Africa", "100% on WhatsApp", "Real SA food — pap, wors, pilchards", "R199/month", "7-day money-back", "No app to download", "Cancel anytime"].map(item => (
                <span key={item} className="inline-flex items-center gap-3 px-6 text-sm font-semibold text-white/30">
                  <span className="w-1 h-1 rounded-full shrink-0" style={{ background: ACCENT }} />
                  {item}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── RESULTS ── */}
      <section style={{ background: BG, borderBottom: `1px solid ${BORDER}` }} className="py-14 px-6 lg:px-16">
        <div className="max-w-6xl mx-auto">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-center mb-4" style={{ color: ACCENT }}>Founding Members — Now Open</p>
          <h2 className="text-[clamp(26px,4.4vw,42px)] font-black uppercase tracking-tight leading-[0.95] text-center max-w-3xl mx-auto mb-4">
            No fake before-and-afters here.<br /><span style={{ color: "rgba(255,255,255,0.4)" }}>Just your own results, coming.</span>
          </h2>
          <p className="text-white/45 text-base text-center max-w-xl mx-auto mb-8">
            We're taking on our first members right now. Real daily coaching, real SA food, and honest results we'll only ever show when they're real. Be one of the first — and help shape the coach that finally works.
          </p>
          <div className="flex justify-center">
            <WaBtn href={WA_LINK} large>Start free on WhatsApp</WaBtn>
          </div>
        </div>
      </section>

      {/* ── STATS BAR ── */}
      <div style={{ borderBottom: `1px solid ${BORDER}`, background: NAVY }} className="py-8 px-6">
        <div className="max-w-4xl mx-auto flex flex-wrap justify-center gap-x-14 gap-y-5">
          {[
            { v: "R6.63",     l: "Per day" },
            { v: "7 days",    l: "Free trial" },
            { v: "3 min",     l: "Setup time" },
            { v: "WhatsApp",  l: "No app needed" },
          ].map(s => (
            <div key={s.l} className="text-center">
              <div className="text-3xl font-black" style={{ color: ACCENT }}>{s.v}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-white/30 mt-1">{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── GYM OR NO GYM ── */}
      <section className="py-28 px-6 lg:px-16">
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }}>
            <h2 className="text-[clamp(42px,8vw,96px)] font-black uppercase leading-[0.9] tracking-tight mb-5">
              <span className="block text-white">GYM OR NO GYM.</span>
              <span className="block" style={{ color: "rgba(255,255,255,0.2)" }}>PERFECT DIET OR REAL LIFE.</span>
              <span className="block" style={{ color: ACCENT }}>JUST GO.</span>
            </h2>
            <p className="text-white/45 text-lg max-w-lg mb-14">
              The fitness industry makes this complicated so they can sell you supplements.
              We make things simple so you actually stick with it.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
            {[
              { Icon: Dumbbell,  color: ACCENT,      bg: "rgba(249,115,22,0.10)",    title: "Gym or Home — Both Work.", body: "Got a gym membership? Great. Don't have one? Also great. Coach K builds your programme for where you actually train." },
              { Icon: Flame,     color: "#FF6B35", bg: "rgba(255,107,53,0.10)",   title: "No Perfect Eating.",       body: "Ate a kota? Had a braai? Ate late? Coach K adjusts — doesn't judge. Perfect diets last 3 days. Real-life plans last forever." },
              { Icon: RefreshCw, color: "#6B8AFF", bg: "rgba(107,138,255,0.10)", title: "Miss a Day? Just Come Back.", body: "Life happens. Loadshedding, deadlines, sick kids. Missed Monday doesn't mean the week is ruined. Coach K meets you where you are." },
            ].map(item => (
              <div key={item.title} style={{ background: CARD, border: `1px solid ${BORDER}` }}
                className="rounded-2xl p-7 hover:border-white/15 transition-all">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5" style={{ background: item.bg }}>
                  <item.Icon className="w-6 h-6" style={{ color: item.color }} />
                </div>
                <h3 className="font-bold text-lg text-white mb-2">{item.title}</h3>
                <p className="text-white/45 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>

          <WaBtn href={WA_LINK} large>Start free on WhatsApp</WaBtn>
        </div>
      </section>

      {/* ── PERSONAS ── */}
      <section className="py-28 px-6 lg:px-16" style={{ background: NAVY }}>
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }} className="mb-14">
            <Label>Sound Familiar?</Label>
            <h2 className="text-[clamp(36px,7vw,86px)] font-black uppercase tracking-tight leading-[0.9] mb-6">
              <span className="block text-white">IF YOU'VE TRIED BEFORE</span>
              <span className="block" style={{ color: "rgba(255,255,255,0.2)" }}>AND QUIT —</span>
              <span className="block" style={{ color: ACCENT }}>READ THIS.</span>
            </h2>
            <p className="text-white/45 text-lg max-w-xl">
              If any of this sounds like you, you're exactly who Coach K is built for. Not gym rats. Not influencers. Real South African life.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PERSONAS.map(p => (
              <motion.div key={p.name} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ duration: 0.4 }}
                style={{ background: CARD, border: `1px solid ${BORDER}` }}
                className="rounded-2xl p-6 hover:border-white/15 transition-all">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-black text-sm shrink-0"
                    style={{ background: p.avatarBg, color: p.avatarText }}>
                    {p.initials}
                  </div>
                  <div>
                    <div className="font-bold text-white text-sm">{p.name}</div>
                    <div className="text-xs text-white/30">{p.city}</div>
                  </div>
                </div>
                <p className="text-white/55 text-sm leading-relaxed mb-4">"{p.quote}"</p>
                <div className="flex flex-wrap gap-2">
                  {p.tags.map(t => (
                    <span key={t} className="px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.35)" }}>
                      {t}
                    </span>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── GOALS ── */}
      <section id="features" className="py-28 px-6 lg:px-16">
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }} className="mb-14">
            <Label>Your Goal</Label>
            <h2 className="text-[clamp(36px,7vw,86px)] font-black uppercase tracking-tight leading-[0.9]">
              <span style={{ color: "rgba(255,255,255,0.18)" }}>WHAT'S YOUR </span>
              <span className="text-white">GOAL?</span>
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {([
              {
                badge: "BODY RECOMP", badgeColor: ACCENT, badgeText: "#000",
                Icon: RefreshCw, iconColor: ACCENT, popular: true,
                img: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=700&auto=format&fit=crop&q=75",
                heading: "Lose Fat. Build Muscle. Simultaneously.",
                body: "The holy grail. Coach K designs your training and nutrition to burn fat while adding lean muscle. No \"bulk then cut\" — just steady progress.",
                tags: ["Optimal for 18–40", "15–25% body fat"],
              },
              {
                badge: "LOSE FAT", badgeColor: "rgba(34,197,94,0.18)", badgeText: "#22c55e",
                Icon: Flame, iconColor: "#22c55e", popular: false,
                img: "https://images.unsplash.com/photo-1518611012118-696072aa579a?w=700&auto=format&fit=crop&q=75",
                heading: "Drop the Belly. For Good.",
                body: "Been carrying the same weight for years? Coach K sets your calorie target around real SA food — pap, pilchards, braai. Weekly weigh-ins auto-adjust your plan. No crash diet. Just the belly shrinking, week by week.",
                tags: ["All ages", "Weekly plan adjustments"],
              },
              {
                badge: "BUILD MUSCLE", badgeColor: "rgba(107,138,255,0.18)", badgeText: "#6B8AFF",
                Icon: Dumbbell, iconColor: "#6B8AFF", popular: false,
                img: "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=700&auto=format&fit=crop&q=75",
                heading: "Skinny? Want Size?",
                body: "Progressive overload training paired with a surplus meal plan built around South African food. A plan that adds real muscle, not just weight.",
                tags: ["Progressive overload", "Surplus meal plan"],
              },
            ] as const).map(g => (
              <div key={g.badge}
                style={{ background: CARD, border: `1px solid ${g.popular ? ACCENT + "50" : BORDER}` }}
                className="rounded-2xl overflow-hidden relative group hover:border-white/20 transition-all">
                {g.popular && (
                  <div className="absolute top-4 right-4 z-20 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider"
                    style={{ background: ACCENT, color: "#000" }}>
                    MOST POPULAR
                  </div>
                )}
                <div className="relative h-44 overflow-hidden">
                  <img src={g.img} alt={g.heading}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
                  <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(20,20,20,1) 0%, rgba(20,20,20,0.3) 60%, transparent 100%)" }} />
                </div>
                <div className="p-6">
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-widest mb-4"
                    style={{ background: g.badgeColor, color: g.badgeText }}>
                    <g.Icon className="w-3 h-3" />
                    {g.badge}
                  </div>
                  <h3 className="text-xl font-black text-white mb-2 leading-tight">{g.heading}</h3>
                  <p className="text-white/45 text-sm leading-relaxed mb-4">{g.body}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {g.tags.map(t => (
                      <span key={t} className="flex items-center gap-1 text-xs text-white/35">
                        <CheckCircle className="w-3 h-3 text-white/20" />{t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Wide "Get Healthy" card */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}` }}
            className="rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-2 group hover:border-white/15 transition-all">
            <div className="relative h-64 md:h-auto min-h-[220px] overflow-hidden">
              <img src="https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=900&auto=format&fit=crop&q=75"
                alt="Get Healthy"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
              <div className="absolute inset-0" style={{ background: "rgba(20,20,20,0.25)" }} />
            </div>
            <div className="p-8 flex flex-col justify-center">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-widest mb-4 w-fit"
                style={{ background: "rgba(239,68,68,0.18)", color: "#ef4444" }}>
                <Heart className="w-3 h-3" />
                GET HEALTHY
              </div>
              <h3 className="text-2xl font-black text-white mb-3 leading-tight">
                Diabetes? Hypertension? Just Want to Feel Better?
              </h3>
              <p className="text-white/45 text-sm leading-relaxed mb-5">
                Safe, gradual adjustments to your diet and movement. No extreme anything. Your medical conditions are factored into every recommendation. This is about longevity, not a 30-day challenge.
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {["Diabetes-friendly", "Blood pressure-aware", "Injury-safe", "All ages welcome"].map(t => (
                  <span key={t} className="flex items-center gap-1 text-xs text-white/35">
                    <CheckCircle className="w-3 h-3 text-white/20" />{t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOD LOGGING ── */}
      <section className="py-28 px-6 lg:px-16" style={{ background: NAVY }}>
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }} className="mb-14">
            <Label>Food Logging</Label>
            <h2 className="text-[clamp(32px,6.5vw,80px)] font-black uppercase tracking-tight leading-[0.9] mb-5">
              <span style={{ color: ACCENT }}>LOG FOOD</span> THE WAY YOU<br />
              ACTUALLY <span style={{ color: "rgba(255,255,255,0.2)" }}>COMMUNICATE.</span>
            </h2>
            <p className="text-white/45 text-lg max-w-lg">
              No searching databases. No weighing everything. Send it how you'd tell a friend.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            {/* Method cards */}
            <div className="space-y-3">
              {[
                { Icon: Mic,      color: ACCENT,      bg: "rgba(249,115,22,0.10)",    title: "Voice Note", desc: '"I had two eggs and toast for breakfast" — Coach K logs it automatically with calories and protein.' },
                { Icon: Camera,   color: "#22c55e", bg: "rgba(34,197,94,0.10)",    title: "Photo",      desc: "Snap your plate. Coach K identifies the food and estimates portions — even pap, kota, and braai meat." },
                { Icon: Keyboard, color: "#6B8AFF", bg: "rgba(107,138,255,0.10)", title: "Text",       desc: 'Type naturally. "Chicken breyani for lunch" — understood and logged in seconds.' },
              ].map(m => (
                <div key={m.title} style={{ background: CARD, border: `1px solid ${BORDER}` }}
                  className="rounded-xl p-5 flex gap-4 hover:border-white/15 transition-all">
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: m.bg }}>
                    <m.Icon className="w-5 h-5" style={{ color: m.color }} />
                  </div>
                  <div>
                    <div className="font-bold text-white mb-1">{m.title}</div>
                    <p className="text-white/45 text-sm leading-relaxed">{m.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Food log widget */}
            <div style={{ background: CARD, border: `1px solid ${BORDER}` }} className="rounded-2xl p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="font-bold text-white">Today's Food Log</span>
                <span className="text-xs text-white/25">
                  {new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}
                </span>
              </div>
              <div className="space-y-2.5">
                {[
                  { icon: "🍳", name: "2 Eggs + Toast",      time: "Breakfast · 07:30", cal: "342 cal", prot: "22g protein" },
                  { icon: "🍗", name: "Pap + Chicken Stew",  time: "Lunch · 13:15",     cal: "520 cal", prot: "38g protein" },
                  { icon: "🥩", name: "Boerewors roll",      time: "Dinner · 18:45",    cal: "480 cal", prot: "28g protein" },
                ].map((item, i) => (
                  <div key={i} style={{ background: CARD2, border: `1px solid ${BORDER}` }}
                    className="rounded-xl p-3.5 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg shrink-0"
                      style={{ background: "#222" }}>{item.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-white truncate">{item.name}</div>
                      <div className="text-xs text-white/30">{item.time}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-white">{item.cal}</div>
                      <div className="text-xs text-white/30">{item.prot}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: `1px solid ${BORDER}` }} className="mt-5 pt-4">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-white/45">Today's total</span>
                  <span className="font-bold text-white">1,342 / 2,200 cal</span>
                </div>
                <div className="w-full h-2 rounded-full" style={{ background: "#222" }}>
                  <div className="h-2 rounded-full" style={{ width: "61%", background: ACCENT }} />
                </div>
                <div className="flex justify-between text-xs text-white/25 mt-1.5">
                  <span>858 cal remaining</span>
                  <span>61%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="py-28 px-6 lg:px-16">
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }} className="mb-14">
            <Label>How It Works</Label>
            <h2 className="text-[clamp(36px,7vw,86px)] font-black uppercase tracking-tight leading-[0.9]">
              <span className="block text-white">THREE STEPS.</span>
              <span className="block" style={{ color: ACCENT }}>DONE.</span>
            </h2>
          </motion.div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { n: "01", title: "WhatsApp Coach K",        body: "Send a message to start. Coach K asks about your goal, body, lifestyle, and budget. No forms. No downloads. Done in a few minutes." },
              { n: "02", title: "Get your programme",      body: "Personalised workout plan — gym, home, or dumbbells. SA meal plan at real SA prices. Everything drops on Day 1." },
              { n: "03", title: "Coach K keeps you going", body: "Daily morning check-ins. Evening nudges. Water reminders. Weekly progress reports. Automatic accountability every single day." },
            ].map(item => (
              <div key={item.n} style={{ background: CARD, border: `1px solid ${BORDER}` }}
                className="rounded-2xl p-8 hover:border-white/15 transition-all">
                <div className="text-7xl font-black mb-4 leading-none" style={{ color: ACCENT, opacity: 0.25 }}>{item.n}</div>
                <h3 className="text-xl font-black text-white mb-3">{item.title}</h3>
                <p className="text-white/45 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" className="py-28 px-6 lg:px-16" style={{ background: NAVY }}>
        <div className="max-w-6xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }} className="text-center mb-14">
            <Label>Pricing</Label>
            <h2 className="text-[clamp(36px,7vw,86px)] font-black uppercase tracking-tight leading-[0.9]">
              <span className="text-white">ONE PLAN. </span>
              <span style={{ color: ACCENT }}>EVERYTHING.</span>
            </h2>
            <p className="text-white/35 mt-4 text-lg">All goals. All fitness levels. WhatsApp only. Cancel anytime.</p>
          </motion.div>

          <div style={{ background: CARD, border: `1px solid ${BORDER}` }}
            className="rounded-3xl overflow-hidden grid grid-cols-1 lg:grid-cols-2">
            {/* Left: photo + comparison card */}
            <div className="relative min-h-[360px] overflow-hidden">
              <img
                src="https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=900&auto=format&fit=crop&q=75"
                alt="Coaching"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, rgba(11,11,11,0.7) 0%, rgba(11,11,11,0.2) 100%)" }} />
              {/* Comparison card overlay */}
              <div style={{ background: "rgba(11,11,11,0.92)", border: `1px solid ${BORDER}`, backdropFilter: "blur(12px)", borderRadius: "16px" }}
                className="absolute bottom-6 left-6 right-6 p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-white/30 mb-3">vs. a personal trainer</div>
                <div className="flex items-center justify-between">
                  <div className="text-center">
                    <div className="text-2xl font-black text-white/20 line-through">R500</div>
                    <div className="text-[10px] text-white/25 uppercase tracking-wider mt-1">One trainer session</div>
                  </div>
                  <div className="text-white/20 text-2xl font-black">→</div>
                  <div className="text-center">
                    <div className="text-4xl font-black" style={{ color: ACCENT }}>R199</div>
                    <div className="text-[10px] text-white/25 uppercase tracking-wider mt-1">A whole month · daily</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: features + CTA */}
            <div className="p-8 lg:p-10 flex flex-col justify-between relative">
              <div className="absolute top-0 left-0 right-0 h-[2px] hidden lg:block" style={{ background: "transparent" }} />
              <div>
                <div className="flex items-center justify-between mb-6">
                  <span className="text-sm font-black uppercase tracking-[0.2em]" style={{ color: ACCENT }}>Coach K</span>
                  <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider"
                    style={{ background: "rgba(249,115,22,0.12)", color: ACCENT }}>
                    Founding Member Price
                  </span>
                </div>
                <div className="mb-1">
                  <span className="text-6xl font-black text-white">R199</span>
                  <span className="text-white/35 text-lg ml-2">/month</span>
                </div>
                <p className="text-white/25 text-sm mb-8">R6.63/day — less than a taxi fare. Cancel anytime by WhatsApp.</p>
                <ul className="space-y-3 mb-8">
                  {[
                    "Personalised 2–5 day programme — gym, home, or dumbbells",
                    "Photo food logging — snap your plate, feedback in 10 seconds",
                    "Exact grocery list — Shoprite, Boxer & Pick n Pay, your budget",
                    "Daily accountability — Coach K notices when you go quiet",
                    "Weekly Sunday progress report — steps, weight, food, verdict",
                    "All goals: fat loss · muscle gain · recomp · health",
                    "Braai, KFC, kota, Nando's — real SA eating, fully coached",
                    "7-day free trial — programme sent on Day 1",
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2.5 text-sm">
                      <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: ACCENT }} />
                      <span className="text-white/65">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <WaBtn href={WA_LINK} large>Start Your Free Trial on WhatsApp</WaBtn>
                <p className="text-xs text-white/20 mt-4">7 days free · Then R199/month · Cancel anytime on WhatsApp</p>
                <p className="text-sm text-white/25 mt-3">Refer a friend — you both get one month free</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── TRUST: what Coach K can / cannot access ── */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <Label>Privacy &amp; Safety</Label>
            <h2 className="text-4xl font-black uppercase tracking-tight">WHAT COACH K <span style={{ color: ACCENT }}>KNOWS.</span></h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div style={{ background: CARD, border: `1px solid ${BORDER}` }} className="rounded-2xl p-6">
              <p className="text-sm font-bold mb-4 text-white/60 uppercase tracking-widest">What Coach K can see</p>
              <ul className="space-y-2.5">
                {[
                  "Your name and WhatsApp number",
                  "Your fitness goal and training preference",
                  "Food logs you send (text or photo)",
                  "Steps, water, and workout completions you log",
                  "Your weekly grocery budget",
                  "Body weight you share voluntarily",
                ].map(item => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-white/55">
                    <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-green-400" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ background: CARD, border: `1px solid ${BORDER}` }} className="rounded-2xl p-6">
              <p className="text-sm font-bold mb-4 text-white/60 uppercase tracking-widest">What Coach K cannot see</p>
              <ul className="space-y-2.5">
                {[
                  "Your bank account or card details",
                  "Your payment information (PayFast handles that)",
                  "Your WhatsApp contacts or call history",
                  "Any data from other apps on your phone",
                  "Your location",
                  "Anything you don't explicitly send to Coach K",
                ].map(item => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <span className="w-4 h-4 shrink-0 mt-0.5 flex items-center justify-center rounded-full bg-white/8 text-white/30 text-xs font-bold">✕</span>
                    <span className="line-through text-white/30">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-center text-xs text-white/20 mt-5">
            Your data is governed by POPIA. <a href="/privacy" className="underline text-white/30 hover:text-white/50">Full privacy policy →</a>
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="py-28 px-6">
        <div className="max-w-2xl mx-auto">
          <Label>FAQ</Label>
          <h2 className="text-5xl font-black uppercase tracking-tight mb-12">
            COMMON <span style={{ color: ACCENT }}>QUESTIONS.</span>
          </h2>
          <div className="space-y-2">
            {[
              { q: "Do I need a gym membership?", a: "No. Coach K builds home workouts with zero equipment, dumbbell programmes, or full gym programmes. You choose at signup and can change anytime." },
              { q: "What is body recomp and why do most people choose it?", a: "Body recomposition means losing fat and building muscle at the same time — what most people actually want when they say they want to \"get fit\". Coach K manages this with high-protein eating, progressive training, and weekly adjustments. Results last because you're changing body composition, not just weight." },
              { q: "What if I can only afford cheap food?", a: "The under-R100 weekly meal plan is built around eggs, pilchards, pap, sugar beans, and spinach — all available at Shoprite. Good results do not require an expensive diet." },
              { q: "Is this a real coach or a bot?", a: "An AI coach trained specifically on South African food, lifestyle, and fitness. It knows pap from polenta, pilchards from salmon, and Nando's from a generic chicken restaurant. Over time it remembers your wins, your patterns, and adapts." },
              { q: "What if I have diabetes, hypertension, PCOS, or I'm on ARVs?", a: "Coach K adjusts for all of these. It flags when doctor clearance is needed, avoids foods that interact with common medications, and keeps nutrition within safe ranges for your condition." },
              { q: "How do I cancel?", a: "Reply CANCEL to Coach K at any time. No phone calls. No forms. No hassle. Your programme and progress are saved for 90 days — come back whenever you're ready." },
              { q: "Can I message Coach K in isiZulu, isiXhosa, or Afrikaans?", a: "Yes. Coach K understands isiZulu, isiXhosa, and Afrikaans — send in whichever language feels most natural. English works best for complex questions, but you'll be understood either way." },
            ].map((faq, i) => (
              <div key={i} style={{ background: CARD, border: `1px solid ${openFaq === i ? "#333" : BORDER}` }}
                className="rounded-2xl overflow-hidden">
                <button onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between gap-4 p-6 text-left hover:bg-white/[0.025] transition-colors">
                  <span className="font-bold text-white text-sm">{faq.q}</span>
                  {openFaq === i
                    ? <Minus className="w-4 h-4 text-white/25 shrink-0" />
                    : <Plus className="w-4 h-4 text-white/25 shrink-0" />}
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-6">
                    <p className="text-white/45 text-sm leading-relaxed">{faq.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="py-28 px-6 text-center" style={{ background: NAVY }}>
        <div className="max-w-3xl mx-auto">
          <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.5 }}>
            <h2 className="text-[clamp(40px,8vw,96px)] font-black uppercase leading-[0.9] tracking-tight mb-6">
              <span className="block" style={{ color: "rgba(255,255,255,0.2)" }}>R199 A MONTH.</span>
              <span className="block text-white">A TRAINER CHARGES R500</span>
              <span className="block" style={{ color: ACCENT }}>FOR ONE SESSION.</span>
            </h2>
            <p className="text-white/40 text-lg mb-10 max-w-lg mx-auto">
              A few quick questions on WhatsApp. Programme on Day 1. Coaching every day after that.
            </p>
            <WaBtn href={WA_LINK} large>Start free on WhatsApp</WaBtn>
            <p className="text-white/18 text-sm mt-4">7 days free · R199/month · Cancel anytime · No app needed</p>

            {/* Desktop QR — scan with your phone to open WhatsApp (ref=landing for attribution) */}
            <div className="mt-12 flex flex-col items-center gap-3">
              <div style={{ background: "#fff", borderRadius: "16px" }} className="p-3 shadow-2xl">
                <img src="/admin/qr.png?plain=1&ref=landing" alt="Scan to start on WhatsApp"
                  width={150} height={150} loading="lazy"
                  style={{ display: "block", width: "150px", height: "150px" }} />
              </div>
              <p className="text-white/35 text-xs font-medium tracking-wide">On your computer? Scan with your phone 📱</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, background: "#0B0B0B" }}
        className="py-14 px-6 lg:px-16">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-12">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Get Started</p>
              <ul className="space-y-2.5 text-sm text-white/45">
                <li><a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Start free on WhatsApp</a></li>
                <li><a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a></li>
                <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Support</p>
              <ul className="space-y-2.5 text-sm text-white/45">
                <li><span className="text-white/30">Reply <em>help</em> to Coach K</span></li>
                <li><a href="mailto:support@kamlifecoach.co.za" className="hover:text-white transition-colors">Email Us</a></li>
                <li><a href="/cancellation" className="hover:text-white transition-colors">Cancel / Refunds</a></li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">About</p>
              <ul className="space-y-2.5 text-sm text-white/45">
                <li><span className="text-white/30">Built for South Africa</span></li>
                <li><span className="text-white/30">WhatsApp-native</span></li>
                <li><span className="text-white/30">ZAR pricing — no forex</span></li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Legal</p>
              <ul className="space-y-2.5 text-sm text-white/45">
                <li><a href="/privacy" className="hover:text-white transition-colors">Privacy Policy (POPIA)</a></li>
                <li><a href="/terms" className="hover:text-white transition-colors">Terms of Service</a></li>
                <li><a href="/cancellation" className="hover:text-white transition-colors">Refund Policy</a></li>
                <li className="pt-2 text-white/25 text-xs leading-relaxed">Not affiliated with WhatsApp, Meta, or Twilio.</li>
              </ul>
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${BORDER}` }} className="pt-6 flex flex-col sm:flex-row justify-between items-center gap-2">
            <span className="text-xl font-black">KAM<span style={{ color: ACCENT }}>LIFE</span></span>
            <span className="text-sm text-white/20">© 2026 KamLife Lifestyle Coach</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
