import { useState, useRef } from "react";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Mic, Upload, Send, Trash2, CheckCircle2, Clock, Users, Sparkles, Play, AlertCircle, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Broadcast {
  id: string;
  label: string;
  content_type: string;
  duration_secs: number | null;
  sent_count: number;
  sent_at: string | null;
  created_at: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function VoiceBroadcast() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [label, setLabel] = useState("");
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [confirmSendId, setConfirmSendId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data } = useQuery<{ broadcasts: Broadcast[] }>({
    queryKey: ["/api/admin/voice-broadcasts"],
    queryFn: () => fetch("/api/admin/voice-broadcasts", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 8000,
  });

  const { data: usersData } = useQuery<{ total: number }>({
    queryKey: ["/api/admin/voice-broadcast/active-count"],
    queryFn: () =>
      fetch("/api/users?limit=1", { credentials: "include" })
        .then(r => r.json())
        .then(d => ({ total: d.pagination?.total ?? 0 })),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/admin/voice-broadcast/upload", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          contentType: file.type || "audio/ogg",
          label: label.trim() || "Voice Broadcast",
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Upload failed"); }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Voice note uploaded", description: "Ready to send to your clients." });
      setPendingFile(null);
      setPreviewUrl(null);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["/api/admin/voice-broadcasts"] });
    },
    onError: (e: any) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const sendMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/voice-broadcast/${id}/send`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Send failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Sent to ${data.sent} clients`, description: data.failed ? `${data.failed} failed — check Twilio` : "All delivered successfully" });
      setCaption("");
      qc.invalidateQueries({ queryKey: ["/api/admin/voice-broadcasts"] });
    },
    onError: (e: any) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/voice-broadcast/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/voice-broadcasts"] }),
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    e.target.value = "";
  }

  async function handleUpload() {
    if (!pendingFile) return;
    setUploading(true);
    try { await uploadMutation.mutateAsync(pendingFile); }
    finally { setUploading(false); }
  }

  const broadcasts = data?.broadcasts ?? [];

  return (
    <DashboardLayout>
      <div className="space-y-8 max-w-3xl">
        <div>
          <h1 className="text-3xl font-bold font-display mb-1">Voice Broadcasts</h1>
          <p className="text-muted-foreground">Send your voice to every active client on WhatsApp.</p>
        </div>

        {/* Upload card */}
        <Card className="p-6 border-border/50 space-y-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 text-primary rounded-xl">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-semibold text-lg">New Voice Note</h2>
              <p className="text-sm text-muted-foreground">Record on your phone, then upload the file here.</p>
            </div>
          </div>

          <div className="space-y-3">
            <Input
              placeholder="Label (e.g. Week 5 Monday motivation)"
              value={label}
              onChange={e => setLabel(e.target.value)}
              maxLength={120}
            />

            {!pendingFile ? (
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-10 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors">
                <Upload className="w-8 h-8 text-muted-foreground mb-3" />
                <span className="font-medium">Click to choose audio file</span>
                <span className="text-sm text-muted-foreground mt-1">OGG, MP3, MP4, WAV — max 8MB</span>
                <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleFileChange} />
              </label>
            ) : (
              <div className="space-y-3">
                <div className="bg-muted rounded-xl p-4">
                  <p className="text-sm font-medium mb-2 truncate">{pendingFile.name}</p>
                  {previewUrl && <audio controls src={previewUrl} className="w-full" />}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setPendingFile(null); if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
                    Remove
                  </Button>
                  <Button size="sm" onClick={handleUpload} disabled={uploading}>
                    <Upload className="w-4 h-4 mr-2" />
                    {uploading ? "Uploading…" : "Upload & Save"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Saved broadcasts */}
        {broadcasts.length > 0 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-lg">Saved Recordings</h2>

            <div className="mb-3">
              <Input
                placeholder="Optional caption to send with the voice note (e.g. 'This week's message from Coach K 🎙️')"
                value={caption}
                onChange={e => setCaption(e.target.value)}
                maxLength={300}
              />
            </div>

            {broadcasts.map(b => (
              <Card key={b.id} className="p-5 border-border/50">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium truncate">{b.label}</p>
                      {b.sent_at ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full whitespace-nowrap">
                          <CheckCircle2 className="w-3 h-3" /> Sent
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full whitespace-nowrap">
                          <Clock className="w-3 h-3" /> Ready
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{format(new Date(b.created_at), "MMM d, yyyy 'at' h:mm a")}</span>
                      {b.sent_at && (
                        <>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" /> {b.sent_count} clients
                          </span>
                        </>
                      )}
                    </div>
                    <audio controls src={`/api/voice-broadcast/${b.id}/audio`} className="w-full mt-3 max-w-sm" />
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {!b.sent_at && (
                      <Button
                        size="sm"
                        disabled={sendMutation.isPending}
                        onClick={() => setConfirmSendId(b.id)}
                      >
                        <Send className="w-4 h-4 mr-1" />
                        Send
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate(b.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {broadcasts.length === 0 && !pendingFile && (
          <div className="text-center py-16 text-muted-foreground">
            <Mic className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No recordings yet</p>
            <p className="text-sm mt-1">Upload your first voice note above to get started.</p>
          </div>
        )}
      </div>

      {/* Send confirmation dialog */}
      <AlertDialog open={!!confirmSendId} onOpenChange={open => { if (!open) setConfirmSendId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send voice note to all active clients?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send the recording to every active subscriber via WhatsApp right now.
              {caption && <><br /><br />Caption: <em>"{caption}"</em></>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmSendId) sendMutation.mutate(confirmSendId);
                setConfirmSendId(null);
              }}
            >
              <Send className="w-4 h-4 mr-2" /> Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Weekly Recap Section */}
      <WeeklyRecapSection />
    </DashboardLayout>
  );
}

// ─────────────────────────────────────────────
// Weekly Recap Section (cloned voice)
// ─────────────────────────────────────────────

interface RecapLog {
  id: string;
  user_id: string;
  name: string;
  week_start: string;
  message_text: string;
  has_audio: boolean;
  sent_at: string | null;
  created_at: string;
}

function WeeklyRecapSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [testResult, setTestResult] = useState<{ ok: boolean; bytes?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const { data: statusData } = useQuery<{ configured: boolean; quota: { used: number; limit: number } | null; appUrl?: string; appUrlIsHttps?: boolean }>({
    queryKey: ["/api/admin/voice-recap/status"],
    queryFn: () => fetch("/api/admin/voice-recap/status", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 30_000,
  });

  const { data: logsData, isLoading: logsLoading } = useQuery<{ logs: RecapLog[] }>({
    queryKey: ["/api/admin/voice-recap/logs"],
    queryFn: () => fetch("/api/admin/voice-recap/logs?limit=20", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 15_000,
    enabled: !!statusData?.configured,
  });

  const runMutation = useMutation({
    mutationFn: () =>
      fetch("/api/admin/voice-recap/run", { method: "POST", credentials: "include" }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Weekly recaps started", description: "Generating personalized voice notes — check logs for progress." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["/api/admin/voice-recap/logs"] }), 5000);
    },
    onError: (e: any) => toast({ title: "Failed to start", description: e.message, variant: "destructive" }),
  });

  const forceRerunMutation = useMutation({
    mutationFn: () =>
      fetch("/api/admin/voice-recap/force-rerun", { method: "POST", credentials: "include" }).then(r => r.json()),
    onSuccess: (data) => {
      toast({ title: "Force re-run started", description: data.message || "Cleared old recaps and regenerating now." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["/api/admin/voice-recap/logs"] }), 8000);
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const configured = statusData?.configured ?? false;
  const quota = statusData?.quota;
  const logs = logsData?.logs ?? [];

  return (
    <div className="space-y-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-violet-100 text-violet-600 rounded-xl">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">Weekly Voice Recaps</h2>
            <p className="text-sm text-muted-foreground">Personalized weekly check-in in your cloned voice — sent every Sunday night.</p>
          </div>
        </div>
        {configured && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={testing} onClick={async () => {
              setTesting(true); setTestResult(null);
              try {
                const r = await fetch("/api/admin/voice-recap/test-tts", { method: "POST", credentials: "include" });
                const d = await r.json();
                setTestResult(d);
                toast({ title: d.ok ? "ElevenLabs working" : "ElevenLabs failed", description: d.ok ? `Generated ${d.bytes?.toLocaleString()} bytes of audio` : d.error, variant: d.ok ? "default" : "destructive" });
              } catch (e: any) { setTestResult({ ok: false, error: e.message }); }
              finally { setTesting(false); }
            }}>
              {testing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Mic className="w-4 h-4 mr-2" />}
              Test voice
            </Button>
            <Button variant="outline" size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending || forceRerunMutation.isPending}>
              <RefreshCw className={`w-4 h-4 mr-2 ${runMutation.isPending ? "animate-spin" : ""}`} />
              Run now
            </Button>
            <Button variant="destructive" size="sm" onClick={() => forceRerunMutation.mutate()} disabled={runMutation.isPending || forceRerunMutation.isPending}>
              <RefreshCw className={`w-4 h-4 mr-2 ${forceRerunMutation.isPending ? "animate-spin" : ""}`} />
              Force re-run
            </Button>
          </div>
        )}
      </div>

      {!configured ? (
        <Card className="p-6 border-dashed border-border/50 bg-muted/30">
          <div className="flex gap-4 items-start">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <p className="font-medium">ElevenLabs not connected yet</p>
              <p className="text-sm text-muted-foreground">To enable personalized voice recaps, add these two environment variables in Railway:</p>
              <div className="bg-background rounded-lg p-3 font-mono text-xs space-y-1 border border-border">
                <div><span className="text-violet-500">ELEVENLABS_API_KEY</span>=your_api_key_here</div>
                <div><span className="text-violet-500">ELEVENLABS_VOICE_ID</span>=your_voice_id_here</div>
              </div>
              <p className="text-xs text-muted-foreground">Get both from elevenlabs.io → Voices → Coach K</p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-4 border-border/50 space-y-3">
            {quota && (
              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">ElevenLabs quota this month</span>
                  <span className="font-medium">{quota.used.toLocaleString()} / {quota.limit.toLocaleString()} chars used</span>
                </div>
                <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` }} />
                </div>
              </div>
            )}
            {statusData?.appUrl && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Audio URL base</span>
                <span className={`font-mono ${statusData.appUrlIsHttps ? "text-emerald-600" : "text-red-500"}`}>
                  {statusData.appUrl}
                  {!statusData.appUrlIsHttps && " ⚠ not HTTPS — audio won't attach"}
                </span>
              </div>
            )}
            {testResult && (
              <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${testResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                {testResult.ok ? `ElevenLabs OK — ${testResult.bytes?.toLocaleString()} bytes` : `Failed: ${testResult.error}`}
              </div>
            )}
          </Card>

          {logsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-16 bg-muted rounded-xl animate-pulse" />)}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No recaps sent yet. Hit <strong>Run now</strong> to generate the first batch.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {logs.map(log => (
                <Card key={log.id} className="p-4 border-border/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{log.name || "Unknown"}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">Week of {format(new Date(log.week_start), "MMM d")}</span>
                        {log.sent_at ? (
                          <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Sent
                          </span>
                        ) : (
                          <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Generated
                          </span>
                        )}
                        {log.has_audio && (
                          <span className="text-xs text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Mic className="w-3 h-3" /> Voice
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground italic">"{log.message_text}"</p>
                      {log.has_audio && (
                        <audio controls src={`/api/voice-recap/${log.id}/audio`} className="mt-2 h-8 w-full max-w-xs" />
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
