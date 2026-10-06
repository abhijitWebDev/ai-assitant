import { randomUUID } from "node:crypto";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { allReports, listDocuments, listReports, reportsByIds, type ReportRow } from "../../db";
import { bm25Rank, truncate } from "../../text";
import { fuse, searchReports, vectorEnabled } from "../../vector";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { EvidenceChunk } from "../types";

/**
 * Context Manager (guide §4.3): runs in parallel with the Planner and loads
 *   - prior research from this thread (and relevant reports from other threads)
 *   - the inventory of private documents uploaded to this thread
 * Relevant evidence from earlier reports is re-used directly, so the system
 * doesn't pay to rediscover what it already knows.
 */
export async function contextManager(state: ResearchStateType, cfg: LangGraphRunnableConfig): Promise<ResearchUpdate> {
  const threadId = String(cfg.configurable?.thread_id ?? "");
  const userId = String(cfg.configurable?.user_id ?? "");
  const sameThread = threadId ? listReports(threadId).slice(0, 3) : [];

  // Only this user's own reports count as memory.
  const others = userId ? allReports(userId).filter((r) => r.thread_id !== threadId) : [];
  const keyword = bm25Rank(
    state.question,
    others.map((r) => `${r.question}\n${r.summary}`),
  )
    .filter((r) => r.score > 2)
    .map((r) => others[r.index].id);

  // Semantic recall from LanceDB finds related research phrased differently; BM25 alone if it fails.
  let recall = "keyword";
  let semantic: string[] = [];
  if (vectorEnabled() && others.length) {
    try {
      // Vector rows are shared across users, so over-fetch; reportsByIds keeps only this user's.
      semantic = (await searchReports(state.question, 20, threadId || undefined)).map((h) => h.id);
      recall = "hybrid";
    } catch (err) {
      recall = `keyword (vector search failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
  // reportsByIds drops ids that no longer exist in SQLite (deleted threads).
  const ranked = reportsByIds(fuse([keyword, semantic]), userId)
    .filter((r) => r.thread_id !== threadId)
    .slice(0, 2);

  const prior: ReportRow[] = [...sameThread, ...ranked];
  const docs = threadId ? listDocuments(threadId) : [];

  const parts: string[] = [];
  if (prior.length) {
    parts.push(
      "Prior research already completed:\n" +
        prior.map((r) => `- Q: ${r.question}\n  Summary: ${truncate(r.summary.replace(/\s+/g, " "), 600)}`).join("\n"),
    );
  }
  if (docs.length) {
    parts.push(`Private documents available for search: ${docs.map((d) => d.name).join(", ")}`);
  }

  // Re-use the most relevant evidence chunks from prior reports.
  const priorEvidence: EvidenceChunk[] = prior.flatMap((r) => {
    try {
      return JSON.parse(r.evidence_json) as EvidenceChunk[];
    } catch {
      return [];
    }
  });
  const reused = bm25Rank(
    state.question,
    priorEvidence.map((e) => e.content),
  )
    .slice(0, 5)
    .map(({ index }) => ({
      ...priorEvidence[index],
      id: randomUUID(),
      sourceType: "memory" as const,
      subQuestion: "(from prior research)",
    }));

  return {
    priorContext: parts.join("\n\n"),
    evidenceStore: reused,
    messages: [
      log(
        "context_manager",
        `Loaded ${prior.length} prior report(s) by ${recall} recall, ${docs.length} private document(s), re-used ${reused.length} evidence chunk(s)`,
      ),
    ],
  };
}
