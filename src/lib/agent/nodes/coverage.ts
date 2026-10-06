import { z } from "zod";
import { config } from "../../config";
import { callStructured } from "../../llm";
import { truncate } from "../../text";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";

/**
 * Coverage Evaluator (guide §5): the decision gate of the research loop.
 * Checks the iteration cap FIRST (§9.3) so the loop can never run forever.
 */

const Coverage = z.object({
  perQuestion: z.array(
    z.object({
      subQuestion: z.string(),
      covered: z.boolean(),
      note: z.string().describe("What evidence exists, or exactly what is missing"),
    }),
  ),
  verdict: z.enum(["sufficient", "missing"]),
  gapAnalysis: z
    .string()
    .describe("If missing: precisely what evidence is still needed and suggested angles to find it. Empty if sufficient."),
});

export async function coverageEvaluator(state: ResearchStateType): Promise<ResearchUpdate> {
  const max = config.limits.maxResearchIterations;
  if (state.iterationCount >= max) {
    return {
      coverageStatus: "sufficient",
      limitations: [
        `The research loop hit its limit of ${max} extra pass(es); coverage may be incomplete for: ${state.gapAnalysis || "some sub-questions"}.`,
      ],
      messages: [log("coverage_evaluator", `Iteration limit (${max}) reached, proceeding to synthesis with current evidence`)],
    };
  }

  const bySub = state.researchQuestions.map((q) => {
    const ev = state.evidenceStore.filter((e) => e.subQuestion === q);
    return `### ${q}\n${ev.length ? ev.map((e) => `- (${e.score}/10, ${e.provider}) ${truncate(e.content, 300)}`).join("\n") : "- (no evidence yet)"}`;
  });
  const memory = state.evidenceStore.filter((e) => e.sourceType === "memory");
  if (memory.length) bySub.push(`### From prior research\n${memory.map((e) => `- ${truncate(e.content, 300)}`).join("\n")}`);

  try {
    const c = await callStructured({
      tier: "smart",
      schema: Coverage,
      name: "coverage_evaluator",
      system: `You judge whether gathered evidence is enough to write a well-grounded report.
A sub-question is covered when there is at least one specific, relevant passage (ideally two independent sources) that answers it.
Return "sufficient" if every sub-question that matters to the core research question is covered. Return "missing" if key sub-questions are unanswered or evidence is too thin.
Do not demand perfection: minor gaps are fine.`,
      user: `Research question: ${state.question}\n\nEvidence store (${state.evidenceStore.length} chunks), grouped by sub-question:\n\n${bySub.join("\n\n")}`,
    });
    const covered = c.perQuestion.filter((p) => p.covered).length;
    if (c.verdict === "missing") {
      return {
        coverageStatus: "missing",
        gapAnalysis: c.gapAnalysis || c.perQuestion.filter((p) => !p.covered).map((p) => `${p.subQuestion}: ${p.note}`).join("\n"),
        iterationCount: state.iterationCount + 1,
        messages: [
          log("coverage_evaluator", `Missing evidence (${covered}/${c.perQuestion.length} covered), looping back`, c.gapAnalysis),
        ],
      };
    }
    return {
      coverageStatus: "sufficient",
      gapAnalysis: "",
      messages: [log("coverage_evaluator", `Coverage sufficient (${covered}/${c.perQuestion.length} sub-questions covered)`)],
    };
  } catch (err) {
    return {
      coverageStatus: "sufficient",
      limitations: ["The coverage check failed, so the report was written without a final completeness review."],
      errors: [{ node: "coverage_evaluator", tool: "llm", error: String(err), at: new Date().toISOString() }],
      messages: [log("coverage_evaluator", "Evaluator failed, proceeding to synthesis")],
    };
  }
}

/** Conditional edge out of the Coverage Evaluator (guide §7.4). */
export function routeAfterCoverage(state: ResearchStateType): "query_generator" | "synthesis" {
  return state.coverageStatus === "missing" ? "query_generator" : "synthesis";
}
