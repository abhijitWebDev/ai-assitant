import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import { config, type LlmProvider } from "./config";

export type ModelTier = "smart" | "fast";

const cache = new Map<string, BaseChatModel>();

/** Structured calls return short JSON; text calls write the long Markdown report. */
type CallKind = "structured" | "text";

interface Budget {
  tokensPerMinute: number;
  requestsPerMinute: number;
  maxWaitMs: number;
}

interface ModelChoice {
  provider: LlmProvider;
  model: string;
  /** Present for the fallback: the free-tier style per-minute limits it must stay under. */
  budget?: Budget;
}

function primary(tier: ModelTier): ModelChoice {
  return {
    provider: config.llm.provider,
    model: (tier === "smart" ? config.llm.smartModel : config.llm.fastModel)!,
  };
}

function fallback(tier: ModelTier): ModelChoice | null {
  const f = config.llm.fallback;
  if (!f) return null;
  return {
    provider: f.provider,
    model: (tier === "smart" ? f.smartModel : f.fastModel)!,
    budget: { tokensPerMinute: f.tokensPerMinute, requestsPerMinute: f.requestsPerMinute, maxWaitMs: f.maxWaitMs },
  };
}

/**
 * Reply cap on the fallback. Providers count the reply (reasoning included) toward TPM,
 * so the cap is also what we reserve in the budget for each call.
 */
const FALLBACK_MAX_OUTPUT: Record<CallKind, number> = { structured: 2000, text: 3500 };

/** Keep reasoning short on reasoning models: those tokens count toward TPM but never reach the report. */
function groqReasoning(model: string) {
  if (model.startsWith("openai/gpt-oss")) return { reasoningEffort: "low" as const };
  if (model.startsWith("qwen/")) return { reasoningEffort: "none" as const, reasoningFormat: "hidden" as const };
  return {};
}

/**
 * Provider-agnostic model factory. Providers are imported lazily so you only
 * need the API key for the one you actually use.
 */
async function getModel({ provider, model, budget }: ModelChoice, kind: CallKind): Promise<BaseChatModel> {
  const key = budget ? `${provider}:${model}:${kind}` : `${provider}:${model}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const temperature = config.llm.temperature;
  // The fallback fails fast: our budget already paces it, and a long retry loop would
  // only stall the run. It also gets a reply cap so the budget can count on it.
  const maxRetries = budget ? 1 : config.llm.maxRetries;
  const maxTokens = budget ? FALLBACK_MAX_OUTPUT[kind] : undefined;
  let instance: BaseChatModel;
  switch (provider) {
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      instance = new ChatOpenAI({ model, temperature, maxRetries, maxTokens });
      break;
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      instance = new ChatAnthropic({ model, temperature, maxRetries, maxTokens });
      break;
    }
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      instance = new ChatGoogleGenerativeAI({
        model,
        temperature,
        maxRetries,
        maxOutputTokens: maxTokens,
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      });
      break;
    }
    case "groq": {
      const { ChatGroq } = await import("@langchain/groq");
      instance = new ChatGroq({ model, temperature, maxRetries, maxTokens, ...groqReasoning(model) });
      break;
    }
    default:
      throw new Error(`Unknown LLM provider "${provider}". Use openai, anthropic, google or groq.`);
  }
  cache.set(key, instance);
  return instance;
}

/* ------------------------------------------------------------------ */
/* Fallback: per-minute budget                                         */
/* ------------------------------------------------------------------ */

/** About 4 characters per token for English; 3.5 is generous so we stay under the limit. */
const CHARS_PER_TOKEN = 3.5;
export function estimateTokens(...texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN);
}

const windows = new Map<string, { at: number; tokens: number }[]>();

/**
 * Wait until one more request of `tokens` fits this model's sliding one-minute window
 * (both tokens and requests), then record it. Node runs callbacks one at a time, so the
 * check and the record cannot interleave.
 */
async function reserve(key: string, tokens: number, budget: Budget) {
  if (tokens > budget.tokensPerMinute)
    throw new Error(`request of about ${tokens} tokens exceeds the fallback limit of ${budget.tokensPerMinute} per minute`);
  const deadline = Date.now() + budget.maxWaitMs;
  for (;;) {
    const now = Date.now();
    const log = (windows.get(key) ?? []).filter((e) => e.at > now - 60_000);
    windows.set(key, log);
    const used = log.reduce((n, e) => n + e.tokens, 0);
    const fits = (drop: number, freed: number) =>
      used - freed + tokens <= budget.tokensPerMinute && log.length - drop < budget.requestsPerMinute;
    if (fits(0, 0)) {
      log.push({ at: now, tokens });
      return;
    }
    // Wait for enough of the oldest entries to leave the window.
    let freed = 0;
    let waitUntil = now;
    for (let i = 0; i < log.length; i++) {
      freed += log[i].tokens;
      waitUntil = log[i].at + 60_000;
      if (fits(i + 1, freed)) break;
    }
    if (waitUntil > deadline) throw new Error("fallback is at its per-minute limit");
    await new Promise((r) => setTimeout(r, waitUntil - now + 50));
  }
}

function isAbort(err: unknown) {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

/** Builds a smaller user prompt of at most `maxChars` characters, for the fallback's limits. */
export type FitPrompt = (maxChars: number) => string;

/**
 * Run `call` on the main model; if that fails, run it once more on the fallback model
 * within its per-minute budget, shrinking the prompt with `fit` when it would not fit.
 * When both fail, the main model's error is the one reported.
 */
async function withFallback<R>(
  opts: { tier: ModelTier; name: string; kind: CallKind; system: string; user: string; fit?: FitPrompt },
  call: (model: BaseChatModel, runName: string, user: string) => Promise<R>,
): Promise<R> {
  const main = primary(opts.tier);
  try {
    return await call(await getModel(main, opts.kind), opts.name, opts.user);
  } catch (err) {
    const alt = fallback(opts.tier);
    if (!alt || isAbort(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const budget = alt.budget!;
      const output = FALLBACK_MAX_OUTPUT[opts.kind];
      let user = opts.user;
      if (opts.fit && estimateTokens(opts.system, user) + output > budget.tokensPerMinute) {
        const room = budget.tokensPerMinute - output - estimateTokens(opts.system);
        user = opts.fit(Math.floor(room * CHARS_PER_TOKEN * 0.95));
      }
      await reserve(`${alt.provider}:${alt.model}`, estimateTokens(opts.system, user) + output, budget);
      console.warn(
        `[llm] ${opts.name}: ${main.provider} failed (${reason.slice(0, 160)}); using ${alt.provider}:${alt.model}` +
          (user === opts.user ? "" : ` with a prompt trimmed from ${opts.user.length} to ${user.length} chars`),
      );
      return await call(await getModel(alt, opts.kind), `${opts.name} (fallback)`, user);
    } catch (fallbackErr) {
      console.warn(`[llm] ${opts.name}: fallback ${alt.provider}:${alt.model} also failed`, fallbackErr);
      throw err;
    }
  }
}

/**
 * Shrink a prompt by lowering a per-item cap (e.g. characters per evidence chunk) until it
 * fits in `maxChars`; returns the smallest version if nothing fits, and the caller's budget
 * check then skips the fallback.
 */
export function shrinkToFit(build: (cap: number) => string, maxChars: number, startCap: number, minCap = 120): string {
  let cap = startCap;
  let out = build(cap);
  while (out.length > maxChars && cap > minCap) {
    cap = Math.max(minCap, Math.floor(cap * 0.75));
    out = build(cap);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Test hook: lets scripts/test-graph.ts run the graph without API keys */
/* ------------------------------------------------------------------ */

type Responder = (args: {
  kind: "structured" | "text";
  name: string;
  tier: ModelTier;
  system: string;
  user: string;
}) => unknown;

// Stored on globalThis so a test harness loaded in a different module instance can set it.
const g = globalThis as unknown as { __researchTestResponder?: Responder | null };
export function __setTestResponder(fn: Responder | null) {
  g.__researchTestResponder = fn;
}

/**
 * Ask a model for JSON matching a zod schema. Retries once on a malformed reply,
 * because structured output occasionally fails on smaller models.
 */
export async function callStructured<T extends z.ZodTypeAny>(opts: {
  tier: ModelTier;
  schema: T;
  name: string;
  system: string;
  user: string;
  /** Optional smaller prompt for the fallback model's per-minute limit. */
  fit?: FitPrompt;
}): Promise<z.infer<T>> {
  const testResponder = g.__researchTestResponder;
  if (testResponder) {
    return opts.schema.parse(
      testResponder({ kind: "structured", name: opts.name, tier: opts.tier, system: opts.system, user: opts.user }),
    );
  }
  return withFallback({ ...opts, kind: "structured" }, async (model, runName, user) => {
    const messages = [new SystemMessage(opts.system), new HumanMessage(user)];
    const runnable = model.withStructuredOutput(opts.schema, { name: opts.name });
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await runnable.invoke(messages, { runName });
        return opts.schema.parse(out);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  });
}

/** Plain-text completion (used for long Markdown output). */
export async function callText(opts: {
  tier: ModelTier;
  name: string;
  system: string;
  user: string;
  /** Optional smaller prompt for the fallback model's per-minute limit. */
  fit?: FitPrompt;
}): Promise<string> {
  const testResponder = g.__researchTestResponder;
  if (testResponder) {
    return String(
      testResponder({ kind: "text", name: opts.name, tier: opts.tier, system: opts.system, user: opts.user }),
    );
  }
  return withFallback({ ...opts, kind: "text" }, async (model, runName, user) => {
    const res = await model.invoke([new SystemMessage(opts.system), new HumanMessage(user)], { runName });
    if (typeof res.content === "string") return res.content;
    return res.content
      .map((part) => (typeof part === "string" ? part : "text" in part ? String(part.text) : ""))
      .join("");
  });
}

/** Run async tasks with a concurrency cap, so we don't hit provider rate limits. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
