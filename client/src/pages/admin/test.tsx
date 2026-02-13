import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, CheckCircle2, XCircle, Terminal } from "lucide-react";

const TEST_CASES = [
  { id: 'A', title: "Test A: New user not subscribed", description: "Should only receive payment link." },
  { id: 'B', title: "Test B: Active user logs steps", description: "Logs steps ('I did 7500 steps') -> StepLogs created + confirmation." },
  { id: 'C', title: "Test C: Missed workout", description: "Logs missed workout ('I skipped gym') -> WorkoutLogs created + accountability reply." },
  { id: 'D', title: "Test D: Weekly check-in parse", description: "Parses complex check-in message -> WeeklyCheckIns created + rules engine." },
  { id: 'E', title: "Test E: Plateau simulation", description: "Inserts plateau data -> verifies calorie reduction." },
  { id: 'F', title: "Test F: Inactivity simulation", description: "Sets user inactive -> verifies escalation flag." },
];

export default function AdminTest() {
  const [liveMode, setLiveMode] = useState(false);
  const [results, setResults] = useState<Record<string, any>>({});

  const testMutation = useMutation({
    mutationFn: async (testId: string) => {
      const response = await fetch(api.admin.runTest.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId, liveMode }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    onSuccess: (data, variables) => {
      setResults(prev => ({ ...prev, [variables]: data }));
    },
  });

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Integration Test Plan</h1>
          <p className="text-muted-foreground">Verify core MVP functionality and coaching logic.</p>
        </div>
        <div className="flex items-center space-x-2 bg-card p-3 rounded-lg border">
          <Label htmlFor="live-mode" className="font-semibold">Live Mode</Label>
          <Switch id="live-mode" checked={liveMode} onCheckedChange={setLiveMode} />
          <span className="text-xs text-muted-foreground">{liveMode ? "Real Sending" : "Dry Run (Mocked)"}</span>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold mb-4">Test Harness</h2>
          {TEST_CASES.map((test) => (
            <Card key={test.id} className="hover-elevate">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="space-y-1">
                  <CardTitle className="text-base">{test.title}</CardTitle>
                  <CardDescription>{test.description}</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  disabled={testMutation.isPending && testMutation.variables === test.id}
                  onClick={() => testMutation.mutate(test.id)}
                >
                  {testMutation.isPending && testMutation.variables === test.id ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  Run
                </Button>
              </CardHeader>
              {results[test.id] && (
                <CardContent>
                  <div className="mt-2 p-3 bg-muted rounded-md text-xs font-mono">
                    <div className="flex items-center gap-2 mb-2 font-bold text-primary border-b pb-1">
                      <Terminal className="h-3 w-3" /> LOGS
                    </div>
                    {results[test.id].logs.map((log: string, i: number) => (
                      <div key={i}> {">"} {log}</div>
                    ))}
                    
                    {results[test.id].dbChanges && (
                      <div className="mt-4">
                        <div className="font-bold text-green-600 mb-1 border-b pb-1">DB CHANGES</div>
                        <pre className="overflow-x-auto">{JSON.stringify(results[test.id].dbChanges, null, 2)}</pre>
                      </div>
                    )}

                    {results[test.id].whatsappSent && (
                      <div className="mt-4">
                        <div className="font-bold text-blue-600 mb-1 border-b pb-1">WHATSAPP OUTPUT</div>
                        <div className="whitespace-pre-wrap italic opacity-80">{results[test.id].whatsappSent}</div>
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold mb-4">Manual Verification Checklist</h2>
          <Card>
            <CardContent className="pt-6 space-y-4">
              {[
                "Subscription gate correctly blocks non-active users",
                "Weight and steps data saved with correct user reference",
                "Weekly rules engine triggers on check-in response",
                "Targets (calories/steps) update in DB after plateau",
                "Inactivity escalation appears in Flagged Users view",
                "No duplicate check-ins created for same week"
              ].map((item, i) => (
                <div key={i} className="flex items-start space-x-3">
                  <Checkbox id={`check-${i}`} className="mt-1" />
                  <Label htmlFor={`check-${i}`} className="text-sm leading-tight cursor-pointer">
                    {item}
                  </Label>
                </div>
              ))}
              
              <Alert className="mt-8 bg-primary/5 border-primary/20">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <AlertTitle>Logs & Verification</AlertTitle>
                <AlertDescription className="text-xs">
                  Review <b>Workflow Logs</b> in Replit for raw OpenAI token usage and server-side processing steps.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
