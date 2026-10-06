import { config } from "../config";
import { documentChunks, threadChunks } from "../db";
import { fuse, indexChunks, searchChunks, vectorEnabled } from "../vector";
import { bm25Rank, chunkText } from "../text";
import type { WebHit } from "./web";

/** Extract plain text from an uploaded PDF, DOCX, TXT or Markdown file. */
export async function extractText(file: { name: string; type: string; buffer: Buffer }): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
    const { text } = await pdfText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join("\n\n");
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value;
  }
  if (/\.(txt|md|markdown|csv|json)$/.test(lower) || file.type.startsWith("text/")) {
    return file.buffer.toString("utf8");
  }
  throw new Error(`Unsupported file type: ${file.name}. Upload PDF, DOCX, TXT or MD.`);
}

export { chunkText };

/**
 * Private Docs channel: hybrid search over the chunks uploaded to this research thread.
 * BM25 catches exact terms (names, numbers); LanceDB vectors catch paraphrases. The two
 * rankings are merged with reciprocal rank fusion. If the vector service fails, BM25
 * results are returned alone and `vectorError` says why.
 */
export async function searchDocs(
  threadId: string,
  query: string,
): Promise<{ hits: WebHit[]; mode: "hybrid" | "bm25"; vectorError?: string }> {
  const chunks = threadChunks(threadId);
  if (!chunks.length) return { hits: [], mode: "bm25" };
  const n = config.limits.docResultsPerQuery;
  const key = (c: { document_id: string; position: number }) => `${c.document_id}:${c.position}`;
  const byKey = new Map(chunks.map((c) => [key(c), c]));

  const keyword = bm25Rank(
    query,
    chunks.map((c) => c.content),
  )
    .slice(0, n * 2)
    .map(({ index }) => key(chunks[index]));

  let ranking = keyword;
  let mode: "hybrid" | "bm25" = "bm25";
  let vectorError: string | undefined;
  if (vectorEnabled()) {
    try {
      // Only keys still in SQLite survive, so chunks of deleted documents drop out here.
      const semantic = (await searchChunks(threadId, query, n * 2)).map(key).filter((k) => byKey.has(k));
      ranking = fuse([keyword, semantic]);
      mode = "hybrid";
    } catch (err) {
      vectorError = err instanceof Error ? err.message : String(err);
    }
  }

  const hits = ranking.slice(0, n).map((k) => {
    const c = byKey.get(k)!;
    return {
      title: `${c.name}, part ${c.position + 1}`,
      url: `doc://${c.document_id}/${c.position}`,
      content: c.content,
    };
  });
  return { hits, mode, vectorError };
}

/** Embed a freshly saved document's chunks into LanceDB. Throws if the vector service fails. */
export async function indexDocument(doc: { id: string; thread_id: string; name: string }) {
  if (!vectorEnabled()) return false;
  const rows = documentChunks(doc.id).map((c) => ({
    id: c.id,
    document_id: doc.id,
    thread_id: doc.thread_id,
    position: c.position,
    name: doc.name,
    text: c.content,
  }));
  await indexChunks(rows);
  return true;
}
