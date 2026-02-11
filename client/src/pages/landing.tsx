import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { MessageCircle, CheckCircle, TrendingUp, Shield } from "lucide-react";
import { motion } from "framer-motion";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-hidden">
      {/* Navbar */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-white font-bold font-display">K</span>
          </div>
          <span className="font-bold font-display text-xl tracking-tight">KamLife</span>
        </div>
        <div className="flex items-center gap-4">
            <Link href="/dashboard">
                <Button variant="ghost" className="font-medium">Coach Login</Button>
            </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative pt-16 pb-32 flex flex-col items-center justify-center text-center px-4">
        {/* Background decorative blobs */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[600px] bg-gradient-to-b from-primary/10 to-transparent -z-10 blur-3xl rounded-full opacity-50 pointer-events-none" />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="max-w-4xl mx-auto space-y-6"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-secondary text-primary text-sm font-semibold mb-4">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            Accepting New Clients in South Africa
          </div>
          
          <h1 className="text-5xl sm:text-7xl font-display font-bold leading-[1.1] tracking-tight">
            Personal Coaching <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-400">
              Directly in WhatsApp
            </span>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Automated check-ins, progress tracking, and personalized feedback. 
            Get fit without downloading another app.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
            <Button 
                size="lg" 
                className="h-14 px-8 rounded-2xl text-lg font-semibold shadow-xl shadow-primary/25 hover:shadow-2xl hover:scale-105 transition-all"
                onClick={() => window.location.href = "https://wa.me/27123456789?text=Hi%2C%20I%27d%20like%20to%20start%20coaching"}
            >
              <MessageCircle className="w-5 h-5 mr-2" />
              Start Coaching Now
            </Button>
            <Button size="lg" variant="outline" className="h-14 px-8 rounded-2xl text-lg border-2">
              How it works
            </Button>
          </div>
        </motion.div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto mt-32 w-full px-4">
          <FeatureCard 
            icon={MessageCircle}
            title="Chat Interface"
            desc="Log meals, steps, and weight simply by texting. No complex forms."
          />
          <FeatureCard 
            icon={TrendingUp}
            title="Weekly Progress"
            desc="Receive automated report cards every Sunday with actionable feedback."
          />
          <FeatureCard 
            icon={Shield}
            title="Accountability"
            desc="We flag when you go silent. Our system keeps you on track."
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-12 text-center text-muted-foreground">
        <p>&copy; 2024 KamLife Fitness. Built for South Africa 🇿🇦</p>
      </footer>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, desc }: { icon: any, title: string, desc: string }) {
  return (
    <div className="p-8 rounded-3xl bg-card border border-border/50 hover:border-primary/20 hover:shadow-lg transition-all duration-300 group">
      <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-6 group-hover:scale-110 transition-transform">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="text-xl font-bold mb-3">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">
        {desc}
      </p>
    </div>
  );
}
