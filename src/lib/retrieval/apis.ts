import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config";
import type { WebHit } from "./web";

/**
 * Structured-knowledge channel (guide §4.5 "APIs and MCP Servers").
 * Add your own adapter to API_ADAPTERS — anything that returns WebHit[] works:
 * an academic database, an internal REST API, a vector DB, etc.
 */
export interface ApiAdapter {
  name: string;
  search: (query: string, signal: AbortSignal) => Promise<WebHit[]>;
}

const UA = { "User-Agent": "ResearchAgent/1.0 (learning project)" };

const wikipedia: ApiAdapter = {
  name: "wikipedia",
  async search(query, signal) {
    const s = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=${encodeURIComponent(query)}`,
      { headers: UA, signal },
    );
    if (!s.ok) throw new Error(`Wikipedia HTTP ${s.status}`);
    const sj = (await s.json()) as { query?: { search?: { pageid: number; title: string }[] } };
    const pages = sj.query?.search ?? [];
    if (!pages.length) return [];
    const e = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&pageids=${pages
        .map((p) => p.pageid)
        .join("|")}`,
      { headers: UA, signal },
    );
    if (!e.ok) throw new Error(`Wikipedia HTTP ${e.status}`);
    const ej = (await e.json()) as { query?: { pages?: Record<string, { title: string; extract?: string }> } };
    return Object.values(ej.query?.pages ?? {})
      .filter((p) => p.extract)
      .map((p) => ({
        title: `${p.title} (Wikipedia)`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
        content: p.extract!.slice(0, 2000),
      }));
  },
};

const arxiv: ApiAdapter = {
  name: "arxiv",
  async search(query, signal) {
    const res = await fetch(
      `https://export.arxiv.org/api/query?max_results=2&sortBy=relevance&search_query=all:${encodeURIComponent(query)}`,
      { headers: UA, signal },
    );
    if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
    const xml = await res.text();
    const entries = xml.split("<entry>").slice(1);
    return entries.map((entry) => {
      const pick = (tag: string) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
      return {
        title: `${pick("title").replace(/\s+/g, " ")} (arXiv)`,
        url: pick("id"),
        content: pick("summary").replace(/\s+/g, " "),
      };
    });
  },
};

/** Generic MCP adapter: calls one search-style tool on a Streamable HTTP MCP server. */
const mcp: ApiAdapter = {
  name: "mcp",
  async search(query) {
    const client = new Client({ name: "research-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(config.apis.mcpServerUrl));
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: config.apis.mcpToolName,
        arguments: { [config.apis.mcpQueryArg]: query },
      });
      const parts = (result.content as { type: string; text?: string }[] | undefined) ?? [];
      return parts
        .filter((p) => p.type === "text" && p.text)
        .map((p, i) => ({
          title: `${config.apis.mcpToolName} result ${i + 1} (MCP)`,
          url: `${config.apis.mcpServerUrl}#${config.apis.mcpToolName}:${encodeURIComponent(query)}:${i}`,
          content: p.text!.slice(0, 2000),
        }));
    } finally {
      await client.close();
    }
  },
};

const API_ADAPTERS: Record<string, ApiAdapter> = { wikipedia, arxiv };

export function activeApiAdapters(): ApiAdapter[] {
  const list = config.apis.sources.map((s) => API_ADAPTERS[s]).filter(Boolean);
  if (config.apis.mcpServerUrl) list.push(mcp);
  return list;
}
