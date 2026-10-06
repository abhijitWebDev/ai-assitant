"use client";

import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EvidenceChunk, LogEntry, ToolError } from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** Turn [n] citations in the body into links to the matching source entry. */
function linkCitations(md: string): string {
  const idx = md.search(/\n## Sources\b/);
  const body = idx >= 0 ? md.slice(0, idx) : md;
  const rest = idx >= 0 ? md.slice(idx) : "";
  return body.replace(/[ \t]*\[(\d+)\](?![(\]])/g, "[$1](#src-$1)") + rest;
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

const components: Components = {
  a({ href, children, ...rest }) {
    if (href?.startsWith("#src-")) {
      return (
        <a
          href={href}
          className="mx-px inline-block rounded border border-card-edge-hover px-1 align-super font-mono text-[0.66rem] leading-tight font-medium !text-highlight !no-underline transition-colors hover:border-highlight"
          aria-label={`Source ${textOf(children)}`}
        >
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  strong({ children }) {
    const m = textOf(children).match(/^\[(\d+)\]$/);
    return m ? <strong id={`src-${m[1]}`}>{children}</strong> : <strong>{children}</strong>;
  },
};

export interface ReportMeta {
  iterationCount?: number;
  revisionCount?: number;
  durationMs?: number;
  citationReport?: { totalClaimsChecked: number; unsupportedClaims: unknown[]; citedEvidenceIds: number[] } | null;
  critique?: { coherence: number; grounding: number; completeness: number; forced?: boolean } | null;
}

/** Relevance as coloured text: green for strong, yellow for medium, grey otherwise. */
function relevanceTone(score: number) {
  if (score >= 8) return "text-green-700 dark:text-green-400";
  if (score >= 5) return "text-yellow-700 dark:text-yellow-400";
  return "text-muted-foreground";
}

export default function ReportView({
  report,
  evidence,
  log,
  errors,
  meta,
  live,
}: {
  report: string;
  evidence: EvidenceChunk[];
  log: LogEntry[];
  errors: ToolError[];
  meta: ReportMeta;
  live?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const md = useMemo(() => linkCitations(report), [report]);

  const facts = [
    meta.durationMs ? `${Math.round(meta.durationMs / 1000)}s` : null,
    meta.iterationCount !== undefined ? `${meta.iterationCount + 1} research pass${meta.iterationCount ? "es" : ""}` : null,
    meta.revisionCount !== undefined ? `${meta.revisionCount} revision${meta.revisionCount === 1 ? "" : "s"}` : null,
    meta.citationReport ? `${meta.citationReport.citedEvidenceIds.length} of ${evidence.length} chunks cited` : null,
  ].filter(Boolean) as string[];

  const copy = async () => {
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const download = () => {
    const blob = new Blob([report], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const title = report.match(/^#\s+(.+)$/m)?.[1] ?? "research-report";
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Tabs defaultValue="report">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <TabsList className="min-w-0 flex-1">
          <TabsTrigger value="report">{live ? "Draft" : "Report"}</TabsTrigger>
          <TabsTrigger value="evidence">
            Evidence <span className="font-mono text-xs text-muted-foreground">{evidence.length}</span>
          </TabsTrigger>
          <TabsTrigger value="log">
            Run log
            {errors.length > 0 && <span className="font-mono text-xs text-red-700 dark:text-red-400">{errors.length}</span>}
          </TabsTrigger>
        </TabsList>
        {!live && report && (
          <div className="flex gap-1 pb-1.5">
            <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy Markdown">
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" onClick={download}>
              <Download aria-hidden />
              Download .md
            </Button>
          </div>
        )}
      </div>

      <TabsContent value="report" className="pt-2">
        {facts.length > 0 && (
          <div className="mb-8 flex flex-wrap gap-1.5">
            {facts.map((f) => (
              <Chip key={f} className="font-mono">
                {f}
              </Chip>
            ))}
          </div>
        )}
        {live && (
          <p className="mb-6 rounded-lg border border-dashed border-card-edge-hover px-4 py-2.5 text-sm text-muted-foreground">
            This is the <span className="highlight">current draft</span>. It may change after the critic and citation checker
            review it.
          </p>
        )}
        <article className="report">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {md}
          </ReactMarkdown>
        </article>
      </TabsContent>

      <TabsContent value="evidence" className="pt-2">
        {evidence.length === 0 && <p className="text-sm text-muted-foreground">No evidence passed the relevance threshold.</p>}
        <ol className="grid gap-3 md:grid-cols-2">
          {evidence.map((e, i) => (
            <li key={e.id} className="card-chai flex flex-col gap-2 p-4 sm:opacity-90 sm:hover:opacity-100">
              <div className="flex items-start gap-3">
                <span className="font-mono text-sm text-highlight">[{i + 1}]</span>
                <div className="min-w-0 flex-1">
                  {e.url.startsWith("http") ? (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex items-start gap-1 font-montserrat text-sm leading-snug font-semibold transition-colors hover:text-brand"
                    >
                      <span className="line-clamp-2">{e.title}</span>
                      <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-50 group-hover:opacity-100" aria-hidden />
                    </a>
                  ) : (
                    <span className="font-montserrat text-sm font-semibold">{e.title}</span>
                  )}
                </div>
                <span className={cn("shrink-0 font-mono text-xs", relevanceTone(e.score))} title="Relevance">
                  {e.score}/10
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Chip>{e.sourceType}</Chip>
                <Chip>via {e.provider}</Chip>
              </div>
              <p className="text-xs text-muted-foreground">For: {e.subQuestion}</p>
              <p className="line-clamp-6 text-sm leading-relaxed text-foreground/80">{e.content}</p>
            </li>
          ))}
        </ol>
      </TabsContent>

      <TabsContent value="log" className="pt-2">
        <div className="space-y-8 text-sm">
          {log.length > 0 && (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {log.map((l, i) => (
                <li key={i} className="relative">
                  <span aria-hidden className="absolute top-2 left-[-23.5px] size-2 rounded-full border border-border bg-background" />
                  <span className="font-mono text-xs text-muted-foreground">{l.node.replace(/_/g, " ")}</span>
                  <p className="mt-0.5">{l.message}</p>
                  {Array.isArray(l.detail) && (
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {(l.detail as string[]).map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  )}
                  {typeof l.detail === "string" && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{l.detail}</p>}
                </li>
              ))}
            </ol>
          )}
          {log.length === 0 && <p className="text-muted-foreground">The step-by-step log is shown for runs made in this session.</p>}
          {errors.length > 0 && (
            <div>
              <h3 className="mb-3 font-montserrat font-semibold">Tool issues handled during the run</h3>
              <ul className="space-y-2">
                {errors.map((e, i) => (
                  <li key={i} className="rounded-lg border border-red-600/30 px-3 py-2 text-red-700 dark:border-red-400/30 dark:text-red-400">
                    <span className="font-medium">{e.tool}</span>
                    {e.query ? ` for “${e.query}”` : ""}: {e.error.slice(0, 240)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
