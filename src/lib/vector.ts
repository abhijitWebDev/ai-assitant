import type { OpenAIEmbeddings } from "@langchain/openai";
import { LruCache } from "./cache";
import { config } from "./config";

/**
 * Semantic memory on the self-hosted LanceDB service (the FastAPI wrapper on the VPS).
 *
 * Two tables, named `<prefix>-chunks-<INDEX_VERSION>` and `<prefix>-reports-<INDEX_VERSION>`:
 *   - chunks:  one row per uploaded-document chunk, filtered by thread_id at query time
 *   - reports: one row per finished report (question + summary), for prior-research recall
 *
 * SQLite stays the source of truth. The service has no row delete, so rows for deleted
 * documents and threads stay in LanceDB; callers drop hits whose id no longer exists in SQLite.
 * Every function here throws on failure, and callers fall back to BM25.
 */

export interface ChunkRow {
  id: string;
  document_id: string;
  thread_id: string;
  position: number;
  name: string;
  text: string;
}
export interface ReportVectorRow {
  id: string;
  thread_id: string;
  text: string;
}
export type Hit<T> = T & { _distance: number };

export function vectorEnabled(): boolean {
  return Boolean(config.vector.uri && config.vector.apiKey && process.env.OPENAI_API_KEY);
}

export const tables = {
  chunks: () => `${config.vector.tablePrefix}-chunks-${config.vector.indexVersion}`,
  reports: () => `${config.vector.tablePrefix}-reports-${config.vector.indexVersion}`,
};

/* ---------------- embeddings ---------------- */

let embedder: OpenAIEmbeddings | null = null;

/** OpenAI embeddings (1536 dims for text-embedding-3-small), regardless of the chat provider. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (!embedder) {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    embedder = new OpenAIEmbeddings({ model: config.vector.embeddingModel, batchSize: 256 });
  }
  return embedder.embedDocuments(texts);
}

const queryVectors = new LruCache<string, number[]>(config.cache.embeddingCacheSize);

/** One search query's vector; repeats (same text, same model) are served from memory. */
async function embedQuery(text: string): Promise<number[]> {
  const key = `${config.vector.embeddingModel}:${text}`;
  const hit = queryVectors.get(key);
  if (hit) return hit;
  const [vector] = await embed([text]);
  queryVectors.set(key, vector);
  return vector;
}

/* ---------------- HTTP client ---------------- */

class VectorHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.vector.uri.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { "x-api-key": config.vector.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.vector.timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VectorHttpError(res.status, `LanceDB ${method} ${path}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Ids are UUIDs; anything else is refused rather than spliced into a filter string. */
function quoteId(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Unsafe id for LanceDB filter: ${id}`);
  return `'${id}'`;
}

/** Insert rows, creating the table from them on first use. */
async function insert(table: string, records: Record<string, unknown>[]) {
  if (!records.length) return;
  const path = `/tables/${encodeURIComponent(table)}`;
  try {
    await call("POST", `${path}/insert`, { records });
  } catch (err) {
    if (!(err instanceof VectorHttpError && err.status === 404)) throw err;
    try {
      await call("POST", path, { records, mode: "create" });
    } catch (createErr) {
      // Another request created the table first: insert into it instead.
      if (createErr instanceof VectorHttpError && createErr.status < 500) await call("POST", `${path}/insert`, { records });
      else throw createErr;
    }
  }
}

async function search<T>(table: string, vector: number[], limit: number, filter?: string): Promise<Hit<T>[]> {
  try {
    const res = await call<{ results: Hit<T & { vector?: unknown }>[] }>("POST", `/tables/${encodeURIComponent(table)}/search`, {
      vector,
      limit,
      filter: filter ?? null,
    });
    // Drop the 1536-float vectors the service echoes back.
    return res.results.map((row) => {
      delete row.vector;
      return row as Hit<T>;
    });
  } catch (err) {
    // Nothing has been indexed yet.
    if (err instanceof VectorHttpError && err.status === 404) return [];
    throw err;
  }
}

/* ---------------- public API ---------------- */

export async function indexChunks(rows: ChunkRow[]) {
  const vectors = await embed(rows.map((r) => `${r.name}\n${r.text}`));
  await insert(
    tables.chunks(),
    rows.map((r, i) => ({ ...r, vector: vectors[i] })),
  );
}

export async function searchChunks(threadId: string, query: string, limit: number): Promise<Hit<ChunkRow>[]> {
  const vector = await embedQuery(query);
  const hits = await search<ChunkRow>(tables.chunks(), vector, limit, `thread_id = ${quoteId(threadId)}`);
  return hits.filter((h) => h._distance <= config.vector.maxDistance);
}

export async function indexReport(row: ReportVectorRow) {
  const [vector] = await embed([row.text]);
  await insert(tables.reports(), [{ ...row, vector }]);
}

export async function searchReports(query: string, limit: number, excludeThreadId?: string): Promise<Hit<ReportVectorRow>[]> {
  const vector = await embedQuery(query);
  const filter = excludeThreadId ? `thread_id != ${quoteId(excludeThreadId)}` : undefined;
  const hits = await search<ReportVectorRow>(tables.reports(), vector, limit, filter);
  return hits.filter((h) => h._distance <= config.vector.maxDistance);
}

/** Which of these ids already have a row in `table` (used by the backfill script to stay idempotent). */
export async function existingIds(table: "chunks" | "reports", ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const probe = new Array(config.vector.dimensions).fill(0);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const hits = await search<{ id: string }>(tables[table](), probe, batch.length, `id IN (${batch.map(quoteId).join(", ")})`);
    for (const h of hits) found.add(h.id);
  }
  return found;
}

/**
 * Reciprocal rank fusion: merge ranked lists of keys into one ranking.
 * A key ranked well by both keyword and vector search rises to the top.
 */
export function fuse(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((key, rank) => score.set(key, (score.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}
