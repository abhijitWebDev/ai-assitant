import { config } from "./config";
import { getDb } from "./db";

/**
 * Per-user rate limits for the expensive routes (research runs spend LLM and search
 * credits, uploads spend embedding credits). Sliding windows over events kept in
 * SQLite, so limits survive restarts and redeploys. The app runs as one Node process,
 * and better-sqlite3 is synchronous, so check-and-record cannot race.
 */

export type Action = "research" | "upload";

interface Rule {
  max: number;
  windowMs: number;
  label: string;
}

const HOUR = 60 * 60 * 1000;

function rules(action: Action): Rule[] {
  const r = config.rateLimit;
  const all: Rule[] =
    action === "research"
      ? [
          {
            max: r.researchPerHour,
            windowMs: HOUR,
            label: "research runs per hour",
          },
          {
            max: r.researchPerDay,
            windowMs: 24 * HOUR,
            label: "research runs per day",
          },
        ]
      : [
          {
            max: r.uploadsPerHour,
            windowMs: HOUR,
            label: "document uploads per hour",
          },
        ];
  // 0 or less switches a rule off.
  return all.filter((rule) => rule.max > 0);
}

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS rate_events (
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events(user_id, action, at);
    `);
    ready = true;
  }
  return d;
}

export type LimitResult =
  { ok: true } | { ok: false; retryAfterSec: number; message: string };

/** Record one `action` for this user if every window has room, otherwise say when to retry. */
export function takeToken(
  userId: string,
  action: Action,
  now = Date.now(),
): LimitResult {
  const d = db();
  const active = rules(action);
  return d.transaction((): LimitResult => {
    for (const rule of active) {
      const since = now - rule.windowMs;
      const { count, oldest } = d
        .prepare(
          "SELECT COUNT(*) AS count, MIN(at) AS oldest FROM rate_events WHERE user_id = ? AND action = ? AND at > ?",
        )
        .get(userId, action, since) as { count: number; oldest: number | null };
      if (count >= rule.max) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil(((oldest ?? now) + rule.windowMs - now) / 1000),
        );
        return {
          ok: false,
          retryAfterSec,
          message: `You've reached the limit of ${rule.max} ${rule.label}. Try again in ${humanize(retryAfterSec)}.`,
        };
      }
    }
    d.prepare(
      "INSERT INTO rate_events (user_id, action, at) VALUES (?, ?, ?)",
    ).run(userId, action, now);
    // Keep the table small: nothing older than the longest window matters.
    if (Math.random() < 0.05)
      d.prepare("DELETE FROM rate_events WHERE at < ?").run(now - 24 * HOUR);
    return { ok: true };
  })();
}

/* ---------------- one run at a time ---------------- */

const running = new Set<string>();

/** Claim this user's single research slot; returns a release function, or null if busy. */
export function claimRunSlot(userId: string): (() => void) | null {
  if (running.has(userId)) return null;
  running.add(userId);
  let released = false;
  return () => {
    if (!released) running.delete(userId);
    released = true;
  };
}

/** The 429 response for a limit hit, with Retry-After so clients and proxies can back off. */
export function tooManyRequests(message: string, retryAfterSec?: number) {
  return Response.json(
    { error: message },
    {
      status: 429,
      headers: retryAfterSec
        ? { "Retry-After": String(retryAfterSec) }
        : undefined,
    },
  );
}

function humanize(sec: number): string {
  if (sec < 90) return `${sec} seconds`;
  const min = Math.ceil(sec / 60);
  if (min < 90) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} hours`;
}
