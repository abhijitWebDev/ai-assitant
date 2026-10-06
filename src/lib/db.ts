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
  return db;
}

const now = () => new Date().toISOString();

/* ---------------- threads ---------------- */

export type ThreadRow = { id: string; title: string; created_at: string; updated_at: string };

export function ensureThread(id: string, title: string) {
  const d = getDb();
  const existing = d.prepare("SELECT id FROM threads WHERE id = ?").get(id);
  if (existing) {
    d.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now(), id);
  } else {
    d.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      id,
      title.slice(0, 120),
      now(),
      now(),
    );
  }
}

export function listThreads(): (ThreadRow & { report_count: number; doc_count: number })[] {
  return getDb()
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM reports r WHERE r.thread_id = t.id) AS report_count,
        (SELECT COUNT(*) FROM documents d WHERE d.thread_id = t.id) AS doc_count
       FROM threads t ORDER BY updated_at DESC LIMIT 100`,
    )
    .all() as (ThreadRow & { report_count: number; doc_count: number })[];
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

export function allReports(limit = 200): ReportRow[] {
  return getDb().prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT ?").all(limit) as ReportRow[];
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

export function reportsByIds(ids: string[]): ReportRow[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM reports WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as ReportRow[];
  // Keep the caller's order (it is a ranking).
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is ReportRow => Boolean(r));
}
