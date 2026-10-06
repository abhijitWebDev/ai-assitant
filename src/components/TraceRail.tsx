"use client";

import { Check, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type StationStatus = "idle" | "running" | "done" | "blocked";
export interface StationState {
  status: StationStatus;
  runs: number;
  message: string;
}

export const STATIONS = [
  { id: "input_guardrail", label: "Input guardrail", role: "Screens out nonsense, off-topic and manipulation" },
  { id: "research_manager", label: "Research manager", role: "Interprets intent and sets the brief" },
  { id: "research_planner", label: "Research planner", role: "Splits the question into sub-questions" },
  { id: "context_manager", label: "Context manager", role: "Loads prior research and your documents" },
  { id: "query_generator", label: "Query generator", role: "Writes search queries per channel" },
  { id: "source_processor", label: "Source processor", role: "Searches the web, your documents and APIs" },
  { id: "evidence_extractor", label: "Evidence extractor", role: "Extracts, scores and deduplicates" },
  { id: "coverage_evaluator", label: "Coverage evaluator", role: "Decides if there is enough evidence" },
  { id: "synthesis", label: "Synthesis", role: "Writes the cited draft" },
  { id: "critic", label: "Critic", role: "Reviews coherence, grounding, completeness" },
  { id: "citation_checker", label: "Citation checker", role: "Traces every claim to a source" },
] as const;

export type StationId = (typeof STATIONS)[number]["id"];

export function emptyStations(): Record<StationId, StationState> {
  return Object.fromEntries(STATIONS.map((s) => [s.id, { status: "idle", runs: 0, message: "" }])) as Record<
    StationId,
    StationState
  >;
}

/** The node on the timeline: a hollow ring, a pulsing dot, a tick or a cross. */
function Node({ status }: { status: StationStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border bg-background transition-colors duration-300",
        status === "idle" && "border-border",
        status === "running" && "border-foreground/60",
        status === "done" && "border-green-600/40 text-green-700 dark:border-green-400/40 dark:text-green-400",
        status === "blocked" && "border-red-600/40 text-red-700 dark:border-red-400/40 dark:text-red-400",
      )}
    >
      {status === "running" && (
        <>
          <span className="absolute size-full rounded-full bg-foreground/25 motion-safe:animate-ping" />
          <span className="size-1.5 rounded-full bg-foreground" />
        </>
      )}
      {status === "done" && <Check className="size-3" strokeWidth={3} />}
      {status === "blocked" && <X className="size-3" strokeWidth={3} />}
    </span>
  );
}

function Station({ id, state }: { id: StationId; state: StationState }) {
  const meta = STATIONS.find((s) => s.id === id)!;
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <Node status={state.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "font-montserrat text-sm font-semibold transition-colors duration-300",
              state.status === "idle" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {meta.label}
          </span>
          {state.runs > 1 && (
            <span className="shrink-0 font-mono text-[11px] text-highlight" title={`Ran ${state.runs} times`}>
              ×{state.runs}
            </span>
          )}
        </div>
        <p className="text-xs leading-snug text-muted-foreground">
          {state.status === "running" ? "Working…" : state.message || meta.role}
        </p>
      </div>
    </li>
  );
}

/** A loop drawn as a dashed bracket with its pass counter. */
function Loop({
  title,
  detail,
  active,
  children,
}: {
  title: string;
  detail?: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative z-10 -ml-2 mb-4 rounded-lg border border-dashed bg-background/60 p-2 pl-2 transition-colors duration-300",
        active ? "border-card-edge-hover" : "border-card-edge",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2 pl-1 text-xs">
        <span className={cn("inline-flex items-center gap-1.5 font-medium", active ? "text-highlight" : "text-muted-foreground")}>
          <RotateCw className={cn("size-3", active && "motion-safe:animate-spin [animation-duration:3s]")} aria-hidden />
          {title}
        </span>
        {detail && <span className="font-mono text-[11px] text-muted-foreground">{detail}</span>}
      </div>
      <ul>{children}</ul>
    </div>
  );
}

export default function TraceRail({
  stations,
  researchPass,
  maxPasses,
  draftNumber,
  maxDrafts,
  status,
}: {
  stations: Record<StationId, StationState>;
  researchPass: number;
  maxPasses: number;
  draftNumber: number;
  maxDrafts: number;
  status: string;
}) {
  const s = (id: StationId) => <Station key={id} id={id} state={stations[id]} />;
  const researchActive = ["query_generator", "source_processor", "evidence_extractor", "coverage_evaluator"].some(
    (id) => stations[id as StationId].status === "running",
  );
  const revisionActive = ["synthesis", "critic"].some((id) => stations[id as StationId].status === "running");
  const done = Object.values(stations).filter((x) => x.status === "done").length;

  return (
    <section aria-label="Agent pipeline">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-montserrat text-base font-semibold">Agent pipeline</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {done}/{STATIONS.length}
        </span>
      </div>
      <div className="mt-2 h-px w-full overflow-hidden bg-border">
        <div
          className="h-full bg-foreground/70 transition-[width] duration-500 ease-out"
          style={{ width: `${(done / STATIONS.length) * 100}%` }}
        />
      </div>
      <p className="mt-3 mb-5 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
        {status}
      </p>

      {/* The spine runs behind every node. */}
      <div className="relative">
        <span aria-hidden className="absolute top-2 bottom-2 left-[9.5px] w-px bg-border" />
        <ul>
          {s("input_guardrail")}
          {s("research_manager")}
        </ul>
        <div className="relative z-10 -ml-2 mb-4 rounded-lg border border-dashed border-card-edge bg-background/60 p-2">
          <p className="mb-2 pl-1 text-xs font-medium text-muted-foreground">In parallel</p>
          <div className="grid gap-x-3 sm:grid-cols-2 xl:grid-cols-1">
            <ul>{s("research_planner")}</ul>
            <ul className="max-sm:pt-4 xl:pt-4">{s("context_manager")}</ul>
          </div>
        </div>
        <Loop
          title="Research loop"
          detail={researchPass ? `pass ${researchPass} of ${maxPasses}` : `up to ${maxPasses} passes`}
          active={researchActive}
        >
          {s("query_generator")}
          {s("source_processor")}
          {s("evidence_extractor")}
          {s("coverage_evaluator")}
        </Loop>
        <Loop
          title="Revision loop"
          detail={draftNumber ? `draft ${draftNumber} of ${maxDrafts}` : `up to ${maxDrafts} drafts`}
          active={revisionActive}
        >
          {s("synthesis")}
          {s("critic")}
        </Loop>
        <ul>{s("citation_checker")}</ul>
      </div>
    </section>
  );
}
