import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { config } from "../../config";
import { threadChunks } from "../../db";
import { activeApiAdapters } from "../../retrieval/apis";
import { searchDocs } from "../../retrieval/docs";
import { webSearch } from "../../retrieval/web";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { RawResult, ToolError } from "../types";

/**
 * Source Processor (guide §4.5): the multi-source retrieval hub.
 * Dispatches every query to Web Search, Private Docs and APIs/MCP simultaneously.
 * Every tool call is wrapped: failures become ToolError records the rest of the
 * graph can reason about, never exceptions that crash the run (§9.4).
 */

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function sourceProcessor(state: ResearchStateType, cfg: LangGraphRunnableConfig): Promise<ResearchUpdate> {
  const threadId = String(cfg.configurable?.thread_id ?? "");
  const hasDocs = threadId ? threadChunks(threadId).length > 0 : false;
  const adapters = activeApiAdapters();
  const rawResults: RawResult[] = [];
  const errors: ToolError[] = [];
  const providersUsed = new Map<string, number>();
  const at = () => new Date().toISOString();

  await Promise.all(
    state.pendingQueries.map(async (q) => {
      const jobs: Promise<void>[] = [];

      // 1. Web search with provider fallback chain
      jobs.push(
        webSearch(q.webQuery).then(({ provider, hits, failures }) => {
          for (const f of failures)
            errors.push({ node: "source_processor", tool: `web:${f.provider}`, query: q.webQuery, error: f.error, at: at() });
          if (!provider) return;
          providersUsed.set(provider, (providersUsed.get(provider) ?? 0) + hits.length);
          for (const h of hits)
            rawResults.push({ subQuestion: q.subQuestion, query: q.webQuery, sourceType: "web", provider, ...h });
        }),
      );

      // 2. Private documents (BM25 + LanceDB vectors over this thread's uploads)
      if (hasDocs) {
        jobs.push(
          searchDocs(threadId, `${q.docQuery} ${q.subQuestion}`)
            .then(({ hits, mode, vectorError }) => {
              if (vectorError)
                errors.push({ node: "source_processor", tool: "docs:vector", query: q.docQuery, error: `${vectorError} (used keyword search only)`, at: at() });
              const provider = mode === "hybrid" ? "docs (hybrid)" : "docs";
              providersUsed.set(provider, (providersUsed.get(provider) ?? 0) + hits.length);
              for (const h of hits)
                rawResults.push({ subQuestion: q.subQuestion, query: q.docQuery, sourceType: "doc", provider, ...h });
            })
            .catch((err) => {
              errors.push({ node: "source_processor", tool: "docs", query: q.docQuery, error: String(err), at: at() });
            }),
        );
      }

      // 3. External APIs / MCP servers
      for (const adapter of adapters) {
        jobs.push(
          withTimeout((signal) => adapter.search(q.apiQuery, signal), config.search.timeoutMs)
            .then((hits) => {
              providersUsed.set(adapter.name, (providersUsed.get(adapter.name) ?? 0) + hits.length);
              for (const h of hits)
                rawResults.push({ subQuestion: q.subQuestion, query: q.apiQuery, sourceType: "api", provider: adapter.name, ...h });
            })
            .catch((err) => {
              errors.push({
                node: "source_processor",
                tool: `api:${adapter.name}`,
                query: q.apiQuery,
                error: err instanceof Error ? err.message : String(err),
                at: at(),
              });
            }),
        );
      }
      await Promise.all(jobs);
    }),
  );

  const summary = [...providersUsed.entries()].map(([p, n]) => `${p}: ${n}`).join(", ") || "no results";
  const limitations: string[] = [];
  if (!rawResults.length)
    limitations.push("A retrieval pass returned no results from any source. Check search API keys and network access.");

  return {
    rawResults,
    errors,
    limitations,
    messages: [
      log(
        "source_processor",
        `Retrieved ${rawResults.length} results (${summary})${errors.length ? `, ${errors.length} tool failure(s) handled` : ""}`,
      ),
    ],
  };
}
