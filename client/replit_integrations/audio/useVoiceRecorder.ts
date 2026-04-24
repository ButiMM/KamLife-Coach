/**
 * React hook for voice recording using MediaRecorder API.
 * Negotiates the best supported MIME type across Chrome, Firefox, Safari, and iOS.
 */
import { useRef, useCallback, useState } from "react";

export type RecordingState = "idle" | "recording" | "stopped";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

function getSupportedMime(): string {
  for (const mime of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

export function useVoiceRecorder() {
  const [state, setState] = useState<RecordingState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resolvedMimeRef = useRef<string>("");

  const startRecording = useCallback(async (): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = getSupportedMime();
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);

    resolvedMimeRef.current = recorder.mimeType || mime;
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start(100);
    setState("recording");
  }, []);

  const stopRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== "recording") {
        resolve(new Blob());
        return;
      }

      recorder.onstop = () => {
        const blobType = resolvedMimeRef.current || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: blobType });
        recorder.stream.getTracks().forEach((t) => t.stop());
        setState("stopped");
        resolve(blob);
      };

      recorder.stop();
    });
  }, []);

  return { state, startRecording, stopRecording };
}
