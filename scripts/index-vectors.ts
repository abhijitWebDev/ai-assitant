/**
 * Backfill LanceDB from SQLite: embeds every document chunk and report summary that
 * is not in the vector tables yet. Safe to run again; rows already indexed are skipped.
 *
 *   npm run index:vectors
 *
 * To rebuild from scratch, bump INDEX_VERSION in .env (new tables) and run it again.
 */
import { getDb, type ReportRow } from "../src/lib/db";
import { existingIds, indexChunks, indexReport, tables, vectorEnabled, type ChunkRow } from "../src/lib/vector";

async function main() {
  if (!vectorEnabled()) {
    console.error("LANCEDB_URI, LANCEDB_API_KEY and OPENAI_API_KEY must all be set in .env.");
    process.exit(1);
  }
  const db = getDb();

  const chunks = db
    .prepare(
      `SELECT c.id, c.document_id, c.thread_id, c.position, d.name, c.content AS text
       FROM doc_chunks c JOIN documents d ON d.id = c.document_id ORDER BY c.document_id, c.position`,
    )
    .all() as ChunkRow[];
  const haveChunks = await existingIds("chunks", chunks.map((c) => c.id));
  const newChunks = chunks.filter((c) => !haveChunks.has(c.id));
  for (let i = 0; i < newChunks.length; i += 200) await indexChunks(newChunks.slice(i, i + 200));
  console.log(`${tables.chunks()}: ${newChunks.length} indexed, ${haveChunks.size} already there`);

  const reports = db.prepare("SELECT id, thread_id, question, summary FROM reports").all() as Pick<
    ReportRow,
    "id" | "thread_id" | "question" | "summary"
  >[];
  const haveReports = await existingIds("reports", reports.map((r) => r.id));
  const newReports = reports.filter((r) => !haveReports.has(r.id));
  for (const r of newReports) await indexReport({ id: r.id, thread_id: r.thread_id, text: `${r.question}\n${r.summary}` });
  console.log(`${tables.reports()}: ${newReports.length} indexed, ${haveReports.size} already there`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
