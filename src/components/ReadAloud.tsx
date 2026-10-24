"use client";

import { Pause, Play, Square, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Reads a report aloud with the browser's own speech synthesis: free, nothing leaves
 * the device, and it works in Chrome, Edge, Safari and Firefox. Citations, links and
 * the Sources list are left out, since they don't make sense spoken.
 */

type Scope = "summary" | "full";

/** Markdown to plain sentences a voice can read. */
export function speakableText(markdown: string, scope: Scope): string {
  let md = markdown.replace(/\n#{1,3}\s*(Sources|References|Research notes)\b[\s\S]*$/i, "");
  if (scope === "summary") {
    const title = md.match(/^#\s+(.+)$/m)?.[1] ?? "";
    const summary = md.match(/^##\s*Summary\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1];
    // A report without a Summary heading is read from the top.
    md = summary ? `# ${title}\n\n${summary}` : md;
  }
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\[\d+\])+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/^#{1,6}\s*(.+)$/gm, "$1.")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Chrome stops a single long utterance after about 15 seconds, so the text is queued
 * as sentence groups of up to ~220 characters.
 */
function chunks(text: string, max = 220): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** The most natural-sounding voice for the page language, if the browser offers one. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || "en-US").toLowerCase();
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = english.filter((v) => v.lang.toLowerCase() === lang).concat(english);
  return (
    pool.find((v) => /natural|neural|online|enhanced|premium/i.test(v.name)) ??
    pool.find((v) => /google|samantha|daniel|karen|moira/i.test(v.name)) ??
    pool.find((v) => v.default) ??
    pool[0]
  );
}

const noop = () => () => {};
const supported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function ReadAloud({ report, autoPlay }: { report: string; autoPlay?: boolean }) {
  // False on the server and on browsers without speech, so nothing renders there.
  const canSpeak = useSyncExternalStore(noop, supported, () => false);
  const [scope, setScope] = useState<Scope>("summary");
  const [state, setState] = useState<"idle" | "playing" | "paused">("idle");
  const [progress, setProgress] = useState({ at: 0, of: 0 });
  // Bumped on every new playback so callbacks from a cancelled one are ignored.
  const session = useRef(0);
  const texts = useMemo(
    () => ({ summary: speakableText(report, "summary"), full: speakableText(report, "full") }),
    [report],
  );

  const stop = () => {
    session.current++;
    speechSynthesis.cancel();
    setState("idle");
    setProgress({ at: 0, of: 0 });
  };

  const play = (which: Scope = scope) => {
    speechSynthesis.cancel();
    const id = ++session.current;
    const parts = chunks(texts[which]);
    if (!parts.length) return;
    const voice = pickVoice();
    setProgress({ at: 0, of: parts.length });
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = 1;
      u.onstart = () => session.current === id && setProgress({ at: i + 1, of: parts.length });
      u.onend = () => {
        if (session.current === id && i === parts.length - 1) {
          setState("idle");
          setProgress({ at: 0, of: 0 });
        }
      };
      u.onerror = (e) => {
        // "interrupted" and "canceled" are our own stop(); anything else ends playback.
        if (session.current === id && e.error !== "interrupted" && e.error !== "canceled") stop();
      };
      speechSynthesis.speak(u);
    });
    setState("playing");
  };

  const togglePause = () => {
    if (state === "playing") {
      speechSynthesis.pause();
      setState("paused");
    } else {
      speechSynthesis.resume();
      setState("playing");
    }
  };

  // Answer aloud when the question was asked by voice. Voices load asynchronously in
  // Chrome, so wait for them once if the list is still empty.
  const autoPlayed = useRef(false);
  useEffect(() => {
    if (!canSpeak || !autoPlay || autoPlayed.current) return;
    autoPlayed.current = true;
    const go = () => play("summary");
    if (speechSynthesis.getVoices().length) go();
    else speechSynthesis.addEventListener("voiceschanged", go, { once: true });
    return () => speechSynthesis.removeEventListener("voiceschanged", go);
    // play reads the latest texts; this should run once per report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSpeak, autoPlay]);

  // Leaving the report (new run, other thread) stops the voice.
  useEffect(
    () => () => {
      session.current++;
      if (supported()) speechSynthesis.cancel();
    },
    [],
  );

  if (!canSpeak || !texts.full) return null;

  if (state !== "idle")
    return (
      <div className="flex items-center gap-1" role="group" aria-label="Read aloud controls">
        <Button variant="ghost" size="sm" onClick={togglePause} aria-label={state === "playing" ? "Pause reading" : "Resume reading"}>
          {state === "playing" ? <Pause aria-hidden /> : <Play aria-hidden />}
          {state === "playing" ? "Pause" : "Resume"}
        </Button>
        <Button variant="ghost" size="sm" onClick={stop} aria-label="Stop reading">
          <Square className="fill-current" aria-hidden />
          Stop
        </Button>
        <span className="font-mono text-xs text-muted-foreground tabular-nums" aria-live="off">
          {progress.at}/{progress.of}
        </span>
      </div>
    );

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => play()} title={scope === "summary" ? "Read the summary aloud" : "Read the whole report aloud"}>
        <Volume2 aria-hidden />
        Listen
      </Button>
      <div className="flex rounded-md border border-card-edge p-0.5 text-xs" role="radiogroup" aria-label="What to read">
        {(["summary", "full"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={scope === s}
            onClick={() => setScope(s)}
            className={cn(
              "cursor-pointer rounded px-1.5 py-0.5 transition-colors",
              scope === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "summary" ? "Summary" : "Full"}
          </button>
        ))}
      </div>
    </div>
  );
}
