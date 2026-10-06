import { z } from "zod";
import { config } from "../../config";
import { callStructured } from "../../llm";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import { numberedEvidence } from "./synthesis";

/**
 * Critic Agent (guide §6.2): reviews the draft on coherence, factual grounding
 * and completeness. The revision loop is capped by MAX_REVISIONS — the guide
 * leaves this loop uncapped, which would let a picky critic loop forever.
 */

const Review = z.object({
  coherence: z.number().int().min(1).max(5).describe("Logical flow and internal consistency"),
  grounding: z.number().int().min(1).max(5).describe("Every claim supported by the cited evidence; no hallucination"),
  completeness: z.number().int().min(1).max(5).describe("All sub-questions answered; no claims left without support"),
  issues: z.array(z.string()).describe("Specific problems found, quoting the offending text where possible"),
  brief: z.string().describe("Concrete revision instructions for the writer. Empty if approved."),
});

const PASS = 4;

export async function critic(state: ResearchStateType): Promise<ResearchUpdate> {
  if (state.revisionCount >= config.limits.maxRevisions) {
    return {
      critique: {
        verdict: "approved",
        coherence: 0,
        grounding: 0,
        completeness: 0,
        brief: "",
        forced: true,
      },
      limitations: [`The critic's revision limit (${config.limits.maxRevisions}) was reached; the last draft was accepted as-is.`],
      messages: [log("critic", `Revision limit reached, forwarding the draft to the citation checker`)],
    };
  }

  try {
    const r = await callStructured({
      tier: "smart",
      schema: Review,
      name: "critic",
      system: `You are a demanding research editor. Review the draft against the evidence.
Score each dimension 1-5. Score ${PASS}+ only if the draft is genuinely good on that dimension.
Grounding: check citations point to evidence that actually supports the sentence. Flag any claim not found in the evidence.
Completeness: check every sub-question is addressed, or the gap is acknowledged honestly.`,
      user: `Research question: ${state.question}
Sub-questions:${state.researchQuestions.map((q) => `\n- ${q}`).join("")}

Evidence:
${numberedEvidence(state.evidenceStore)}

---
Draft:
${state.draftReport}`,
    });
    const approved = r.coherence >= PASS && r.grounding >= PASS && r.completeness >= PASS;
    const brief = approved ? "" : r.brief || r.issues.map((i) => `- ${i}`).join("\n");
    return {
      critique: {
        verdict: approved ? "approved" : "revision_needed",
        coherence: r.coherence,
        grounding: r.grounding,
        completeness: r.completeness,
        brief,
      },
      revisionCount: approved ? state.revisionCount : state.revisionCount + 1,
      messages: [
        log(
          "critic",
          `${approved ? "Approved" : "Revision needed"} (coherence ${r.coherence}/5, grounding ${r.grounding}/5, completeness ${r.completeness}/5)`,
          approved ? undefined : brief,
        ),
      ],
    };
  } catch (err) {
    return {
      critique: { verdict: "approved", coherence: 0, grounding: 0, completeness: 0, brief: "", forced: true },
      limitations: ["The critic review failed, so the draft was not self-reviewed."],
      errors: [{ node: "critic", tool: "llm", error: String(err), at: new Date().toISOString() }],
      messages: [log("critic", "Critic failed, forwarding the draft")],
    };
  }
}

/** Conditional edge out of the Critic (guide §7.4). */
export function routeAfterCritic(state: ResearchStateType): "synthesis" | "citation_checker" {
  return state.critique?.verdict === "revision_needed" ? "synthesis" : "citation_checker";
}
