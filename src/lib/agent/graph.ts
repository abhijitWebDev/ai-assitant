import { END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { dataPath } from "../db";
import { citationChecker } from "./nodes/citations";
import { contextManager } from "./nodes/context";
import { coverageEvaluator, routeAfterCoverage } from "./nodes/coverage";
import { critic, routeAfterCritic } from "./nodes/critic";
import { evidenceExtractor } from "./nodes/extractor";
import { inputGuardrail, routeAfterGuardrail } from "./nodes/guardrail";
import { researchManager } from "./nodes/manager";
import { researchPlanner } from "./nodes/planner";
import { queryGenerator } from "./nodes/queries";
import { sourceProcessor } from "./nodes/sources";
import { synthesis } from "./nodes/synthesis";
import { ResearchState } from "./state";

/**
 * Section 7: wiring the workflow.
 *
 *   START → input_guardrail ─(blocked)→ END
 *              │ (allowed)
 *        research_manager
 *          ├── research_planner ──┐
 *          └── context_manager ───┴→ query_generator → source_processor → evidence_extractor → coverage_evaluator
 *                                         ▲                                                          │
 *                                         └──────────────── "missing" ───────────────────────────────┤
 *                                                                                      "sufficient"  ▼
 *                                                     citation_checker ←"approved"— critic ← synthesis
 *                                                           │                         └"revision_needed"→ synthesis
 *                                                          END
 */
export function buildWorkflow() {
  return (
    new StateGraph(ResearchState)
      // 7.2 Registering nodes
      .addNode("input_guardrail", inputGuardrail)
      .addNode("research_manager", researchManager)
      .addNode("research_planner", researchPlanner)
      .addNode("context_manager", contextManager)
      .addNode("query_generator", queryGenerator)
      .addNode("source_processor", sourceProcessor)
      .addNode("evidence_extractor", evidenceExtractor)
      .addNode("coverage_evaluator", coverageEvaluator)
      .addNode("synthesis", synthesis)
      .addNode("critic", critic)
      .addNode("citation_checker", citationChecker)

      // 7.3 Fixed edges
      .addEdge(START, "input_guardrail")
      .addConditionalEdges("input_guardrail", routeAfterGuardrail, ["research_manager", END])
      // Fan-out: Planner and Context Manager run in parallel...
      .addEdge("research_manager", "research_planner")
      .addEdge("research_manager", "context_manager")
      // ...and the Query Generator waits for both (a join).
      .addEdge(["research_planner", "context_manager"], "query_generator")
      .addEdge("query_generator", "source_processor")
      .addEdge("source_processor", "evidence_extractor")
      .addEdge("evidence_extractor", "coverage_evaluator")

      // 7.4 Conditional edges: the research loop and the revision loop
      .addConditionalEdges("coverage_evaluator", routeAfterCoverage, ["query_generator", "synthesis"])
      .addEdge("synthesis", "critic")
      .addConditionalEdges("critic", routeAfterCritic, ["synthesis", "citation_checker"])
      .addEdge("citation_checker", END)
  );
}

// 7.5 + 7.6: compile once with a SQLite checkpointer (persistent memory keyed by thread_id).
// Cached on globalThis so Next.js hot reloads don't open a new DB connection each time.
const g = globalThis as unknown as {
  __researchGraph?: ReturnType<ReturnType<typeof buildWorkflow>["compile"]>;
};

export function getGraph() {
  if (!g.__researchGraph) {
    const checkpointer = SqliteSaver.fromConnString(dataPath("checkpoints.sqlite"));
    g.__researchGraph = buildWorkflow().compile({ checkpointer });
  }
  return g.__researchGraph;
}

export function graphMermaid(): string {
  return buildWorkflow().compile().getGraph().drawMermaid();
}
