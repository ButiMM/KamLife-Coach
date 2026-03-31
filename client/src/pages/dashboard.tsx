import { useState } from "react";
import { useUsers, useFlaggedUsers, useMetrics } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Users, UserX, Activity, TrendingUp, AlertCircle, ArrowRight, DollarSign, UserPlus } from "lucide-react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "@/lib/queryClient";

export default function Dashboard() {
  const { data: users, isLoading: usersLoading } = useUsers();
  const { data: flaggedUsers, isLoading: flaggedLoading } = useFlaggedUsers();
  const { data: metrics } = useMetrics();
  const [flagFilter, setFlagFilter] = useState<"all" | "inactive_7_days" | "plateau_2_weeks">("all");
  const [flagSort, setFlagSort] = useState<"lastActive" | "name">("lastActive");

  // Live health check — polls every 60s
  const { data: health } = useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await fetch("/api/health", { headers: authHeaders() });
      if (!res.ok) return null;
      return res.json() as Promise<{ status: string; checks: Record<string, { status: string }> }>;
    },
    refetchInterval: 60_000,
    retry: false,
  });

  const totalUsers = users?.length || 0;
  const activeUsers = users?.filter(u => u.subscriptionStatus === 'active').length || 0;
  const trialUsers = users?.filter(u => u.subscriptionStatus === 'trial').length || 0;
  const mrr = metrics?.estimatedMRR ?? (activeUsers * 99);

  const displayedFlagged = (flaggedUsers || [])
    .filter(u => flagFilter === "all" || u.flagReason === flagFilter)
    .sort((a, b) => {
      if (flagSort === "name") return (a.name || "").localeCompare(b.name || "");
      const aDate = a.lastLogDate ? new Date(a.lastLogDate).getTime() : 0;
      const bDate = b.lastLogDate ? new Date(b.lastLogDate).getTime() : 0;
      return aDate - bDate; // oldest activity first
    });

  if (usersLoading) return <DashboardLoading />;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground mt-1">Overview of your coaching business</p>
          </div>
          <div className="flex gap-2 text-sm text-muted-foreground bg-white dark:bg-card px-4 py-2 rounded-full border border-border shadow-sm">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse my-auto"></span>
            System Online
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
          <StatCard
            title="Total Users"
            value={totalUsers}
            icon={Users}
            trend={metrics ? `+${metrics.newThisWeek} this week` : "All time"}
            color="text-blue-600 bg-blue-100 dark:bg-blue-900/20"
          />
          <StatCard
            title="Active Subs"
            value={activeUsers}
            icon={Activity}
            trend="Paying clients"
            color="text-emerald-600 bg-emerald-100 dark:bg-emerald-900/20"
          />
          <StatCard
            title="Est. MRR"
            value={`R${mrr.toLocaleString()}`}
            icon={DollarSign}
            trend={`${metrics?.payingClients ?? activeUsers} paying × R99`}
            color="text-green-600 bg-green-100 dark:bg-green-900/20"
          />
          <StatCard
            title="New This Week"
            value={metrics?.newThisWeek ?? "—"}
            icon={UserPlus}
            trend="Just joined"
            color="text-indigo-600 bg-indigo-100 dark:bg-indigo-900/20"
          />
          <StatCard
            title="On Trial"
            value={trialUsers}
            icon={TrendingUp}
            trend="Need converting"
            color="text-amber-600 bg-amber-100 dark:bg-amber-900/20"
          />
          <StatCard
            title="Flagged"
            value={flaggedUsers?.length || 0}
            icon={AlertCircle}
            trend="Needs attention"
            color="text-rose-600 bg-rose-100 dark:bg-rose-900/20"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Flagged Users List - Takes up 2 cols */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-bold font-display">Attention Required</h3>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Filter buttons */}
                {(["all", "inactive_7_days", "plateau_2_weeks"] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setFlagFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${flagFilter === f ? "bg-primary text-white border-primary" : "border-border bg-card hover:bg-muted"}`}
                  >
                    {f === "all" ? "All" : f === "inactive_7_days" ? "Inactive 7d" : "Plateau"}
                  </button>
                ))}
                <select
                  value={flagSort}
                  onChange={e => setFlagSort(e.target.value as "lastActive" | "name")}
                  className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
                >
                  <option value="lastActive">Sort: Least Active</option>
                  <option value="name">Sort: Name</option>
                </select>
              </div>
            </div>

            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              {flaggedLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading flagged users...</div>
              ) : displayedFlagged.length > 0 ? (
                <div className="divide-y divide-border">
                  {displayedFlagged.map((user) => (
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        key={user.id} 
                        className="p-4 sm:p-6 hover:bg-muted/30 transition-colors flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center font-bold">
                          {user.name?.[0] || "?"}
                        </div>
                        <div>
                          <h4 className="font-semibold text-foreground">{user.name || "Unknown User"}</h4>
                          <p className="text-sm text-rose-600 font-medium mt-0.5">
                            {user.flagReason === 'inactive_7_days' ? 'Inactive > 7 Days' : 'Weight Plateau (2 Weeks)'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground hidden sm:block">
                            Last active: {user.lastLogDate ? new Date(user.lastLogDate).toLocaleDateString() : 'Never'}
                        </span>
                        <Link href={`/users/${user.id}`}>
                            <Button size="sm" variant="secondary" className="group-hover:bg-primary group-hover:text-white transition-colors">
                                Review
                            </Button>
                        </Link>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="p-12 text-center">
                    <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                        <CheckCircle className="w-8 h-8" />
                    </div>
                    <h3 className="text-lg font-semibold">All Clear!</h3>
                    <p className="text-muted-foreground">No users flagged for attention right now.</p>
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions / Recent Activity - Takes up 1 col */}
          <div className="space-y-6">
            <h3 className="text-xl font-bold font-display">Quick Actions</h3>
            <div className="grid gap-4">
                <Button className="w-full justify-between h-auto py-4 px-6 text-left rounded-xl bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary text-white shadow-lg shadow-primary/20">
                    <div>
                        <span className="block font-bold">Broadcast Message</span>
                        <span className="text-primary-foreground/80 text-sm font-normal">Send to all active users</span>
                    </div>
                    <MessageCircle className="w-5 h-5 opacity-80" />
                </Button>
                
                <div className="bg-card rounded-2xl border border-border p-6 shadow-sm">
                    <h4 className="font-semibold mb-4 text-sm text-muted-foreground uppercase tracking-wider">System Status</h4>
                    <div className="space-y-4">
                        <StatusRow label="WhatsApp API" status={health?.checks?.whatsapp?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="OpenAI GPT-4" status={health?.checks?.openai?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="PayFast Payments" status={health?.checks?.payfast?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="Database" status={health?.checks?.database?.status === "online" ? "online" : health ? "offline" : "idle"} />
                    </div>
                    {health && <p className="text-xs text-muted-foreground mt-3">Last checked: {new Date().toLocaleTimeString()}</p>}
                </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

import { CheckCircle, MessageCircle } from "lucide-react";

function StatCard({ title, value, icon: Icon, trend, color }: any) {
  return (
    <Card className="p-6 border-border/50 shadow-sm hover:shadow-md transition-all duration-300">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <h3 className="text-3xl font-bold font-display mt-1">{value}</h3>
        </div>
        <div className={`p-3 rounded-xl ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <p className="text-xs font-medium text-muted-foreground bg-secondary/50 py-1 px-2 rounded inline-block">
        {trend}
      </p>
    </Card>
  );
}

function StatusRow({ label, status }: { label: string, status: 'online' | 'offline' | 'idle' }) {
    const color = status === 'online' ? 'bg-emerald-500' : status === 'idle' ? 'bg-amber-500' : 'bg-rose-500';
    return (
        <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{label}</span>
            <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${color}`}></span>
                <span className="text-xs text-muted-foreground capitalize">{status}</span>
            </div>
        </div>
    )
}

function DashboardLoading() {
    return (
        <DashboardLayout>
            <div className="space-y-8 animate-pulse">
                <div className="h-8 bg-muted rounded w-1/4"></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {[1,2,3,4].map(i => <div key={i} className="h-32 bg-muted rounded-2xl"></div>)}
                </div>
                <div className="h-96 bg-muted rounded-2xl"></div>
            </div>
        </DashboardLayout>
    )
}
