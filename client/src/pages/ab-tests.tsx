import React, { useState } from "react";
import { DashboardLayout } from "@/components/layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authHeaders } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FlaskConical, Plus, Users, TrendingUp, CheckCircle2, PauseCircle, Trophy } from "lucide-react";

// ── Types ──

interface ABExperiment {
  id: number;
  name: string;
  description: string | null;
  messageType: string;
  status: "active" | "paused" | "completed";
  variantA: string;
  variantB: string;
  createdAt: string;
  completedAt: string | null;
  statsA: { sent: number; delivered: number; responded: number };
  statsB: { sent: number; delivered: number; responded: number };
  responseRateA: number;
  responseRateB: number;
}

// ── Hooks ──

function useABExperiments() {
  return useQuery({
    queryKey: ["/api/dashboard/ab/experiments"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/ab/experiments", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch experiments");
      return res.json() as Promise<{ experiments: ABExperiment[] }>;
    },
    refetchInterval: 30_000,
  });
}

// ── Helpers ──

function statusBadge(status: string) {
  if (status === "active") return <Badge className="bg-green-100 text-green-800 border-green-200">Active</Badge>;
  if (status === "paused") return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Paused</Badge>;
  return <Badge className="bg-slate-100 text-slate-600 border-slate-200">Completed</Badge>;
}

function WinnerBadge({ rateA, rateB }: { rateA: number; rateB: number }) {
  const diff = Math.abs(rateA - rateB);
  if (diff < 3) return <span className="text-xs text-muted-foreground italic">Tied</span>;
  const winner = rateA > rateB ? "A" : "B";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
      winner === "A"
        ? "bg-blue-100 text-blue-700"
        : "bg-purple-100 text-purple-700"
    }`}>
      <Trophy className="w-3 h-3" /> Variant {winner} leads (+{diff}%)
    </span>
  );
}

function VariantBar({ label, rate, sent, responded, color }: {
  label: string; rate: number; sent: number; responded: number; color: "blue" | "purple";
}) {
  const barColor = color === "blue" ? "bg-blue-500" : "bg-purple-500";
  const textColor = color === "blue" ? "text-blue-700" : "text-purple-700";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className={`font-semibold ${textColor}`}>{label}</span>
        <span className="text-muted-foreground text-xs">{responded}/{sent} responded</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-muted rounded-full h-2.5">
          <div
            className={`${barColor} h-2.5 rounded-full transition-all`}
            style={{ width: `${Math.min(100, rate)}%` }}
          />
        </div>
        <span className={`text-sm font-bold w-10 text-right ${textColor}`}>{rate}%</span>
      </div>
    </div>
  );
}

// ── Main Page ──

export default function ABTests() {
  const { data, isLoading } = useABExperiments();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "completed">("all");

  // Create experiment mutation
  const createMutation = useMutation({
    mutationFn: async (body: { name: string; description: string; variantA: string; variantB: string; messageType: string }) => {
      const res = await fetch("/api/dashboard/ab/experiments", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create experiment");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/ab/experiments"] });
      setNewOpen(false);
      toast({ title: "Experiment created", description: "Users will be auto-assigned as they receive messages." });
    },
    onError: () => toast({ title: "Error", description: "Failed to create experiment.", variant: "destructive" }),
  });

  // Status update mutation
  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await fetch(`/api/dashboard/ab/experiments/${id}/status`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/ab/experiments"] });
      toast({ title: "Status updated" });
    },
    onError: () => toast({ title: "Error", description: "Failed to update status.", variant: "destructive" }),
  });

  // Bulk assign mutation
  const assignMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/dashboard/ab/experiments/${id}/assign`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to assign");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/ab/experiments"] });
      toast({ title: "Users assigned", description: `${data.assigned} assigned, ${data.skipped} already had a variant.` });
    },
    onError: () => toast({ title: "Error", description: "Failed to assign users.", variant: "destructive" }),
  });

  const experiments = data?.experiments ?? [];
  const filtered = statusFilter === "all" ? experiments : experiments.filter(e => e.status === statusFilter);

  const activeCount = experiments.filter(e => e.status === "active").length;
  const totalN = experiments.reduce((s, e) => s + e.statsA.sent + e.statsB.sent, 0);
  const completedCount = experiments.filter(e => e.status === "completed").length;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight flex items-center gap-3">
              <FlaskConical className="w-8 h-8 text-indigo-500" />
              A/B Tests
            </h2>
            <p className="text-muted-foreground mt-1">
              Test message variants to improve response rates and engagement
            </p>
          </div>
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" /> New Experiment
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[560px]">
              <DialogHeader>
                <DialogTitle>Create A/B Experiment</DialogTitle>
              </DialogHeader>
              <NewExperimentForm
                onSubmit={(values) => createMutation.mutate(values)}
                loading={createMutation.isPending}
              />
            </DialogContent>
          </Dialog>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="p-4 border-border/50 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/20">
              <FlaskConical className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{activeCount}</p>
              <p className="text-sm text-muted-foreground">Active experiments</p>
            </div>
          </Card>
          <Card className="p-4 border-border/50 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/20">
              <Users className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalN.toLocaleString()}</p>
              <p className="text-sm text-muted-foreground">Total assignments</p>
            </div>
          </Card>
          <Card className="p-4 border-border/50 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
              <CheckCircle2 className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{completedCount}</p>
              <p className="text-sm text-muted-foreground">Completed</p>
            </div>
          </Card>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2 flex-wrap">
          {(["all", "active", "paused", "completed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                statusFilter === f
                  ? "bg-primary text-primary-foreground shadow"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f !== "all" && (
                <span className="ml-1 opacity-60">
                  ({experiments.filter(e => e.status === f).length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Experiment cards */}
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map(i => (
              <Card key={i} className="p-6 border-border/50 animate-pulse">
                <div className="h-5 w-48 bg-muted rounded mb-3" />
                <div className="h-4 w-full bg-muted rounded" />
              </Card>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="p-12 border-border/50 border-dashed text-center">
            <FlaskConical className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              {statusFilter === "all"
                ? 'No experiments yet. Click "New Experiment" to create your first A/B test.'
                : `No ${statusFilter} experiments.`}
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {filtered.map((exp) => (
              <Card key={exp.id} className={`p-6 border-border/50 shadow-sm ${
                exp.status === "active" ? "border-green-200 dark:border-green-900" : ""
              }`}>
                <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-lg">{exp.name}</h3>
                      {statusBadge(exp.status)}
                      <Badge variant="outline" className="text-xs">{exp.messageType}</Badge>
                    </div>
                    {exp.description && (
                      <p className="text-sm text-muted-foreground">{exp.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(exp.createdAt).toLocaleDateString("en-ZA")}
                      {exp.completedAt && ` · Completed ${new Date(exp.completedAt).toLocaleDateString("en-ZA")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                    {exp.status === "active" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 text-xs"
                          onClick={() => assignMutation.mutate(exp.id)}
                          disabled={assignMutation.isPending}
                        >
                          <Users className="w-3 h-3" /> Assign All
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 text-xs text-amber-600 border-amber-200 hover:bg-amber-50"
                          onClick={() => statusMutation.mutate({ id: exp.id, status: "paused" })}
                          disabled={statusMutation.isPending}
                        >
                          <PauseCircle className="w-3 h-3" /> Pause
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 text-xs text-green-700 border-green-200 hover:bg-green-50"
                          onClick={() => statusMutation.mutate({ id: exp.id, status: "completed" })}
                          disabled={statusMutation.isPending}
                        >
                          <CheckCircle2 className="w-3 h-3" /> Complete
                        </Button>
                      </>
                    )}
                    {exp.status === "paused" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 text-xs text-green-700 border-green-200 hover:bg-green-50"
                        onClick={() => statusMutation.mutate({ id: exp.id, status: "active" })}
                        disabled={statusMutation.isPending}
                      >
                        Resume
                      </Button>
                    )}
                  </div>
                </div>

                {/* Variant comparison */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-4">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Variant A</p>
                    <p className="text-sm bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 rounded p-3 text-blue-900 dark:text-blue-200 leading-relaxed">
                      {exp.variantA}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Variant B</p>
                    <p className="text-sm bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900 rounded p-3 text-purple-900 dark:text-purple-200 leading-relaxed">
                      {exp.variantB}
                    </p>
                  </div>
                </div>

                {/* Results */}
                <div className="border-t border-border/50 pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-muted-foreground" />
                      Response Rate
                    </p>
                    <WinnerBadge rateA={exp.responseRateA} rateB={exp.responseRateB} />
                  </div>
                  {(exp.statsA.sent + exp.statsB.sent) === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No data yet — users will be assigned automatically when messages are sent.</p>
                  ) : (
                    <div className="space-y-2.5">
                      <VariantBar
                        label="A"
                        rate={exp.responseRateA}
                        sent={exp.statsA.sent}
                        responded={exp.statsA.responded}
                        color="blue"
                      />
                      <VariantBar
                        label="B"
                        rate={exp.responseRateB}
                        sent={exp.statsB.sent}
                        responded={exp.statsB.responded}
                        color="purple"
                      />
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── New Experiment Form ──

function NewExperimentForm({
  onSubmit,
  loading,
}: {
  onSubmit: (v: { name: string; description: string; variantA: string; variantB: string; messageType: string }) => void;
  loading: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [variantA, setVariantA] = useState("");
  const [variantB, setVariantB] = useState("");
  const [messageType, setMessageType] = useState("morning_message");

  const valid = name.trim() && variantA.trim() && variantB.trim() && messageType;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({ name, description, variantA, variantB, messageType });
      }}
      className="space-y-4 pt-2"
    >
      <div className="space-y-1.5">
        <Label htmlFor="exp-name">Experiment Name *</Label>
        <Input
          id="exp-name"
          placeholder="e.g. Morning opener — accountability vs motivation"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="exp-desc">Description</Label>
        <Input
          id="exp-desc"
          placeholder="What hypothesis are you testing?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="exp-type">Message Type *</Label>
        <Select value={messageType} onValueChange={setMessageType}>
          <SelectTrigger id="exp-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="morning_message">Morning Message</SelectItem>
            <SelectItem value="evening_accountability">Evening Accountability</SelectItem>
            <SelectItem value="streak_at_risk">Streak At Risk</SelectItem>
            <SelectItem value="re_engagement">Re-engagement</SelectItem>
            <SelectItem value="milestone">Milestone Message</SelectItem>
            <SelectItem value="weekly_wins">Weekly Wins</SelectItem>
            <SelectItem value="food_log_followup">Food Log Follow-up</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="variant-a">Variant A *</Label>
          <Textarea
            id="variant-a"
            className="text-sm min-h-[100px] bg-blue-50/50 border-blue-200 focus:border-blue-400"
            placeholder="Control message text..."
            value={variantA}
            onChange={(e) => setVariantA(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="variant-b">Variant B *</Label>
          <Textarea
            id="variant-b"
            className="text-sm min-h-[100px] bg-purple-50/50 border-purple-200 focus:border-purple-400"
            placeholder="Test message text..."
            value={variantB}
            onChange={(e) => setVariantB(e.target.value)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Users are automatically assigned 50/50 to A or B when a message of this type is sent. Response is tracked for 24 hours.
      </p>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={!valid || loading}>
          {loading ? "Creating..." : "Create Experiment"}
        </Button>
      </div>
    </form>
  );
}
