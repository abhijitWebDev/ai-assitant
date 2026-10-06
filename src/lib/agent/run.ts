import { Overwrite } from "@langchain/langgraph";
import { config } from "../config";
import { ensureThread, saveReport } from "../db";
import { indexReport, vectorEnabled } from "../vector";
import { getGraph } from "./graph";
import type { ResearchStateType } from "./state";
import type { CitationReport, CritiqueResult, EvidenceChunk, GuardrailResult, LogEntry, ToolError } from "./types";

export type RunEvent =
  | { type: "start"; threadId: string; question: string }
  | { type: "node"; node: string; log: LogEntry[]; snapshot: NodeSnapshot }
  | { type: "blocked"; guardrail: GuardrailResult }
  | {
      type: "done";
      reportId: string;
      finalReport: string;
      evidence: EvidenceChunk[];
      researchQuestions: string[];
      citationReport: CitationReport | null;
      critique: CritiqueResult | null;
      iterationCount: number;
      revisionCount: number;
      errors: ToolError[];
      limitations: string[];
      durationMs: number;
    }
  | { type: "error"; message: string };

/** Small, UI-friendly slice of what each node just changed. */
export interface NodeSnapshot {
  guardrailAllowed?: boolean;
  researchQuestions?: string[];
  queries?: string[];
  rawResultCount?: number;
  evidenceCount?: number;
  coverageStatus?: string;
  iterationCount?: number;
  critique?: CritiqueResult | null;
  revisionCount?: number;
  draftReport?: string;
}

function extractSummary(report: string): string {
  const m = report.match(/##\s*Summary\s*\n([\s\S]*?)(\n##\s|$)/i);
  return (m?.[1] ?? report.slice(0, 1200)).trim();
}

/**
 * Runs the graph for one question and yields progress events as each node finishes.
 * streamMode "updates" gives us exactly what each agent wrote to the shared state.
 */
export async function* runResearch(opts: {
  question: string;
  threadId: string;
  signal?: AbortSignal;
}): AsyncGenerator<RunEvent> {
  const started = Date.now();
  const graph = getGraph();
  const cfg = { configurable: { thread_id: opts.threadId } };
  ensureThread(opts.threadId, opts.question);

  yield { type: "start", threadId: opts.threadId, question: opts.question };

  const stream = await graph.stream(
    { question: opts.question },
    {
      ...cfg,
      streamMode: "updates",
      signal: opts.signal,
      // guardrail + manager + 2 parallel + (4 nodes × passes) + (2 × revisions) + checker, with headroom
      recursionLimit: 20 + 4 * (config.limits.maxResearchIterations + 1) + 2 * (config.limits.maxRevisions + 1),
    },
  );

  for await (const chunk of stream) {
    for (const [node, raw] of Object.entries(chunk as Record<string, Partial<ResearchStateType> | null>)) {
      if (!raw) continue;
      const u = raw as Record<string, unknown>;
      // Overwrite() values arrive wrapped; unwrap for display.
      const unwrap = <T,>(v: unknown): T | undefined => {
        if (Overwrite.isInstance<T>(v)) return v.value;
        if (v && typeof v === "object" && "__overwrite__" in v) return (v as { __overwrite__: T }).__overwrite__;
        return v as T | undefined;
      };

      const logs = unwrap<LogEntry[]>(u.messages) ?? [];
      const evidence = unwrap<EvidenceChunk[]>(u.evidenceStore);

      const snapshot: NodeSnapshot = {
        guardrailAllowed: (u.guardrail as GuardrailResult | undefined)?.allowed,
        researchQuestions: u.researchQuestions as string[] | undefined,
        queries: (u.pendingQueries as { webQuery: string }[] | undefined)?.map((q) => q.webQuery),
        rawResultCount: (u.rawResults as unknown[] | undefined)?.length,
        evidenceCount: evidence ? evidence.length : undefined,
        coverageStatus: u.coverageStatus as string | undefined,
        iterationCount: u.iterationCount as number | undefined,
        critique: u.critique as CritiqueResult | null | undefined,
        revisionCount: u.revisionCount as number | undefined,
        draftReport: node === "synthesis" ? (u.draftReport as string | undefined) : undefined,
      };
      yield { type: "node", node, log: logs, snapshot };
    }
  }

  // Read the final, fully-reduced state from the checkpointer.
  const state = (await graph.getState(cfg)).values as ResearchStateType;

  if (state.guardrail && !state.guardrail.allowed) {
    yield { type: "blocked", guardrail: state.guardrail };
    return;
  }

  const reportId = saveReport({
    threadId: opts.threadId,
    question: opts.question,
    summary: extractSummary(state.finalReport),
    report: state.finalReport,
    evidence: state.evidenceStore,
    meta: {
      researchQuestions: state.researchQuestions,
      iterationCount: state.iterationCount,
      revisionCount: state.revisionCount,
      citationReport: state.citationReport,
      critique: state.critique,
      errors: state.errors,
      limitations: state.limitations,
      durationMs: Date.now() - started,
      model: `${config.llm.provider}:${config.llm.smartModel}/${config.llm.fastModel}`,
    },
  });

  // Add the report to semantic memory in the background; a failure only costs future recall.
  if (vectorEnabled()) {
    indexReport({ id: reportId, thread_id: opts.threadId, text: `${opts.question}\n${extractSummary(state.finalReport)}` }).catch((err) =>
      console.warn("[lancedb] report indexing failed", err),
    );
  }

  yield {
    type: "done",
    reportId,
    finalReport: state.finalReport,
    evidence: state.evidenceStore,
    researchQuestions: state.researchQuestions,
    citationReport: state.citationReport,
    critique: state.critique,
    iterationCount: state.iterationCount,
    revisionCount: state.revisionCount,
    errors: state.errors,
    limitations: state.limitations,
    durationMs: Date.now() - started,
  };
}
