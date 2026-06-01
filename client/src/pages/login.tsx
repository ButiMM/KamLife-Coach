import { useState } from "react";
import { useLocation } from "wouter";
import { markLoggedIn } from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, ArrowLeft } from "lucide-react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (res.status === 429) {
        setError("Too many failed attempts — try again in 15 minutes");
        return;
      }
      if (!res.ok) {
        setError("Invalid password");
        return;
      }
      markLoggedIn();
      queryClient.setQueryData(["/api/auth/check"], true);
      navigate("/dashboard");
    } catch {
      setError("Connection error — try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      {/* Background layers — same palette as landing hero */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0B1D35] via-[#1E3A6E] to-[#0B2A1A]" />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 80% 60% at 20% 30%, rgba(251,146,60,0.10) 0%, transparent 70%)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 60% 50% at 80% 80%, rgba(37,211,102,0.07) 0%, transparent 65%)" }} />
      <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1px)", backgroundSize: "32px 32px" }} />

      {/* Back link */}
      <a
        href="/"
        className="absolute top-6 left-6 flex items-center gap-1.5 text-white/50 hover:text-white/90 text-sm transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to site
      </a>

      {/* Card */}
      <div className="relative z-10 w-full max-w-sm mx-4">
        <div className="bg-white/[0.06] backdrop-blur-sm border border-white/10 rounded-2xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <img
              src="https://res.cloudinary.com/dkxpypiak/image/upload/h_100,c_fit,f_auto/image-1779985068852_v6rnbe"
              alt="KamLife Lifestyle Coach"
              className="h-14 w-auto object-contain"
              style={{ filter: "brightness(0) invert(1)" }}
            />
          </div>

          <div className="text-center mb-6">
            <div className="mx-auto mb-3 w-11 h-11 rounded-full bg-white/10 flex items-center justify-center">
              <Lock className="w-5 h-5 text-white/80" />
            </div>
            <h1 className="text-xl font-bold text-white font-display">Coach Dashboard</h1>
            <p className="text-sm text-white/50 mt-1">Enter your dashboard password</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-[#25D366] focus:ring-[#25D366]/30"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button
              type="submit"
              className="w-full h-11 rounded-xl font-semibold bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 shadow-lg shadow-green-500/20"
              disabled={loading || !password}
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
