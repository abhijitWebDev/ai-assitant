import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type { EvidenceChunk } from "./agent/types";

/**
 * Application database (long-term memory + private documents).
 * LangGraph's own checkpoints live in a separate file, see agent/graph.ts.
 */

let db: Database.Database | null = null;

export function dataPath(file: string) {
  const dir = path.resolve(config.storage.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, file);
}

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(dataPath("app.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      question TEXT NOT NULL,
      summary TEXT NOT NULL,
      report TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      meta_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_thread ON reports(thread_id);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_thread ON doc_chunks(thread_id);
  `);
  // Databases created before sign-in have no owner column; threads from then stay ownerless (hidden).
  const cols = db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) db.exec("ALTER TABLE threads ADD COLUMN user_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, updated_at)");
  return db;
}

const now = () => new Date().toISOString();

/* ---------------- threads ---------------- */

export type ThreadRow = { id: string; user_id: string | null; title: string; created_at: string; updated_at: string };

/**
 * Whether `userId` may use this thread id: yes if they own it, or if it does not exist yet
 * (thread ids are minted by the browser, so a new id is how a thread starts).
 * Ownerless threads from before sign-in, and other people's threads, are refused.
 */
export function canUseThread(id: string, userId: string): boolean {
  const row = getDb().prepare("SELECT user_id FROM threads WHERE id = ?").get(id) as { user_id: string | null } | undefined;
  return !row || row.user_id === userId;
}

/**
 * Create the thread for its owner, or touch it if they already own it.
 * Someone else's thread is left alone (callers check canUseThread first anyway).
 */
export function ensureThread(id: string, title: string, userId: string) {
  getDb()
    .prepare(
      `INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at WHERE threads.user_id = excluded.user_id`,
    )
    .run(id, userId, title.slice(0, 120), now(), now());
}

export function listThreads(userId: string): (ThreadRow & { report_count: number; doc_count: number })[] {
  return getDb()
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM reports r WHERE r.thread_id = t.id) AS report_count,
        (SELECT COUNT(*) FROM documents d WHERE d.thread_id = t.id) AS doc_count
       FROM threads t WHERE t.user_id = ? ORDER BY updated_at DESC LIMIT 100`,
    )
    .all(userId) as (ThreadRow & { report_count: number; doc_count: number })[];
}

export function deleteThread(id: string) {
  const d = getDb();
  d.prepare("DELETE FROM reports WHERE thread_id = ?").run(id);
  d.prepare("DELETE FROM doc_chunks WHERE thread_id = ?").run(id);
  d.prepare("DELETE FROM documents WHERE thread_id = ?").run(id);
  d.prepare("DELETE FROM threads WHERE id = ?").run(id);
}

/* ---------------- reports (long-term memory) ---------------- */

export type ReportRow = {
  id: string;
  thread_id: string;
  question: string;
  summary: string;
  report: string;
  evidence_json: string;
  meta_json: string;
  created_at: string;
};

export function saveReport(r: {
  threadId: string;
  question: string;
  summary: string;
  report: string;
  evidence: EvidenceChunk[];
  meta: Record<string, unknown>;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO reports (id, thread_id, question, summary, report, evidence_json, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, r.threadId, r.question, r.summary, r.report, JSON.stringify(r.evidence), JSON.stringify(r.meta), now());
  return id;
}

export function listReports(threadId: string): ReportRow[] {
  return getDb()
    .prepare("SELECT * FROM reports WHERE thread_id = ? ORDER BY created_at DESC")
    .all(threadId) as ReportRow[];
}

/** This user's reports across all their threads (long-term memory never crosses users). */
export function allReports(userId: string, limit = 200): ReportRow[] {
  return getDb()
    .prepare(
      `SELECT r.* FROM reports r JOIN threads t ON t.id = r.thread_id
       WHERE t.user_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as ReportRow[];
}

/* ---------------- private documents ---------------- */

export type DocumentRow = { id: string; thread_id: string; name: string; mime: string; chars: number; created_at: string };

export function saveDocument(threadId: string, name: string, mime: string, text: string, chunks: string[]): DocumentRow {
  const d = getDb();
  const doc: DocumentRow = { id: randomUUID(), thread_id: threadId, name, mime, chars: text.length, created_at: now() };
  const insertChunk = d.prepare(
    "INSERT INTO doc_chunks (id, document_id, thread_id, position, content) VALUES (?, ?, ?, ?, ?)",
  );
  d.transaction(() => {
    d.prepare("INSERT INTO documents (id, thread_id, name, mime, chars, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      doc.id,
      doc.thread_id,
      doc.name,
      doc.mime,
      doc.chars,
      doc.created_at,
    );
    chunks.forEach((c, i) => insertChunk.run(randomUUID(), doc.id, threadId, i, c));
  })();
  return doc;
}

export function listDocuments(threadId: string): DocumentRow[] {
  return getDb()
    .prepare("SELECT * FROM documents WHERE thread_id = ? ORDER BY created_at DESC")
    .all(threadId) as DocumentRow[];
}

/** The thread a document belongs to, or undefined if there is no such document. */
export function documentThread(id: string): string | undefined {
  const row = getDb().prepare("SELECT thread_id FROM documents WHERE id = ?").get(id) as { thread_id: string } | undefined;
  return row?.thread_id;
}

export function deleteDocument(id: string) {
  const d = getDb();
  d.prepare("DELETE FROM doc_chunks WHERE document_id = ?").run(id);
  d.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

export function threadChunks(threadId: string): { content: string; position: number; name: string; document_id: string }[] {
  return getDb()
    .prepare(
      `SELECT c.content, c.position, c.document_id, d.name FROM doc_chunks c
       JOIN documents d ON d.id = c.document_id WHERE c.thread_id = ?`,
    )
    .all(threadId) as { content: string; position: number; name: string; document_id: string }[];
}

export function documentChunks(documentId: string): { id: string; position: number; content: string }[] {
  return getDb()
    .prepare("SELECT id, position, content FROM doc_chunks WHERE document_id = ? ORDER BY position")
    .all(documentId) as { id: string; position: number; content: string }[];
}

/** Reports by id, limited to this user's threads. */
export function reportsByIds(ids: string[], userId: string): ReportRow[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(
      `SELECT r.* FROM reports r JOIN threads t ON t.id = r.thread_id
       WHERE t.user_id = ? AND r.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(userId, ...ids) as ReportRow[];
  // Keep the caller's order (it is a ranking).
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is ReportRow => Boolean(r));
}
