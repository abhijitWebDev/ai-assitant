import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import { config } from "./config";

export type ModelTier = "smart" | "fast";

const cache = new Map<string, BaseChatModel>();

/**
 * Provider-agnostic model factory. Providers are imported lazily so you only
 * need the API key for the one you actually use.
 */
async function getModel(tier: ModelTier): Promise<BaseChatModel> {
  const model = tier === "smart" ? config.llm.smartModel : config.llm.fastModel;
  const key = `${config.llm.provider}:${model}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const temperature = config.llm.temperature;
  let instance: BaseChatModel;
  switch (config.llm.provider) {
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      instance = new ChatOpenAI({ model, temperature });
      break;
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      instance = new ChatAnthropic({ model, temperature });
      break;
    }
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      instance = new ChatGoogleGenerativeAI({
        model,
        temperature,
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      });
      break;
    }
    case "groq": {
      const { ChatGroq } = await import("@langchain/groq");
      instance = new ChatGroq({ model, temperature });
      break;
    }
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${config.llm.provider}". Use openai, anthropic, google or groq.`,
      );
  }
  cache.set(key, instance);
  return instance;
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
}): Promise<z.infer<T>> {
  const testResponder = g.__researchTestResponder;
  if (testResponder) {
    return opts.schema.parse(
      testResponder({ kind: "structured", name: opts.name, tier: opts.tier, system: opts.system, user: opts.user }),
    );
  }
  const model = await getModel(opts.tier);
  const runnable = model.withStructuredOutput(opts.schema, { name: opts.name });
  const messages = [new SystemMessage(opts.system), new HumanMessage(opts.user)];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await runnable.invoke(messages, { runName: opts.name });
      return opts.schema.parse(out);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Plain-text completion (used for long Markdown output). */
export async function callText(opts: {
  tier: ModelTier;
  name: string;
  system: string;
  user: string;
}): Promise<string> {
  const testResponder = g.__researchTestResponder;
  if (testResponder) {
    return String(
      testResponder({ kind: "text", name: opts.name, tier: opts.tier, system: opts.system, user: opts.user }),
    );
  }
  const model = await getModel(opts.tier);
  const res = await model.invoke([new SystemMessage(opts.system), new HumanMessage(opts.user)], {
    runName: opts.name,
  });
  if (typeof res.content === "string") return res.content;
  return res.content
    .map((part) => (typeof part === "string" ? part : "text" in part ? String(part.text) : ""))
    .join("");
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
