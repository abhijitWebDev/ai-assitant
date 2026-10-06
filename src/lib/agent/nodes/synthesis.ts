import { callText } from "../../llm";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { EvidenceChunk } from "../types";

/**
 * Synthesis Agent (guide §6.1): writes the Markdown report from the evidence store.
 * Cites evidence as [n]. The Sources section is built deterministically later by the
 * Citation Checker, so the model can't invent a URL.
 */

export function numberedEvidence(evidence: EvidenceChunk[]): string {
  return evidence
    .map((e, i) => `[${i + 1}] ${e.title} — ${e.url}\n(sub-question: ${e.subQuestion})\n${e.content}`)
    .join("\n\n");
}

const SYSTEM = `You are a senior research analyst writing a report strictly from the evidence provided.

Rules:
- Every factual sentence must end with one or more citations like [3] or [2][5], using the evidence numbers given.
- Use ONLY facts present in the evidence. If evidence for something is missing, say so plainly instead of filling the gap.
- Where sources disagree, say so and cite both.
- Write for the stated audience. Clear, specific, no filler.

Output Markdown with exactly this structure:
# <A specific title for the report>

## Summary
<2-3 paragraphs: the key takeaways for someone who reads nothing else>

## Key Findings
### <Theme 1>
<paragraphs and/or bullet points, all cited>
### <Theme 2>
...

Do NOT write a Sources or References section; it is generated automatically.`;

export async function synthesis(state: ResearchStateType): Promise<ResearchUpdate> {
  const revising = state.critique?.verdict === "revision_needed" && Boolean(state.draftReport);
  const evidence = state.evidenceStore;

  const user = `Research question: ${state.question}

Brief:
${state.researchBrief}

Sub-questions to address:${state.researchQuestions.map((q) => `\n- ${q}`).join("")}
${state.limitations.length ? `\nKnown limitations of this research (mention briefly where relevant):\n${state.limitations.map((l) => `- ${l}`).join("\n")}\n` : ""}
Evidence (${evidence.length} chunks):

${evidence.length ? numberedEvidence(evidence) : "(No evidence was retrieved. Write a short report that states this clearly and makes no factual claims.)"}
${
  revising
    ? `\n---\nYour previous draft was reviewed and needs revision.\n\nReviewer's brief:\n${state.critique!.brief}\n\nPrevious draft:\n${state.draftReport}\n\nRewrite the full report, fixing every issue in the brief.`
    : ""
}`;

  try {
    let draft = await callText({ tier: "smart", name: revising ? "synthesis_revision" : "synthesis", system: SYSTEM, user });
    draft = draft
      .replace(/^```(?:markdown)?\s*/i, "")
      .replace(/```\s*$/, "")
      .replace(/\n#{1,3}\s*(Sources|References)\b[\s\S]*$/i, "")
      .trim();
    return {
      draftReport: draft,
      messages: [
        log("synthesis", revising ? "Rewrote the draft from the critic's brief" : `Drafted the report from ${evidence.length} evidence chunks`),
      ],
    };
  } catch (err) {
    return {
      draftReport: state.draftReport || `# ${state.question}\n\n## Summary\n\nThe report could not be generated because the language model failed.`,
      errors: [{ node: "synthesis", tool: "llm", error: String(err), at: new Date().toISOString() }],
      limitations: ["Report generation failed at the synthesis step."],
      messages: [log("synthesis", "Synthesis failed")],
    };
  }
}
