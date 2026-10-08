/**
 * Central configuration. Everything tunable lives here and is read from .env.local,
 * so you can change providers, limits and thresholds without touching agent code.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type LlmProvider = "openai" | "anthropic" | "google" | "groq";

const DEFAULT_MODELS: Record<LlmProvider, { smart: string; fast: string }> = {
  openai: { smart: "gpt-4.1", fast: "gpt-4.1-mini" },
  anthropic: { smart: "claude-sonnet-4-5", fast: "claude-haiku-4-5" },
  google: { smart: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
  // gpt-oss models are on Groq's free tier and support strict JSON-schema output.
  groq: { smart: "openai/gpt-oss-120b", fast: "openai/gpt-oss-20b" },
};

const provider = (process.env.LLM_PROVIDER?.toLowerCase() ?? "openai") as LlmProvider;
const fallbackProvider = (process.env.LLM_FALLBACK_PROVIDER?.toLowerCase() || "") as LlmProvider | "";

export const config = {
  llm: {
    provider,
    /** Higher-capability model: Research Manager, Planner, Coverage, Synthesis, Critic, Citations. */
    smartModel: process.env.SMART_MODEL || DEFAULT_MODELS[provider]?.smart,
    /** Cheap, fast model: Guardrail, Query Generator, Evidence scoring. */
    fastModel: process.env.FAST_MODEL || DEFAULT_MODELS[provider]?.fast,
    temperature: num("LLM_TEMPERATURE", 0.2),
    /**
     * Retries on the main provider. 6 is LangChain's default; with a fallback set, 2 hands
     * a failing call over sooner instead of backing off for a minute.
     */
    maxRetries: num("LLM_MAX_RETRIES", fallbackProvider ? 2 : 6),
    /**
     * Used only when a call to the main provider fails (rate limit, outage, timeout).
     * Leave LLM_FALLBACK_PROVIDER unset to switch it off.
     */
    fallback: fallbackProvider
      ? {
          provider: fallbackProvider,
          smartModel: process.env.FALLBACK_SMART_MODEL || DEFAULT_MODELS[fallbackProvider]?.smart,
          fastModel: process.env.FALLBACK_FAST_MODEL || DEFAULT_MODELS[fallbackProvider]?.fast,
          /**
           * Per-model limits this app keeps under; set them to your account's limits
           * (Groq: console.groq.com/settings/limits; free tier gpt-oss is 8K TPM, 30 RPM).
           * Calls wait for room in the minute window; prompts too big are trimmed or skipped.
           */
          tokensPerMinute: num("FALLBACK_TPM", 8000),
          requestsPerMinute: num("FALLBACK_RPM", 30),
          /**
           * Longest a call waits for room in the minute window. Just over a minute, because a
           * trimmed report prompt can fill nearly the whole TPM and must outwait earlier calls.
           */
          maxWaitMs: num("FALLBACK_MAX_WAIT_MS", 65000),
        }
      : null,
  },
  search: {
    /** Tried in order; providers without an API key are skipped. DuckDuckGo needs no key. */
    providers: list("SEARCH_PROVIDERS", ["tavily", "serpapi", "brave", "duckduckgo"]),
    resultsPerQuery: num("SEARCH_RESULTS_PER_QUERY", 5),
    timeoutMs: num("SEARCH_TIMEOUT_MS", 15000),
  },
  apis: {
    /** Structured-knowledge channels. Set API_SOURCES= (empty) to disable. */
    sources: list("API_SOURCES", ["wikipedia", "arxiv"]),
    mcpServerUrl: process.env.MCP_SERVER_URL || "",
    mcpToolName: process.env.MCP_TOOL_NAME || "search",
    mcpQueryArg: process.env.MCP_QUERY_ARG || "query",
  },
  limits: {
    /** Max extra research loops the Coverage Evaluator may request. */
    maxResearchIterations: num("MAX_RESEARCH_ITERATIONS", 2),
    /** Max times the Critic can send a draft back to Synthesis. */
    maxRevisions: num("MAX_REVISIONS", 2),
    maxSubQuestions: num("MAX_SUB_QUESTIONS", 5),
    /** Evidence below this score (0-10) never enters the store. */
    minRelevance: num("MIN_RELEVANCE", 6),
    /** When the store exceeds this, the lowest-scoring chunks are evicted. */
    maxEvidence: num("MAX_EVIDENCE", 40),
    docResultsPerQuery: num("DOC_RESULTS_PER_QUERY", 4),
    llmConcurrency: num("LLM_CONCURRENCY", 4),
  },
  storage: {
    dataDir: process.env.DATA_DIR || "./data",
  },
  rateLimit: {
    /** Per signed-in user; 0 switches a limit off. One run at a time is always enforced. */
    researchPerHour: num("RATE_RESEARCH_PER_HOUR", 10),
    researchPerDay: num("RATE_RESEARCH_PER_DAY", 40),
    uploadsPerHour: num("RATE_UPLOADS_PER_HOUR", 30),
  },
  cache: {
    /** How long web, Wikipedia and arXiv results are reused (shared by all users). 0 switches it off. */
    searchTtlHours: num("SEARCH_CACHE_TTL_HOURS", 24),
    /** Query embeddings kept in memory. 0 switches it off. */
    embeddingCacheSize: num("EMBEDDING_CACHE_SIZE", 500),
  },
  vector: {
    /** Self-hosted LanceDB service. Leave LANCEDB_URI unset to use BM25 keyword search only. */
    uri: process.env.LANCEDB_URI || "",
    apiKey: process.env.LANCEDB_API_KEY || "",
    tablePrefix: process.env.LANCEDB_AGENT_RESEARCH || "research-agent",
    /** Bump to index into fresh tables without touching the old ones. */
    indexVersion: process.env.INDEX_VERSION || "v1",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    dimensions: num("EMBEDDING_DIMENSIONS", 1536),
    /**
     * Squared L2 distance on unit vectors (2 - 2·cosine). Measured on this data: related
     * questions land at 0.7 to 1.1, unrelated ones at 1.65 and above, so 1.3 splits them.
     */
    maxDistance: num("VECTOR_MAX_DISTANCE", 1.3),
    timeoutMs: num("LANCEDB_TIMEOUT_MS", 10000),
  },
};

export function describeConfig() {
  return {
    provider: config.llm.provider,
    smartModel: config.llm.smartModel,
    fastModel: config.llm.fastModel,
    fallback: config.llm.fallback
      ? `${config.llm.fallback.provider} · ${config.llm.fallback.smartModel}/${config.llm.fallback.fastModel}`
      : null,
    searchProviders: config.search.providers,
    apiSources: config.apis.sources,
    mcp: Boolean(config.apis.mcpServerUrl),
    limits: config.limits,
    tracing: process.env.LANGSMITH_TRACING === "true",
    vector: Boolean(config.vector.uri && config.vector.apiKey),
  };
}
