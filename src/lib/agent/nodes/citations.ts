import { z } from "zod";
import { callStructured } from "../../llm";
import { hostOf, truncate } from "../../text";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { CitationReport, EvidenceChunk } from "../types";
import { numberedEvidence } from "./synthesis";

/**
 * Citation Checker (guide §6.3): the last gate.
 *   1. LLM pass: identify factual claims, match each to evidence, propose exact
 *      text edits that add/correct citations, and flag claims with no support.
 *   2. Deterministic pass: strip citation numbers that don't exist, then build
 *      the Sources section from the evidence that's actually cited.
 */

const Check = z.object({
  totalClaimsChecked: z.number().int(),
  edits: z
    .array(
      z.object({
        original: z.string().describe("Exact substring of the report to replace (copy it character for character)"),
        replacement: z.string().describe("The corrected text, with correct [n] citations"),
      }),
    )
    .describe("Edits that add a missing citation or correct a wrong one"),
  unsupported: z
    .array(z.object({ claim: z.string(), reason: z.string() }))
    .describe("Claims that no evidence supports, even after edits"),
});

const CITE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

function cleanCitations(report: string, max: number) {
  const invalid = new Set<number>();
  const cited = new Set<number>();
  const text = report.replace(CITE, (_m, nums: string) => {
    const kept = nums
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => {
        const ok = n >= 1 && n <= max;
        if (ok) cited.add(n);
        else invalid.add(n);
        return ok;
      });
    return kept.map((n) => `[${n}]`).join("");
  });
  return { text: text.replace(/ +([.,;:])/g, "$1"), invalid: [...invalid], cited: [...cited].sort((a, b) => a - b) };
}

function sourceLabel(e: EvidenceChunk) {
  if (e.sourceType === "doc") return `${e.title} (private document)`;
  if (e.sourceType === "memory") return `${e.title} (from prior research)`;
  return `[${e.title}](${e.url}) — ${hostOf(e.url)}`;
}

export function buildSources(evidence: EvidenceChunk[], cited: number[]): string {
  if (!cited.length) return "## Sources\n\n_No sources were cited._";
  const lines = cited.map((n) => {
    const e = evidence[n - 1];
    return `**[${n}]** ${sourceLabel(e)}  \n_Found via ${e.provider}, retrieved ${e.retrievedAt.slice(0, 10)}_\n\n> ${truncate(e.content.replace(/\s+/g, " "), 280)}`;
  });
  return `## Sources\n\n${lines.join("\n\n")}`;
}

export async function citationChecker(state: ResearchStateType): Promise<ResearchUpdate> {
  const evidence = state.evidenceStore;
  let body = state.draftReport;
  let unsupported: { claim: string; reason: string }[] = [];
  let total = 0;
  let applied = 0;
  const errors: ResearchUpdate["errors"] = [];
  const limitations: string[] = [];
  if (!evidence.length)
    limitations.push("No evidence passed the relevance threshold, so nothing in this report is backed by a retrieved source.");

  if (evidence.length) {
    try {
      const c = await callStructured({
        tier: "smart",
        schema: Check,
        name: "citation_checker",
        system:
          "You are a citation auditor. Go through the report sentence by sentence. For each factual claim, find the evidence entry that supports it. If the citation is missing or points to the wrong entry, propose an exact edit. If no evidence supports the claim, list it as unsupported. Do not rewrite style; only fix citations.",
        user: `Evidence:\n${numberedEvidence(evidence)}\n\n---\nReport:\n${body}`,
      });
      total = c.totalClaimsChecked;
      unsupported = c.unsupported;
      for (const edit of c.edits) {
        if (edit.original && body.includes(edit.original)) {
          body = body.replace(edit.original, edit.replacement);
          applied++;
        }
      }
    } catch (err) {
      errors.push({ node: "citation_checker", tool: "llm", error: String(err), at: new Date().toISOString() });
      limitations.push("The claim-by-claim citation audit failed; only citation numbers were validated.");
    }
  }

  const { text, invalid, cited } = cleanCitations(body, evidence.length);
  const allLimitations = [...state.limitations, ...limitations];

  const notes: string[] = [];
  if (unsupported.length)
    notes.push(
      "**Claims the citation checker could not trace to a source:**\n" +
        unsupported.map((u) => `- “${truncate(u.claim, 200)}” — ${u.reason}`).join("\n"),
    );
  if (allLimitations.length) notes.push("**Limitations of this research:**\n" + [...new Set(allLimitations)].map((l) => `- ${l}`).join("\n"));

  const finalReport = [text, buildSources(evidence, cited), notes.length ? `## Research notes\n\n${notes.join("\n\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");

  const citationReport: CitationReport = {
    totalClaimsChecked: total,
    unsupportedClaims: unsupported,
    invalidCitationsRemoved: invalid,
    citedEvidenceIds: cited,
  };

  return {
    finalReport,
    citationReport,
    errors,
    limitations,
    messages: [
      log(
        "citation_checker",
        `Checked ${total} claims, applied ${applied} fix(es), ${unsupported.length} unsupported, ${invalid.length} invalid citation(s) removed, ${cited.length} sources cited`,
      ),
    ],
  };
}
