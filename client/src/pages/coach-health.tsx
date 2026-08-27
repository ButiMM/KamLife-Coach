import { useState } from "react";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "@/lib/queryClient";

// ── Coach Health ────────────────────────────────────────────────────────────────
// THE FOUNDER STOPS BEING THE SENSOR (2026-08-27).
//
// Every defect this product has fixed arrived the same way: Kam saw it on his own phone,
// screenshotted it, and explained it. That makes one person's attention the limit of what the
// product can discover about itself. turn_ledger has recorded the mechanism of every turn since
// 2026-08-10 and the triage page could already read it — but only a HUMAN verdict put a turn in
// the queue, so nothing was ever found that nobody looked at.
//
// This section counts the failures we have ALREADY adjudicated, against real turns. No model
// judges anything: each rule is the same property its cut's contract test asserts, pointed at
// production instead of a fixture. A non-zero count is therefore not a new discovery — it is a
// merged fix that is not holding, which is the more valuable signal.
//
// ASKED is shown next to FAILED on purpose. A rule at 0/0 has not been exercised in this window,
// which is a different statement from "this failure is not happening", and the difference is
// exactly where a dashboard starts lying. Data: /api/admin/coach-health.
interface CoachHealthPayload {
  windowDays: number;
  turns: number;
  flagged: number;
  unresolved: number;
  historical: number;
  attribution: string;
  clusters: Array<{
    id: string; label: string; layer: string; fixRef: string; expected: string;
    fixedAt: string; trigger: "request" | "mutation";
    occurrences: number; historical: number; clients: number;
    candidates: number; historicalCandidates: number;
    examples: Array<{ turnId: string; at: string; version: string | null; input: string; reply: string; status: string | null }>;
    historicalExamples: Array<{ turnId: string; at: string; version: string | null; input: string; reply: string; status: string | null }>;
  }>;
  cannotSurface: Array<{ id: string; fixRef: string; why: string }>;
}

const LAYER_CHIP: Record<string, string> = {
  Claim: "bg-amber-100 text-amber-700 border-amber-200",
  Decision: "bg-blue-100 text-blue-700 border-blue-200",
  Response: "bg-violet-100 text-violet-700 border-violet-200",
  Coaching: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

function CoachHealthPanel() {
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState(1);
  const { data } = useQuery({
    queryKey: ["/api/admin/coach-health", days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/coach-health?days=${days}`, { headers: authHeaders() });
      if (!res.ok) return null;
      return res.json() as Promise<CoachHealthPayload>;
    },
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (!data) return null;

  return (
    <Card className="p-6 border-border/50">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
        <div>
          <h3 className="text-xl font-bold font-display">🩺 Coach Health</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {data.turns.toLocaleString()} turns · {data.flagged} regression
            {data.flagged === 1 ? "" : "s"} since fix · {data.historical} historical
          </p>
        </div>
        <div className="flex gap-1">
          {[1, 7, 30].map(d => (
            <Button
              key={d}
              variant={days === d ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(d)}
            >
              {d === 1 ? "Today" : `${d}d`}
            </Button>
          ))}
        </div>
      </div>

      {data.flagged === 0 && (
        <div className="text-sm text-muted-foreground mb-4 p-3 rounded-md bg-muted/40">
          No adjudicated failure has recurred since its fix merged. A rule whose denominator is
          <strong> 0</strong> below was not exercised at all in this window — that is untested,
          not proven healthy.
        </div>
      )}

      <div className="space-y-2">
        {data.clusters.map(c => (
          <div key={c.id} className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-muted/40"
              onClick={() => setOpen(open === c.id ? null : c.id)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-xs px-2 py-0.5 rounded border ${LAYER_CHIP[c.layer] || ""}`}>
                  {c.layer}
                </span>
                <span className="font-medium truncate">{c.label}</span>
                <span className="text-xs text-muted-foreground shrink-0">{c.fixRef}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-sm font-bold ${c.occurrences > 0 ? "text-rose-600" : "text-muted-foreground"}`}>
                  {c.occurrences}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.trigger === "request"
                    ? `of ${c.candidates} request${c.candidates === 1 ? "" : "s"} since the fix`
                    : `${c.candidates} turn${c.candidates === 1 ? "" : "s"} scanned since the fix`}
                  {c.clients > 0 ? ` · ${c.clients} client${c.clients === 1 ? "" : "s"}` : ""}
                  {c.historicalCandidates > 0
                    ? ` · ${c.historical}/${c.historicalCandidates} before the fix`
                    : ""}
                </span>
              </div>
            </button>

            {open === c.id && (
              <div className="border-t p-3 bg-muted/20 text-sm space-y-3">
                <p className="text-muted-foreground">Expected: {c.expected}</p>
                <p className="text-muted-foreground text-xs">
                  Fixed {new Date(c.fixedAt).toLocaleString("en-ZA")} ({c.fixRef}). Turns before that
                  are the failure we corrected, not a regression — they are counted separately.
                </p>
                {c.examples.length === 0 ? (
                  <p className="text-muted-foreground italic">
                    {c.candidates === 0
                      ? "Not exercised in this window — nothing matched this rule at all."
                      : "Exercised, and answered correctly every time since the fix."}
                  </p>
                ) : c.examples.map(ex => (
                  <div key={ex.turnId} className="border rounded p-2 bg-background">
                    <div className="text-xs text-muted-foreground mb-1">
                      {new Date(ex.at).toLocaleString("en-ZA")} · build {ex.version || "?"}
                      {ex.status ? ` · ${ex.status}` : ""}
                    </div>
                    <div className="font-mono text-xs">“{ex.input}”</div>
                    <div className="font-mono text-xs text-rose-700 mt-1">→ {ex.reply}</div>
                    <a
                      className="text-xs text-blue-600 hover:underline mt-1 inline-block"
                      href={`/admin/turns?turn=${ex.turnId}`}
                    >
                      Open the turn →
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.cannotSurface.length > 0 && (
        <div className="mt-4 pt-3 border-t text-xs text-muted-foreground">
          <strong>Not measurable here:</strong>{" "}
          {data.cannotSurface.map(c => `${c.fixRef} — ${c.why}`).join(" · ")}
        </div>
      )}
    </Card>
  );
}


export default function CoachHealthPage() {
  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold font-display tracking-tight">Coach Health</h2>
          <p className="text-muted-foreground mt-1">
            Whether the failures we have already fixed are staying fixed, counted from real conversations
          </p>
        </div>
        <CoachHealthPanel />
      </div>
    </DashboardLayout>
  );
}
