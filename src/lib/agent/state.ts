import { Annotation } from "@langchain/langgraph";
import { config } from "../config";
import { similarity } from "../text";
import type {
  CitationReport,
  CritiqueResult,
  EvidenceChunk,
  GuardrailResult,
  LogEntry,
  PlannedQuery,
  RawResult,
  ToolError,
} from "./types";

/**
 * Selective-storage reducer for the evidence store (guide §9.5).
 * Like operator.add it appends, but it also:
 *   1. drops chunks under the relevance threshold
 *   2. deduplicates near-identical passages (keeps the higher score)
 *   3. evicts the lowest-scoring chunks once the store is over its size limit
 * Nodes reset it with `new Overwrite([])` at the start of a run.
 */
export function mergeEvidence(existing: EvidenceChunk[], incoming: EvidenceChunk[]): EvidenceChunk[] {
  const store = [...existing];
  for (const chunk of incoming) {
    if (chunk.score < config.limits.minRelevance) continue;
    const dupIndex = store.findIndex(
      (e) => (e.url === chunk.url && e.content === chunk.content) || similarity(e.content, chunk.content) > 0.6,
    );
    if (dupIndex >= 0) {
      if (chunk.score > store[dupIndex].score) store[dupIndex] = chunk;
      continue;
    }
    store.push(chunk);
  }
  if (store.length <= config.limits.maxEvidence) return store;
  // Evict lowest scores but keep original insertion order for the survivors.
  const keep = new Set(
    [...store]
      .sort((a, b) => b.score - a.score)
      .slice(0, config.limits.maxEvidence)
      .map((e) => e.id),
  );
  return store.filter((e) => keep.has(e.id));
}

const append = <T>(a: T[], b: T[]) => a.concat(b);
const last = <T>(fallback: T) => ({ reducer: (_: T, b: T) => b, default: () => fallback });

/**
 * ResearchState: the shared notebook every agent reads from and writes to.
 * Mirrors the guide's TypedDict, plus fields the production section asks for.
 */
export const ResearchState = Annotation.Root({
  /** Raw user question. */
  question: Annotation<string>(last("")),
  /** Research Manager's interpretation: objective, scope, audience. */
  researchBrief: Annotation<string>(last("")),
  guardrail: Annotation<GuardrailResult | null>(last<GuardrailResult | null>(null)),

  /** Internal agent log (the guide's `messages`). Appends across nodes. */
  messages: Annotation<LogEntry[]>({ reducer: append, default: () => [] }),

  /** Sub-questions from the Research Planner. */
  researchQuestions: Annotation<string[]>(last<string[]>([])),
  /** Prior reports + private-doc inventory loaded by the Context Manager. */
  priorContext: Annotation<string>(last("")),

  pendingQueries: Annotation<PlannedQuery[]>(last<PlannedQuery[]>([])),
  rawResults: Annotation<RawResult[]>(last<RawResult[]>([])),
  /** Every query already sent, so loops never repeat themselves. */
  queryHistory: Annotation<string[]>({ reducer: append, default: () => [] }),

  evidenceStore: Annotation<EvidenceChunk[]>({ reducer: mergeEvidence, default: () => [] }),

  coverageStatus: Annotation<"missing" | "sufficient" | "">(last<"missing" | "sufficient" | "">("")),
  gapAnalysis: Annotation<string>(last("")),
  iterationCount: Annotation<number>(last(0)),

  draftReport: Annotation<string>(last("")),
  critique: Annotation<CritiqueResult | null>(last<CritiqueResult | null>(null)),
  revisionCount: Annotation<number>(last(0)),

  citationReport: Annotation<CitationReport | null>(last<CitationReport | null>(null)),
  finalReport: Annotation<string>(last("")),

  /** Honest notes when a limit was hit (iteration cap, revision cap, failed tools). */
  limitations: Annotation<string[]>({ reducer: append, default: () => [] }),
  errors: Annotation<ToolError[]>({ reducer: append, default: () => [] }),
});

export type ResearchStateType = typeof ResearchState.State;
export type ResearchUpdate = typeof ResearchState.Update;

export function log(node: string, message: string, detail?: unknown): LogEntry {
  return { node, message, at: new Date().toISOString(), detail };
}
