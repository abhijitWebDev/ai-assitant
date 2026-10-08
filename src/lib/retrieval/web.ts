import { tavily } from "@tavily/core";
import { cachedSearch, normalizeQuery } from "../cache";
import { config } from "../config";

export interface WebHit {
  title: string;
  url: string;
  content: string;
}

interface SearchProvider {
  name: string;
  available: () => boolean;
  search: (query: string, n: number, signal: AbortSignal) => Promise<WebHit[]>;
}

/* ---------------- Tavily (primary) ---------------- */
const tavilyProvider: SearchProvider = {
  name: "tavily",
  available: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, n) {
    const client = tavily({ apiKey: process.env.TAVILY_API_KEY! });
    const res = await client.search(query, { maxResults: n, searchDepth: "advanced", topic: "general" });
    return res.results.map((r) => ({ title: r.title, url: r.url, content: r.content }));
  },
};

/* ---------------- SerpAPI (Google results) ---------------- */
const serpapiProvider: SearchProvider = {
  name: "serpapi",
  available: () => Boolean(process.env.SERPAPI_API_KEY),
  async search(query, n, signal) {
    const url = `https://serpapi.com/search.json?engine=google&num=${n}&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_API_KEY}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const json = (await res.json()) as { organic_results?: { title: string; link: string; snippet?: string }[] };
    return (json.organic_results ?? [])
      .slice(0, n)
      .map((r) => ({ title: r.title, url: r.link, content: r.snippet ?? "" }));
  },
};

/* ---------------- Brave Search ---------------- */
const braveProvider: SearchProvider = {
  name: "brave",
  available: () => Boolean(process.env.BRAVE_API_KEY),
  async search(query, n, signal) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${n}&q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
      signal,
    });
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
    const json = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string; extra_snippets?: string[] }[] };
    };
    return (json.web?.results ?? []).slice(0, n).map((r) => ({
      title: r.title,
      url: r.url,
      content: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(" ").replace(/<[^>]+>/g, ""),
    }));
  },
};

/* ---------------- DuckDuckGo (free, keyless final fallback) ---------------- */
function decodeEntities(s: string) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

const duckduckgoProvider: SearchProvider = {
  name: "duckduckgo",
  available: () => true,
  async search(query, n, signal) {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; ResearchAgent/1.0)",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal,
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
    const html = await res.text();
    const hits: WebHit[] = [];
    const blocks = html.split(/class="result results_links/).slice(1);
    for (const block of blocks) {
      const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let href = a[1];
      const uddg = href.match(/uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith("//")) href = "https:" + href;
      if (href.includes("duckduckgo.com/y.js")) continue; // ads
      hits.push({ title: decodeEntities(a[2]), url: href, content: snip ? decodeEntities(snip[1]) : "" });
      if (hits.length >= n) break;
    }
    return hits;
  },
};

const REGISTRY: Record<string, SearchProvider> = {
  tavily: tavilyProvider,
  serpapi: serpapiProvider,
  brave: braveProvider,
  duckduckgo: duckduckgoProvider,
};

/**
 * Fallback chain (guide §9.4): try providers in order; move on when one throws
 * or returns nothing. Returns which provider answered plus every failure seen.
 * Each provider's results are cached per query, so a repeat search spends no credits.
 */
export async function webSearch(query: string): Promise<{
  provider: string | null;
  hits: WebHit[];
  cached: boolean;
  failures: { provider: string; error: string }[];
}> {
  const failures: { provider: string; error: string }[] = [];
  for (const name of config.search.providers) {
    const p = REGISTRY[name];
    if (!p || !p.available()) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.search.timeoutMs);
    try {
      const n = config.search.resultsPerQuery;
      const { value: hits, cached } = await cachedSearch("web", [p.name, n, normalizeQuery(query)], async () =>
        (await p.search(query, n, controller.signal)).filter((h) => h.url && h.content),
      );
      if (hits.length) return { provider: p.name, hits, cached, failures };
      failures.push({ provider: p.name, error: "no results" });
    } catch (err) {
      failures.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { provider: null, hits: [], cached: false, failures };
}
