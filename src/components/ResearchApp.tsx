"use client";

import {
  ArrowUpRight,
  BatteryCharging,
  BrainCircuit,
  CalendarDays,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  RotateCw,
  Square,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "@/lib/agent/run";
import type {
  EvidenceChunk,
  GuardrailResult,
  LogEntry,
  ToolError,
} from "@/lib/agent/types";
import { AnimatedBadge } from "@/components/animated-badge";
import { Backdrop } from "@/components/backdrop";
import { MenuToggle } from "@/components/menu-toggle";
import { RotatingWord } from "@/components/rotating-word";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { LiveDot } from "@/components/ui/live-dot";
import {
  StatStrip,
  TypewriterHint,
  useSpotlight,
} from "@/components/landing-bits";
import PipelineMap from "./PipelineMap";
import { cn } from "@/lib/utils";
import ReportView, { type ReportMeta } from "./ReportView";
import TraceRail, {
  emptyStations,
  type StationId,
  type StationState,
} from "./TraceRail";

interface Thread {
  id: string;
  title: string;
  updated_at: string;
  report_count: number;
  doc_count: number;
}
interface SavedReport {
  id: string;
  question: string;
  report: string;
  created_at: string;
  evidence: EvidenceChunk[];
  meta: ReportMeta & { errors?: ToolError[] };
}
interface Doc {
  id: string;
  name: string;
  chars: number;
}
interface AppConfig {
  config: {
    provider: string;
    smartModel: string;
    fastModel: string;
    vector?: boolean;
    limits: { maxResearchIterations: number; maxRevisions: number };
  };
  keys: { llm: boolean; tavily: boolean };
}
type PendingDelete = {
  kind: "thread" | "doc";
  id: string;
  name: string;
} | null;

const EXAMPLES = [
  {
    topic: "AI",
    icon: BrainCircuit,
    question:
      "What are the key differences between RAG and fine-tuning for adapting LLMs to specific domains?",
  },
  {
    topic: "Energy",
    icon: BatteryCharging,
    question:
      "How do solid-state batteries compare with lithium-ion on energy density, safety and cost today?",
  },
  {
    topic: "Work",
    icon: CalendarDays,
    question:
      "What does the evidence say about four-day work weeks and productivity?",
  },
];

const EXAMPLE_QUESTIONS = EXAMPLES.map((e) => e.question);

/** Which stations become active after `node` finishes — mirrors the edges in graph.ts. */
function nextStations(
  node: string,
  snap: Extract<RunEvent, { type: "node" }>["snapshot"],
  done: Set<string>,
): StationId[] {
  switch (node) {
    case "input_guardrail":
      return snap.guardrailAllowed === false ? [] : ["research_manager"];
    case "research_manager":
      return ["research_planner", "context_manager"];
    case "research_planner":
    case "context_manager":
      return done.has("research_planner") && done.has("context_manager")
        ? ["query_generator"]
        : [];
    case "query_generator":
      return ["source_processor"];
    case "source_processor":
      return ["evidence_extractor"];
    case "evidence_extractor":
      return ["coverage_evaluator"];
    case "coverage_evaluator":
      return snap.coverageStatus === "missing"
        ? ["query_generator"]
        : ["synthesis"];
    case "synthesis":
      return ["critic"];
    case "critic":
      return snap.critique?.verdict === "revision_needed"
        ? ["synthesis"]
        : ["citation_checker"];
    default:
      return [];
  }
}

const newId = () => crypto.randomUUID();

/** Fades and lifts into place once, the first time it scrolls into view. */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

export default function ResearchApp() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string>(() => newId());
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastRunReport, setLastRunReport] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [qFocused, setQFocused] = useState(false);
  const spotlight = useSpotlight();

  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [stations, setStations] =
    useState<Record<StationId, StationState>>(emptyStations);
  const [status, setStatus] = useState("Waiting for a question.");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [pass, setPass] = useState(0);
  const [draftNo, setDraftNo] = useState(0);
  const [blocked, setBlocked] = useState<GuardrailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);

  const maxPasses = (cfg?.config.limits.maxResearchIterations ?? 2) + 1;
  const maxDrafts = (cfg?.config.limits.maxRevisions ?? 2) + 1;

  const loadThreads = useCallback(async () => {
    const r = await fetch("/api/threads").then((r) => r.json());
    setThreads(r.threads);
  }, []);

  const loadThread = useCallback(async (id: string) => {
    const r = await fetch(`/api/threads/${id}`).then((r) => r.json());
    setReports(r.reports);
    setDocs(r.documents);
    return r.reports as SavedReport[];
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => null);
    fetch("/api/threads")
      .then((r) => r.json())
      .then((r) => setThreads(r.threads))
      .catch(() => null);
  }, []);

  // The header is transparent at the top and blurs once the page scrolls.
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 0);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  const openThread = async (id: string) => {
    if (running) return;
    setThreadId(id);
    setDrawer(false);
    resetRun();
    const rs = await loadThread(id);
    setSelected(rs[0]?.id ?? null);
  };

  const newThread = () => {
    if (running) return;
    setThreadId(newId());
    setReports([]);
    setDocs([]);
    setSelected(null);
    setQuestion("");
    setDrawer(false);
    resetRun();
  };

  function resetRun() {
    setStations(emptyStations());
    setLog([]);
    setDraft("");
    setPass(0);
    setDraftNo(0);
    setBlocked(null);
    setError(null);
    setStatus("Waiting for a question.");
  }

  const start = async (q = question) => {
    const text = q.trim();
    if (!text || running) return;
    resetRun();
    setQuestion(text);
    setSelected(null);
    setRunning(true);
    setStatus("Screening the question…");
    setStations((s) => ({
      ...s,
      input_guardrail: { ...s.input_guardrail, status: "running" },
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    const done = new Set<string>();

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, threadId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
        );

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "");
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as RunEvent;
          handleEvent(ev, done);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : String(err));
      else setStatus("Stopped.");
      setStations((s) => {
        const copy = { ...s };
        for (const k of Object.keys(copy) as StationId[])
          if (copy[k].status === "running")
            copy[k] = { ...copy[k], status: "idle" };
        return copy;
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
      loadThreads();
    }
  };

  function handleEvent(ev: RunEvent, done: Set<string>) {
    if (ev.type === "node") {
      done.add(ev.node);
      if (ev.node === "query_generator") setPass((p) => p + 1);
      if (ev.node === "synthesis") setDraftNo((d) => d + 1);
      if (ev.snapshot.draftReport) setDraft(ev.snapshot.draftReport);
      setLog((l) => [...l, ...ev.log]);
      const message = ev.log.at(-1)?.message ?? "";
      const next = nextStations(ev.node, ev.snapshot, done);
      setStations((s) => {
        const copy = { ...s };
        const id = ev.node as StationId;
        if (copy[id])
          copy[id] = { status: "done", runs: copy[id].runs + 1, message };
        for (const n of next) copy[n] = { ...copy[n], status: "running" };
        return copy;
      });
      if (next.length) {
        const label = next.map((n) => n.replace(/_/g, " ")).join(" and ");
        setStatus(`${message}. Now: ${label}.`);
      }
    } else if (ev.type === "blocked") {
      setBlocked(ev.guardrail);
      setStatus("The question was not accepted.");
      setStations((s) => ({
        ...s,
        input_guardrail: {
          status: "blocked",
          runs: 1,
          message: ev.guardrail.category.replace("_", " "),
        },
      }));
    } else if (ev.type === "done") {
      setStatus(`Report ready in ${Math.round(ev.durationMs / 1000)} seconds.`);
      setLastRunReport(ev.reportId);
      loadThread(threadId).then(() => setSelected(ev.reportId));
    } else if (ev.type === "error") {
      setError(ev.message);
    }
  }

  const stop = () => abortRef.current?.abort();

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.set("threadId", threadId);
      form.set("file", file);
      const r = await fetch("/api/documents", {
        method: "POST",
        body: form,
      }).then((r) => r.json());
      if (r.error) setUploadError(r.error);
      else {
        setDocs(r.documents);
        if (r.warning) setUploadError(r.warning);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    loadThreads();
  };

  const removeDoc = async (id: string) => {
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    setDocs((d) => d.filter((x) => x.id !== id));
  };

  const removeThread = async (id: string) => {
    await fetch(`/api/threads/${id}`, { method: "DELETE" });
    if (id === threadId) newThread();
    loadThreads();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "thread") await removeThread(pendingDelete.id);
    else await removeDoc(pendingDelete.id);
    setPendingDelete(null);
  };

  const pickExample = (q: string) => {
    setQuestion(q);
    window.scrollTo({ top: 0, behavior: "smooth" });
    questionRef.current?.focus({ preventScroll: true });
  };

  const current = reports.find((r) => r.id === selected);
  const showRail = running || log.length > 0 || blocked;
  const empty = !running && !current && !draft && !blocked && !error;

  /* ---------------- header ---------------- */
  const header = (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[backdrop-filter,background] duration-300",
        scrolled ? "bg-background/60 backdrop-blur-md" : "bg-transparent",
      )}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-5 px-6 py-5 sm:px-12">
        <button
          onClick={newThread}
          disabled={running}
          className="inline-flex items-center gap-2 font-onest text-xl font-medium tracking-tight disabled:cursor-default"
          aria-label="Research Desk, start a new thread"
        >
          <span className="grid size-8 place-items-center rounded-md border border-card-edge-hover">
            <Telescope className="size-4" aria-hidden />
          </span>
          Research Desk
        </button>
        <div className="flex items-center gap-1">
          {cfg?.config.vector && (
            <LiveDot
              tone="success"
              className="mr-3 hidden md:inline-flex"
              title="Semantic memory on LanceDB is connected"
            >
              Memory on
            </LiveDot>
          )}
          {cfg && (
            <span className="mr-2 hidden rounded border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground md:inline">
              {cfg.config.provider} · {cfg.config.smartModel}
            </span>
          )}
          <ThemeSwitcher />
          <MenuToggle
            open={drawer}
            onClick={() => setDrawer(true)}
            aria-label="Threads and reports"
          />
        </div>
      </nav>
    </header>
  );

  /* ---------------- composer ---------------- */
  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
      className={cn(
        "card-chai mx-auto w-full max-w-3xl p-2 focus-within:border-card-edge-hover",
        empty && "sm:p-3",
      )}
    >
      <label htmlFor="q" className="sr-only">
        Research question
      </label>
      <div className="relative">
        {empty && !question && !qFocused && (
          <TypewriterHint
            lines={EXAMPLE_QUESTIONS}
            className="absolute inset-x-0 top-0 line-clamp-2 px-3 py-2.5 text-base leading-relaxed text-muted-foreground sm:text-lg"
          />
        )}
        <textarea
          id="q"
          ref={questionRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
          }}
          rows={empty ? 3 : 2}
          disabled={running}
          onFocus={() => setQFocused(true)}
          onBlur={() => setQFocused(false)}
          placeholder={
            empty && !qFocused
              ? ""
              : "Ask a question that needs sources to answer well."
          }
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-70 sm:text-lg"
        />
      </div>

      {docs.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 px-3 pb-2"
          aria-label="Documents in this thread"
        >
          {docs.map((d) => (
            <li key={d.id}>
              <Chip className="max-w-56 gap-1.5 py-1 pr-1">
                <FileText className="size-3 shrink-0" aria-hidden />
                <span className="truncate" title={d.name}>
                  {d.name}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingDelete({ kind: "doc", id: d.id, name: d.name })
                  }
                  disabled={running}
                  className="grid size-4 cursor-pointer place-items-center rounded hover:text-foreground"
                  aria-label={`Remove ${d.name}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </Chip>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-card-edge px-1 pt-2">
        <label
          className={cn(
            "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
            (uploading || running) && "pointer-events-none opacity-50",
          )}
        >
          {uploading ? (
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Paperclip className="size-4" aria-hidden />
          )}
          {uploading ? "Reading file…" : "Add documents"}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.markdown"
            className="sr-only"
            onChange={(e) => upload(e.target.files)}
            disabled={uploading || running}
          />
        </label>
        <span className="hidden text-xs text-muted-foreground lg:inline">
          PDF, DOCX, TXT or Markdown
        </span>
        <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
            Ctrl
          </kbd>
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
            Enter
          </kbd>
        </span>
        <span className="ml-auto sm:ml-1">
          {running ? (
            <Button type="button" variant="outline" onClick={stop}>
              <Square className="size-3.5 fill-current" aria-hidden />
              Stop research
            </Button>
          ) : (
            <Button type="submit" variant="solid" disabled={!question.trim()}>
              Start research
            </Button>
          )}
        </span>
      </div>
      {uploadError && (
        <p className="px-3 pt-2 text-xs text-red-700 dark:text-red-400">
          {uploadError}
        </p>
      )}
    </form>
  );

  /* ---------------- drawer ---------------- */
  const drawerBody = (
    <nav
      aria-label="Research threads"
      className="flex min-h-0 flex-1 flex-col gap-6"
    >
      <Button
        variant="soft"
        onClick={newThread}
        disabled={running}
        className="w-full"
      >
        <Plus aria-hidden />
        New thread
      </Button>

      {reports.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            Reports in this thread
          </h3>
          <ul className="space-y-1">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => {
                    setSelected(r.id);
                    setDrawer(false);
                  }}
                  className={cn(
                    "w-full cursor-pointer rounded-md border px-3 py-2 text-left text-sm leading-snug transition-colors",
                    r.id === selected
                      ? "border-card-edge-hover text-highlight"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="line-clamp-2">{r.question}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="min-h-0 flex-1">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          All threads
        </h3>
        {threads.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Your research threads will appear here.
          </p>
        )}
        <ul className="space-y-1">
          {threads.map((t) => (
            <li key={t.id} className="group flex items-start gap-1">
              <button
                onClick={() => openThread(t.id)}
                className={cn(
                  "min-w-0 flex-1 cursor-pointer rounded-md border px-3 py-2 text-left text-sm leading-snug transition-colors",
                  t.id === threadId
                    ? "border-card-edge-hover"
                    : "border-transparent hover:border-card-edge",
                )}
              >
                <span
                  className={cn(
                    "line-clamp-2",
                    t.id === threadId ? "font-medium" : "text-foreground/80",
                  )}
                >
                  {t.title}
                </span>
                <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
                  {t.report_count} report{t.report_count === 1 ? "" : "s"}
                  {t.doc_count
                    ? `, ${t.doc_count} doc${t.doc_count === 1 ? "" : "s"}`
                    : ""}
                </span>
              </button>
              <button
                onClick={() =>
                  setPendingDelete({ kind: "thread", id: t.id, name: t.title })
                }
                className="mt-1.5 grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity hover:text-red-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:text-red-400"
                aria-label={`Delete thread ${t.title}`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  );

  /* ---------------- landing sections ---------------- */
  const stages = [
    {
      n: "01",
      title: "Understand",
      body: "Screens the question, sets a brief and splits it into sub-questions, with your documents loaded.",
      agents: [
        "Input guardrail",
        "Research manager",
        "Research planner",
        "Context manager",
      ],
    },
    {
      n: "02",
      title: "Search",
      body: "Writes queries, searches the web, Wikipedia, arXiv and your files, then scores what comes back.",
      agents: [
        "Query generator",
        "Source processor",
        "Evidence extractor",
        "Coverage evaluator",
      ],
      loop: `Repeats until coverage is enough, up to ${maxPasses} passes`,
    },
    {
      n: "03",
      title: "Write",
      body: "Drafts a cited report, and a critic sends it back if it is not coherent, grounded and complete.",
      agents: ["Synthesis", "Critic"],
      loop: `Redrafts up to ${maxDrafts} times`,
    },
    {
      n: "04",
      title: "Verify",
      body: "Traces every claim back to the evidence it cites before the report reaches you.",
      agents: ["Citation checker"],
    },
  ];

  const landing = (
    <>
      <section className="mx-auto mt-6 flex max-w-4xl flex-col items-center gap-y-4 text-center sm:mt-10">
        <AnimatedBadge>11 agents, one cited report</AnimatedBadge>
        <h1 className="text-[42px] leading-[1.05] font-semibold tracking-tight md:text-6xl lg:text-7xl">
          Ask once. Get answers
          <br className="hidden sm:block" /> you can{" "}
          <RotatingWord
            words={["trust", "cite", "verify", "share"]}
            className="font-montserrat text-highlight"
          />
        </h1>
        <p className="mt-2 max-w-2xl text-base text-neutral-700 md:text-xl dark:text-neutral-400">
          Agents plan the question, search the web and your files, argue with
          the draft and{" "}
          <span className="highlight">trace every claim to a source</span>{" "}
          before you read a word.
        </p>
      </section>

      <div className="mt-10 sm:mt-12">{composer}</div>

      <Reveal className="mt-8">
        <StatStrip
          stats={[
            { value: 11, label: "agents" },
            { value: 5, label: "source channels" },
            { value: 2, label: "self-correcting loops" },
            { value: maxPasses, label: "research passes, at most" },
          ]}
        />
      </Reveal>

      <section className="mt-20 sm:mt-24" aria-labelledby="examples">
        <h2 id="examples" className="text-2xl font-medium sm:text-[30px]">
          Try one of these
        </h2>
        <p className="text-neutral-600 sm:text-lg dark:text-neutral-300">
          Pick a question to{" "}
          <span className="highlight">start in one click</span>, or edit it
          first.
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {EXAMPLES.map((ex, i) => (
            <Reveal key={ex.question} delay={i * 0.08}>
              <button
                onClick={() => pickExample(ex.question)}
                onPointerMove={spotlight}
                className="card-chai spotlight group flex h-full w-full cursor-pointer flex-col gap-4 p-5 text-left sm:opacity-90 sm:hover:opacity-100"
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-md border border-card-edge text-muted-foreground transition-colors duration-300 group-hover:text-foreground">
                    <ex.icon className="size-4.5" aria-hidden />
                  </span>
                  <Chip>{ex.topic}</Chip>
                </div>
                <p className="font-montserrat text-base leading-snug font-medium">
                  {ex.question}
                </p>
                <span className="mt-auto inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors group-hover:text-brand">
                  Use this question
                  <ArrowUpRight
                    className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    aria-hidden
                  />
                </span>
              </button>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mt-20 sm:mt-24" aria-labelledby="how">
        <h2 id="how" className="text-2xl font-medium sm:text-[30px]">
          How a question becomes a report
        </h2>
        <p className="text-neutral-600 sm:text-lg dark:text-neutral-300">
          Four stages, two of them loops, so the agents{" "}
          <span className="highlight">look again before they write</span>.
        </p>
        <Reveal className="mt-8 hidden lg:block">
          <PipelineMap />
        </Reveal>
        <ol className="relative mt-8 grid gap-4 md:grid-cols-2 lg:mt-4 lg:grid-cols-4">
          {/* The thread that ties the stages together on wide screens. */}
          <span
            aria-hidden
            className="absolute top-[30px] right-8 left-8 hidden h-px bg-linear-to-r from-transparent via-card-edge-hover to-transparent lg:block"
          />
          {stages.map((st, i) => (
            <Reveal key={st.n} delay={i * 0.1}>
              <li
                onPointerMove={spotlight}
                className="card-chai spotlight relative flex h-full flex-col gap-3 bg-background/70 p-5 sm:opacity-90 sm:hover:opacity-100"
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-7 place-items-center rounded-full border border-card-edge-hover bg-background font-mono text-[11px] text-muted-foreground">
                    {st.n}
                  </span>
                  {st.loop && (
                    <RotateCw
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                </div>
                <h3 className="font-montserrat text-lg font-semibold">
                  {st.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {st.body}
                </p>
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  {st.agents.map((a) => (
                    <Chip key={a}>{a}</Chip>
                  ))}
                </div>
                {st.loop && (
                  <p className="text-xs text-muted-foreground italic">
                    {st.loop}
                  </p>
                )}
              </li>
            </Reveal>
          ))}
        </ol>
      </section>
    </>
  );

  /* ---------------- results ---------------- */
  const results = (
    <>
      <div className="mt-2">{composer}</div>
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {showRail && (
          <aside className="card-chai p-5 lg:sticky lg:top-24 lg:order-2 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto">
            <TraceRail
              stations={stations}
              researchPass={pass}
              maxPasses={maxPasses}
              draftNumber={draftNo}
              maxDrafts={maxDrafts}
              status={status}
            />
          </aside>
        )}
        <div
          className={cn(
            "min-w-0 space-y-4 lg:order-1",
            !showRail && "lg:col-span-2",
          )}
        >
          {blocked && (
            <div
              className="rounded-xl border border-red-600/30 px-5 py-4 dark:border-red-400/30"
              role="alert"
            >
              <p className="font-montserrat font-semibold text-red-700 dark:text-red-400">
                Question not accepted
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {blocked.message}
              </p>
            </div>
          )}
          {error && (
            <div
              className="rounded-xl border border-red-600/30 px-5 py-4 dark:border-red-400/30"
              role="alert"
            >
              <p className="font-montserrat font-semibold text-red-700 dark:text-red-400">
                The run stopped with an error
              </p>
              <p className="mt-1 text-sm">{error}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Check the terminal running the dev server for details, then try
                again.
              </p>
            </div>
          )}

          {(current || draft || running) && (
            <div className="card-chai p-5 sm:p-8">
              {current ? (
                <ReportView
                  key={current.id}
                  report={current.report}
                  evidence={current.evidence}
                  log={current.id === lastRunReport ? log : []}
                  errors={current.meta.errors ?? []}
                  meta={current.meta}
                />
              ) : draft ? (
                <ReportView
                  report={draft}
                  evidence={[]}
                  log={log}
                  errors={[]}
                  meta={{}}
                  live
                />
              ) : (
                <div aria-busy="true">
                  <p className="max-w-[60ch] text-muted-foreground">
                    The report will appear here as soon as{" "}
                    <span className="highlight">
                      the first draft is written
                    </span>
                    . Follow the agents on the pipeline as they work.
                  </p>
                  <div className="mt-8 space-y-3" aria-hidden>
                    {[
                      "w-2/3 h-7",
                      "w-full",
                      "w-11/12",
                      "w-4/5",
                      "w-full",
                      "w-3/5",
                    ].map((w, i) => (
                      <div
                        key={i}
                        className={cn(
                          "h-3 rounded bg-foreground/[0.06] motion-safe:animate-pulse",
                          w,
                        )}
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-screen">
        <Backdrop />
        {header}

        <main className="mx-auto max-w-6xl px-6 pb-24 sm:px-12">
          {cfg && (!cfg.keys.llm || !cfg.keys.tavily) && (
            <div className="mx-auto mb-6 max-w-3xl rounded-xl border border-yellow-600/30 px-4 py-3 text-sm dark:border-yellow-400/30">
              {!cfg.keys.llm && (
                <p>
                  <span className="font-semibold text-yellow-800 dark:text-yellow-400">
                    No language model key found.
                  </span>{" "}
                  Add an API key for{" "}
                  <code className="font-mono">{cfg.config.provider}</code> to{" "}
                  <code className="font-mono">.env.local</code> and restart the
                  dev server.
                </p>
              )}
              {!cfg.keys.tavily && (
                <p>
                  No <code className="font-mono">TAVILY_API_KEY</code> set. Web
                  search will fall back to SerpAPI, Brave or DuckDuckGo.
                </p>
              )}
            </div>
          )}

          {empty ? landing : results}
        </main>

        <footer className="relative px-6 font-montserrat before:absolute before:top-0 before:left-1/2 before:h-px before:w-full before:max-w-[1440px] before:-translate-x-1/2 before:bg-amber-600 before:opacity-10 before:[mask-image:linear-gradient(90deg,transparent_0%,black_40%,black_60%,transparent_100%)] sm:px-12 dark:before:bg-orange-300">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="font-onest text-base font-medium text-foreground">
              Research Desk
            </span>
            <span>LangGraph agents, Tavily search, every claim cited.</span>
          </div>
        </footer>
      </div>

      <Drawer open={drawer} onOpenChange={setDrawer}>
        <DrawerContent
          side="right"
          title="Your research"
          description="Threads keep their reports and documents together."
        >
          {drawerBody}
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === "thread"
            ? "Delete this thread?"
            : "Remove this document?"
        }
        confirmLabel={
          pendingDelete?.kind === "thread" ? "Delete thread" : "Remove document"
        }
        cancelLabel="Keep it"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingDelete?.kind === "thread" ? (
          <p>
            “{pendingDelete.name}” and all of its reports and documents will be
            deleted for good. This cannot be undone.
          </p>
        ) : (
          <p>
            “{pendingDelete?.name}” will be removed from this thread, and future
            research here will no longer search it. Reports already written keep
            their citations.
          </p>
        )}
      </ConfirmDialog>
    </MotionConfig>
  );
}
