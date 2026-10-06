export type SourceType = "web" | "doc" | "api" | "memory";

/** A raw hit from any retrieval channel, before the Evidence Extractor scores it. */
export interface RawResult {
  subQuestion: string;
  query: string;
  sourceType: SourceType;
  /** Which provider actually answered (tavily, serpapi, duckduckgo, wikipedia, arxiv, mcp, docs…). */
  provider: string;
  title: string;
  url: string;
  content: string;
}

/** A scored, deduplicated passage in the evidence store. */
export interface EvidenceChunk {
  id: string;
  subQuestion: string;
  content: string;
  title: string;
  url: string;
  sourceType: SourceType;
  provider: string;
  retrievedAt: string;
  /** Relevance to the sub-question, 0-10. */
  score: number;
}

export interface PlannedQuery {
  subQuestion: string;
  webQuery: string;
  docQuery: string;
  apiQuery: string;
}

export interface LogEntry {
  node: string;
  message: string;
  at: string;
  detail?: unknown;
}

/** Tool failures are recorded as data, never thrown through the graph. */
export interface ToolError {
  node: string;
  tool: string;
  query?: string;
  error: string;
  at: string;
}

export type GuardrailCategory = "valid" | "gibberish" | "off_topic" | "jailbreak" | "too_vague";

export interface GuardrailResult {
  allowed: boolean;
  category: GuardrailCategory;
  message: string;
}

export interface CritiqueResult {
  verdict: "approved" | "revision_needed";
  coherence: number;
  grounding: number;
  completeness: number;
  brief: string;
  forced?: boolean;
}

export interface CitationReport {
  totalClaimsChecked: number;
  unsupportedClaims: { claim: string; reason: string }[];
  invalidCitationsRemoved: number[];
  citedEvidenceIds: number[];
}
