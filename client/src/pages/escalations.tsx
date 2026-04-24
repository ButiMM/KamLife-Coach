import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { authHeaders, apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle, Clock, User, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "wouter";

interface Escalation {
  id: number;
  reason: string;
  triggerMessage: string | null;
  status: string;
  priority: "urgent" | "high" | "normal" | "low";
  claimedBy: string | null;
  resolution: string | null;
  createdAt: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  slaDeadline: string | null;
  userName: string | null;
  userPhone: string | null;
  userGoal: string | null;
  slaBreach: boolean;
  slaRemaining: number | null;
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "border-red-300 bg-red-50",
  high: "border-orange-300 bg-orange-50",
  normal: "border-yellow-200 bg-yellow-50",
  low: "border-blue-200 bg-blue-50",
};

const PRIORITY_BADGE: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-300",
  high: "bg-orange-100 text-orange-800 border-orange-300",
  normal: "bg-yellow-100 text-yellow-800 border-yellow-200",
  low: "bg-blue-100 text-blue-700 border-blue-200",
};

export default function Escalations() {
  const [statusFilter, setStatusFilter] = useState<"open" | "claimed" | "resolved" | "all">("open");
  const [resolveId, setResolveId] = useState<number | null>(null);
  const [resolutionText, setResolutionText] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["/api/dashboard/escalations", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard/escalations?status=${statusFilter}`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ escalations: Escalation[] }>;
    },
    refetchInterval: 30_000,
  });

  const claimMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/dashboard/escalations/${id}/claim`, { claimedBy: "Coach K" });
      return res.json();
    },
    onSuccess: () => { toast({ title: "Claimed" }); qc.invalidateQueries({ queryKey: ["/api/dashboard/escalations"] }); },
    onError: () => toast({ title: "Failed to claim", variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, resolution }: { id: number; resolution: string }) => {
      const res = await apiRequest("POST", `/api/dashboard/escalations/${id}/resolve`, { resolution });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Resolved" });
      setResolveId(null);
      setResolutionText("");
      qc.invalidateQueries({ queryKey: ["/api/dashboard/escalations"] });
    },
    onError: () => toast({ title: "Failed to resolve", variant: "destructive" }),
  });

  const escalations = data?.escalations ?? [];
  const openCount = escalations.filter(e => e.status === "open").length;
  const breachCount = escalations.filter(e => e.slaBreach).length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight flex items-center gap-2">
              <ShieldAlert className="w-7 h-7 text-red-500" />
              Escalation Inbox
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Safety alerts that need human review. Urgent/High SLA = 1–4 hours.
            </p>
          </div>
          <div className="flex gap-2">
            {(["open", "claimed", "resolved", "all"] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-full border capitalize transition-colors ${statusFilter === s ? "bg-primary text-primary-foreground border-primary" : "border-border bg-card hover:bg-muted"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Summary banners */}
        {openCount > 0 && (
          <div className="flex gap-3">
            <div className="flex-1 bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
              <span className="text-sm font-medium text-red-800">
                {openCount} open escalation{openCount !== 1 ? "s" : ""} — review and claim within SLA
              </span>
            </div>
            {breachCount > 0 && (
              <div className="bg-red-600 text-white rounded-xl p-4 flex items-center gap-3 shrink-0">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <span className="text-sm font-bold">{breachCount} SLA BREACH{breachCount !== 1 ? "ES" : ""}</span>
              </div>
            )}
          </div>
        )}

        {/* Escalation list */}
        {isLoading ? (
          <Card className="p-8 text-center text-muted-foreground">Loading...</Card>
        ) : escalations.length === 0 ? (
          <Card className="p-12 text-center">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold">No escalations</h3>
            <p className="text-muted-foreground">No {statusFilter === "all" ? "" : statusFilter} escalations found.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {escalations.map(e => (
              <div key={e.id} className={`rounded-xl border-2 p-5 space-y-3 ${PRIORITY_STYLES[e.priority] || "border-border bg-card"} ${e.slaBreach ? "ring-2 ring-red-500" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <User className="w-5 h-5 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm">{e.userName || e.userPhone || "Unknown"}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${PRIORITY_BADGE[e.priority] || ""}`}>
                          {e.priority.toUpperCase()}
                        </span>
                        <span className="text-xs bg-secondary px-2 py-0.5 rounded">{e.status}</span>
                        {e.slaBreach && (
                          <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded-full font-bold animate-pulse">SLA BREACH</span>
                        )}
                        {!e.slaBreach && e.slaRemaining !== null && e.status === "open" && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {e.slaRemaining < 60 ? `${e.slaRemaining}m left` : `${Math.floor(e.slaRemaining / 60)}h left`}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{e.reason}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {e.userPhone && (
                      <Link href={`/users/${e.userPhone}`}>
                        <Button size="sm" variant="outline" className="text-xs">View Client</Button>
                      </Link>
                    )}
                    {e.status === "open" && (
                      <Button size="sm" onClick={() => claimMutation.mutate(e.id)} disabled={claimMutation.isPending} className="text-xs">
                        Claim
                      </Button>
                    )}
                    {(e.status === "open" || e.status === "claimed") && (
                      <Button size="sm" variant="secondary" onClick={() => { setResolveId(e.id); setResolutionText(""); }} className="text-xs">
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>

                {e.triggerMessage && (
                  <div className="bg-white/60 rounded-lg p-3 text-sm border border-white/80">
                    <p className="text-xs text-muted-foreground mb-1 font-medium">Trigger message:</p>
                    <p className="text-foreground italic">"{e.triggerMessage.slice(0, 300)}{e.triggerMessage.length > 300 ? "…" : ""}"</p>
                  </div>
                )}

                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Created {e.createdAt ? format(new Date(e.createdAt), "MMM d HH:mm") : "-"}</span>
                  {e.claimedBy && <span>Claimed by {e.claimedBy}</span>}
                  {e.resolution && <span className="text-green-700">Resolved: {e.resolution.slice(0, 60)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Resolve dialog */}
      <AlertDialog open={resolveId !== null} onOpenChange={open => { if (!open) setResolveId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resolve escalation</AlertDialogTitle>
            <AlertDialogDescription>Add a brief note on what action was taken.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="e.g. Called client, confirmed they are safe. Referred to helpline."
            value={resolutionText}
            onChange={e => setResolutionText(e.target.value)}
            className="min-h-[80px] resize-none my-3"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!resolutionText.trim() || resolveMutation.isPending}
              onClick={() => { if (resolveId !== null) resolveMutation.mutate({ id: resolveId, resolution: resolutionText }); }}
            >
              Mark Resolved
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
