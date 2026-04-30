import { useState, useRef } from "react";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Mic, Upload, Send, Trash2, CheckCircle2, Clock, Users } from "lucide-react";
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
    </DashboardLayout>
  );
}
