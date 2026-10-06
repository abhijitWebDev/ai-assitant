import { z } from "zod";
import { config } from "../../config";
import { callStructured } from "../../llm";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";

/**
 * Research Planner (guide §4.2): decomposes the question into atomic,
 * independently searchable sub-questions. Pure reasoning, no tools (§9.6).
 */

const Plan = z.object({
  subQuestions: z
    .array(z.string())
    .describe("Focused sub-questions that together fully answer the research question"),
});

export async function researchPlanner(state: ResearchStateType): Promise<ResearchUpdate> {
  const max = config.limits.maxSubQuestions;
  try {
    const plan = await callStructured({
      tier: "smart",
      schema: Plan,
      name: "research_planner",
      system: `You are a research planner. Break the research question into 3-${max} sub-questions.
Each sub-question must be specific, answerable from sources, and cover a distinct aspect (definitions, mechanisms, evidence, comparisons, limitations, current state).
Together they must fully answer the original question. No overlap. No numbering.`,
      user: `Research question: ${state.question}\n\nBrief:\n${state.researchBrief}`,
    });
    const researchQuestions = plan.subQuestions.map((q) => q.trim()).filter(Boolean).slice(0, max);
    if (!researchQuestions.length) throw new Error("planner returned no sub-questions");
    return {
      researchQuestions,
      messages: [log("research_planner", `Planned ${researchQuestions.length} sub-questions`, researchQuestions)],
    };
  } catch (err) {
    return {
      researchQuestions: [state.question],
      messages: [log("research_planner", "Planner failed, researching the question as a whole")],
      errors: [{ node: "research_planner", tool: "llm", error: String(err), at: new Date().toISOString() }],
    };
  }
}
