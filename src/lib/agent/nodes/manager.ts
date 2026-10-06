import { Overwrite } from "@langchain/langgraph";
import { z } from "zod";
import { callStructured } from "../../llm";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";

/**
 * Research Manager (guide §4.1): the orchestrator. It doesn't research; it
 * interprets intent with the higher-capability model, resets per-run state
 * (the checkpointer keeps state between runs on the same thread), and the
 * graph then fans out to the Planner and Context Manager in parallel.
 */

const Brief = z.object({
  objective: z.string().describe("What the user ultimately wants to know, in one sentence"),
  scope: z.string().describe("What is in and out of scope, time period, geography, depth"),
  audience: z.string().describe("Who the report is for and the right level of technicality"),
});

export async function researchManager(state: ResearchStateType): Promise<ResearchUpdate> {
  let researchBrief = `Objective: ${state.question}`;
  const errors: ResearchUpdate["errors"] = [];
  try {
    const b = await callStructured({
      tier: "smart",
      schema: Brief,
      name: "research_manager",
      system:
        "You are the lead of a research team. Interpret the user's research question precisely: the real objective, a sensible scope, and the audience. Do not answer the question.",
      user: `Research question: ${state.question}`,
    });
    researchBrief = `Objective: ${b.objective}\nScope: ${b.scope}\nAudience: ${b.audience}`;
  } catch (err) {
    errors.push({ node: "research_manager", tool: "llm", error: String(err), at: new Date().toISOString() });
  }

  return {
    researchBrief,
    // Reset everything that belongs to a single run. Overwrite bypasses the append reducers.
    messages: new Overwrite([log("research_manager", "Research brief ready, starting planner and context manager", researchBrief)]),
    evidenceStore: new Overwrite([]),
    queryHistory: new Overwrite([]),
    limitations: new Overwrite([]),
    errors: new Overwrite(errors),
    researchQuestions: [],
    pendingQueries: [],
    rawResults: [],
    coverageStatus: "",
    gapAnalysis: "",
    iterationCount: 0,
    draftReport: "",
    critique: null,
    revisionCount: 0,
    citationReport: null,
    finalReport: "",
  };
}
