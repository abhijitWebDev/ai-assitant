"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A live map of the agent graph that plays a scripted run: two research passes,
 * one redraft, then the cited report. Each step lights the agents at work and
 * draws the edge it travelled. It only plays while on screen, and holds a still,
 * fully-lit map for people who ask for reduced motion.
 */

const W = 112; // node width
const H = 34; // node height

type NodeId =
  | "guard"
  | "manager"
  | "planner"
  | "context"
  | "query"
  | "sources"
  | "evidence"
  | "coverage"
  | "synthesis"
  | "critic"
  | "citations"
  | "report";

const NODES: Record<
  NodeId,
  { x: number; y: number; label: string; role: string }
> = {
  guard: {
    x: 70,
    y: 100,
    label: "Guardrail",
    role: "Screens out nonsense and manipulation",
  },
  manager: {
    x: 205,
    y: 100,
    label: "Manager",
    role: "Interprets intent and sets the brief",
  },
  planner: {
    x: 345,
    y: 55,
    label: "Planner",
    role: "Splits the question into sub-questions",
  },
  context: {
    x: 345,
    y: 145,
    label: "Context",
    role: "Loads your documents and past research",
  },
  query: {
    x: 490,
    y: 100,
    label: "Queries",
    role: "Writes search queries per channel",
  },
  sources: {
    x: 630,
    y: 100,
    label: "Sources",
    role: "Searches every channel at once",
  },
  evidence: {
    x: 770,
    y: 100,
    label: "Evidence",
    role: "Extracts, scores and deduplicates",
  },
  coverage: {
    x: 910,
    y: 100,
    label: "Coverage",
    role: "Decides whether there is enough",
  },
  synthesis: {
    x: 910,
    y: 290,
    label: "Synthesis",
    role: "Writes the cited draft",
  },
  critic: { x: 750, y: 290, label: "Critic", role: "Sends weak drafts back" },
  citations: {
    x: 590,
    y: 290,
    label: "Citations",
    role: "Traces every claim to a source",
  },
  report: { x: 420, y: 290, label: "Cited report", role: "What you read" },
};

const SATELLITES = [
  { x: 560, label: "Web" },
  { x: 610, label: "Wikipedia" },
  { x: 660, label: "arXiv" },
  { x: 710, label: "Your docs" },
  { x: 760, label: "Memory" },
].map((s) => ({ ...s, y: 196 }));

/** Edge path between two nodes: straight on a row, an S-curve across rows. */
function edge(a: NodeId, b: NodeId): string {
  const p = NODES[a];
  const q = NODES[b];
  if (p.x === q.x) return `M ${p.x} ${p.y + H / 2} L ${q.x} ${q.y - H / 2}`;
  const dir = q.x > p.x ? 1 : -1;
  const x1 = p.x + (dir * W) / 2;
  const x2 = q.x - (dir * W) / 2;
  if (p.y === q.y) return `M ${x1} ${p.y} L ${x2} ${q.y}`;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${p.y} C ${mx} ${p.y}, ${mx} ${q.y}, ${x2} ${q.y}`;
}

const EDGES = {
  "guard-manager": edge("guard", "manager"),
  "manager-planner": edge("manager", "planner"),
  "manager-context": edge("manager", "context"),
  "planner-query": edge("planner", "query"),
  "context-query": edge("context", "query"),
  "query-sources": edge("query", "sources"),
  "sources-evidence": edge("sources", "evidence"),
  "evidence-coverage": edge("evidence", "coverage"),
  "coverage-synthesis": edge("coverage", "synthesis"),
  "synthesis-critic": edge("synthesis", "critic"),
  "critic-citations": edge("critic", "citations"),
  "citations-report": edge("citations", "report"),
  // The loops: research arcs over the top row, revision dips under the bottom row.
  "coverage-query": `M ${NODES.coverage.x} ${NODES.coverage.y - H / 2} C ${NODES.coverage.x} 8, ${NODES.query.x} 8, ${NODES.query.x} ${NODES.query.y - H / 2}`,
  "critic-synthesis": `M ${NODES.critic.x} ${NODES.critic.y + H / 2} C ${NODES.critic.x} 372, ${NODES.synthesis.x} 372, ${NODES.synthesis.x} ${NODES.synthesis.y + H / 2}`,
} as const;
type EdgeId = keyof typeof EDGES;

const SCRIPT: { active: NodeId[]; via: EdgeId[]; caption: string }[] = [
  {
    active: ["guard"],
    via: [],
    caption: "The guardrail screens the question.",
  },
  {
    active: ["manager"],
    via: ["guard-manager"],
    caption: "The manager reads the intent and sets a brief.",
  },
  {
    active: ["planner", "context"],
    via: ["manager-planner", "manager-context"],
    caption:
      "In parallel: sub-questions are planned while your documents and past research load.",
  },
  {
    active: ["query"],
    via: ["planner-query", "context-query"],
    caption: "Pass 1. Queries are written for every channel.",
  },
  {
    active: ["sources"],
    via: ["query-sources"],
    caption:
      "Web, Wikipedia, arXiv, your files and memory are searched at once.",
  },
  {
    active: ["evidence"],
    via: ["sources-evidence"],
    caption: "Evidence is extracted, scored and deduplicated.",
  },
  {
    active: ["coverage"],
    via: ["evidence-coverage"],
    caption: "Coverage finds a gap, so the loop goes round again.",
  },
  {
    active: ["query"],
    via: ["coverage-query"],
    caption: "Pass 2. New queries aimed at the gap.",
  },
  {
    active: ["sources"],
    via: ["query-sources"],
    caption: "Searching again, only where it is needed.",
  },
  {
    active: ["evidence"],
    via: ["sources-evidence"],
    caption: "Fresh evidence joins the store.",
  },
  {
    active: ["coverage"],
    via: ["evidence-coverage"],
    caption: "Coverage is enough. Time to write.",
  },
  {
    active: ["synthesis"],
    via: ["coverage-synthesis"],
    caption: "Synthesis writes a draft with citations.",
  },
  {
    active: ["critic"],
    via: ["synthesis-critic"],
    caption: "The critic finds a thin claim and sends it back.",
  },
  {
    active: ["synthesis"],
    via: ["critic-synthesis"],
    caption: "Draft 2, grounded in the evidence.",
  },
  {
    active: ["critic"],
    via: ["synthesis-critic"],
    caption: "The critic approves.",
  },
  {
    active: ["citations"],
    via: ["critic-citations"],
    caption: "Every claim is traced back to its source.",
  },
  {
    active: ["report"],
    via: ["citations-report"],
    caption: "Your cited report is ready.",
  },
];

const STEP_MS = 1500;
const HOLD_STEPS = 2; // linger on the finished report before replaying

export default function PipelineMap({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-80px" });
  const still = useReducedMotion() ?? false;
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<NodeId | null>(null);

  useEffect(() => {
    if (still || !inView) return;
    const t = setInterval(
      () => setTick((n) => (n + 1) % (SCRIPT.length + HOLD_STEPS)),
      STEP_MS,
    );
    return () => clearInterval(t);
  }, [still, inView]);

  const step = still ? SCRIPT.length - 1 : Math.min(tick, SCRIPT.length - 1);
  const frame = SCRIPT[step];
  const visited = new Set<NodeId>(
    still
      ? (Object.keys(NODES) as NodeId[])
      : SCRIPT.slice(0, step + 1).flatMap((s) => s.active),
  );
  const travelled = new Set<EdgeId>(
    still
      ? (Object.keys(EDGES) as EdgeId[])
      : SCRIPT.slice(0, step + 1).flatMap((s) => s.via),
  );
  const isActive = (id: NodeId) => !still && frame.active.includes(id);
  const searching = !still && frame.active.includes("sources");
  const passLabel = step >= 7 ? "pass 2" : step >= 3 ? "pass 1" : "";
  const draftLabel = step >= 13 ? "draft 2" : step >= 11 ? "draft 1" : "";
  const shown = hover ? NODES[hover] : null;

  return (
    <div
      ref={ref}
      className={cn("card-chai relative overflow-hidden p-4 sm:p-6", className)}
    >
      <svg
        viewBox="0 -14 1000 420"
        className="h-auto w-full"
        role="img"
        aria-labelledby="pipeline-title pipeline-desc"
      >
        <title id="pipeline-title">The research pipeline</title>
        <desc id="pipeline-desc">
          Eleven agents in sequence: guardrail, manager, planner and context in
          parallel, then a research loop of queries, sources, evidence and
          coverage, then a revision loop of synthesis and critic, then citation
          checking and the cited report.
        </desc>

        {/* Loop captions */}
        <text
          x={700}
          y={4}
          textAnchor="middle"
          className="fill-muted-foreground font-mono text-[11px]"
        >
          research loop{passLabel && ` · ${passLabel}`}
        </text>
        <text
          x={830}
          y={392}
          textAnchor="middle"
          className="fill-muted-foreground font-mono text-[11px]"
        >
          revision loop{draftLabel && ` · ${draftLabel}`}
        </text>

        {/* Legend */}
        <g transform="translate(24 262)" className="text-[11px]">
          <rect width={22} height={12} rx={6} className="fill-background stroke-highlight" strokeWidth={1} />
          <text x={32} y={10} className="fill-muted-foreground">
            working now
          </text>
          <rect y={22} width={22} height={12} rx={6} className="fill-background stroke-foreground/40" strokeWidth={1} />
          <text x={32} y={32} className="fill-muted-foreground">
            done this run
          </text>
          <line x1={0} x2={22} y1={50} y2={50} className="stroke-muted-foreground" strokeWidth={1.25} strokeDasharray="4 5" />
          <text x={32} y={54} className="fill-muted-foreground">
            loops back
          </text>
          <text y={82} className="fill-muted-foreground/70 text-[10px]">
            Hover an agent to see its job
          </text>
        </g>

        {/* Satellite channels around the source processor */}
        {SATELLITES.map((s, i) => (
          <g key={s.label}>
            <path
              d={`M ${NODES.sources.x} ${NODES.sources.y + H / 2} Q ${NODES.sources.x} ${s.y - 30}, ${s.x} ${s.y - 6}`}
              fill="none"
              className={cn(
                "stroke-border transition-colors duration-500",
                searching && "stroke-card-edge-hover",
              )}
              strokeWidth={1}
            />
            <circle
              cx={s.x}
              cy={s.y}
              r={4}
              className={cn(
                "fill-background stroke-muted-foreground transition-colors duration-500",
                searching && "fill-highlight stroke-highlight",
              )}
              style={{ transitionDelay: searching ? `${i * 90}ms` : "0ms" }}
            />
            <text
              x={s.x}
              y={s.y + 20}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {s.label}
            </text>
          </g>
        ))}

        {/* Edges: a faint track, then the travelled ones solid, then the live one drawn in */}
        {(Object.keys(EDGES) as EdgeId[]).map((id) => {
          const loop = id === "coverage-query" || id === "critic-synthesis";
          return (
            <path
              key={id}
              d={EDGES[id]}
              fill="none"
              strokeWidth={1.25}
              strokeDasharray={loop ? "4 5" : undefined}
              className={cn(
                "transition-colors duration-500",
                travelled.has(id) ? "stroke-foreground/35" : "stroke-border",
              )}
            />
          );
        })}
        {!still &&
          frame.via.map((id) => (
            <motion.path
              key={`${step}-${id}`}
              d={EDGES[id]}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              className="stroke-highlight"
              initial={{ pathLength: 0, opacity: 1 }}
              animate={{ pathLength: 1, opacity: [1, 1, 0.35] }}
              transition={{ duration: 0.7, ease: "easeInOut" }}
            />
          ))}

        {/* Nodes */}
        {(Object.keys(NODES) as NodeId[]).map((id) => {
          const n = NODES[id];
          const active = isActive(id);
          const done = visited.has(id);
          const final = id === "report";
          return (
            <g
              key={id}
              transform={`translate(${n.x - W / 2} ${n.y - H / 2})`}
              onPointerEnter={() => setHover(id)}
              onPointerLeave={() => setHover(null)}
              className="cursor-default"
            >
              {active && (
                <motion.rect
                  width={W}
                  height={H}
                  rx={H / 2}
                  fill="none"
                  className="stroke-highlight"
                  strokeWidth={1}
                  initial={{ opacity: 0.8, scale: 1 }}
                  animate={{ opacity: 0, scale: 1.25 }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    ease: "easeOut",
                  }}
                  style={{ transformOrigin: `${W / 2}px ${H / 2}px` }}
                />
              )}
              <rect
                width={W}
                height={H}
                rx={H / 2}
                strokeWidth={1}
                className={cn(
                  "transition-[fill,stroke] duration-500",
                  final && done
                    ? "fill-foreground stroke-foreground"
                    : active
                      ? "fill-background stroke-highlight"
                      : done
                        ? "fill-background stroke-foreground/40"
                        : "fill-background stroke-border",
                )}
              />
              <text
                x={W / 2}
                y={H / 2 + 4}
                textAnchor="middle"
                className={cn(
                  "font-montserrat text-[12px] font-semibold transition-[fill] duration-500",
                  final && done
                    ? "fill-background"
                    : active
                      ? "fill-highlight"
                      : done
                        ? "fill-foreground"
                        : "fill-muted-foreground",
                )}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Caption: the story of the current step, or the role of the hovered agent */}
      <div
        className="mt-2 flex min-h-6 items-center justify-center gap-2 text-center text-sm"
        aria-live="off"
      >
        {shown ? (
          <p>
            <span className="font-montserrat font-semibold">{shown.label}</span>
            <span className="text-muted-foreground">: {shown.role}</span>
          </p>
        ) : (
          <motion.p
            key={still ? "still" : step}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="text-muted-foreground"
          >
            {still ? "Hover an agent to see what it does." : frame.caption}
          </motion.p>
        )}
      </div>
    </div>
  );
}
