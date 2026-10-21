"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LiveDot } from "@/components/ui/live-dot";
import { cn } from "@/lib/utils";

/**
 * Mic button for the composer: records in the browser (MediaRecorder), sends the clip
 * to /api/transcribe and hands back the text. Works in every current browser, unlike
 * the Web Speech API, and the audio is never stored.
 */

type Phase = "idle" | "recording" | "transcribing";

/** The first container this browser can record: Chrome/Firefox give webm, Safari gives mp4. */
function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const options = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? null;
}

function clock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function VoiceInput({
  disabled,
  maxSeconds,
  beforeStart,
  onText,
  onError,
}: {
  disabled?: boolean;
  maxSeconds: number;
  /** Return false to cancel (e.g. to ask for sign-in first). */
  beforeStart?: () => boolean;
  onText: (text: string) => void;
  onError: (message: string | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discard = useRef(false);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  // Leaving the page mid-recording turns the mic off and drops the clip.
  useEffect(
    () => () => {
      discard.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    },
    [],
  );

  const send = async (blob: Blob, ext: string) => {
    setPhase("transcribing");
    try {
      const form = new FormData();
      form.set("audio", new File([blob], `question.${ext}`, { type: blob.type }));
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || !json.text) onError(json.error ?? "Couldn't transcribe the recording.");
      else onText(json.text);
    } catch {
      onError("Couldn't reach the server to transcribe. Check your connection.");
    } finally {
      setPhase("idle");
    }
  };

  const start = async () => {
    if (beforeStart && !beforeStart()) return;
    onError(null);
    const format = pickMime();
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      onError("This browser can't record audio. Try a recent Chrome, Edge, Firefox or Safari.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      onError(
        name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it in your browser's site settings, then try again."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "Couldn't start the microphone.",
      );
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, { mimeType: format.mime });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      release();
      if (discard.current) return;
      const blob = new Blob(chunks, { type: format.mime.split(";")[0] });
      if (blob.size) void send(blob, format.ext);
      else setPhase("idle");
    };
    recorder.current = rec;
    discard.current = false;
    rec.start();
    setElapsed(0);
    setPhase("recording");
    const began = Date.now();
    timer.current = setInterval(() => {
      const sec = Math.floor((Date.now() - began) / 1000);
      setElapsed(sec);
      if (sec >= maxSeconds && rec.state === "recording") rec.stop();
    }, 250);
  };

  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  const base =
    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50";

  if (phase === "recording")
    return (
      <button
        type="button"
        onClick={stop}
        className={cn(base, "text-foreground hover:bg-accent/50")}
        aria-label={`Stop recording (${clock(elapsed)} of ${clock(maxSeconds)})`}
      >
        <LiveDot className="font-mono tabular-nums">{clock(elapsed)}</LiveDot>
        <Square className="size-3 fill-current" aria-hidden />
        Stop
      </button>
    );

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled || phase === "transcribing"}
      className={cn(base, "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
      aria-label={phase === "transcribing" ? "Transcribing" : "Ask by voice"}
      title="Ask by voice"
    >
      {phase === "transcribing" ? (
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      ) : (
        <Mic className="size-4" aria-hidden />
      )}
      <span className={cn(phase === "idle" && "hidden sm:inline")}>
        {phase === "transcribing" ? "Transcribing…" : "Speak"}
      </span>
    </button>
  );
}
