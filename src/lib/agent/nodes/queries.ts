import { z } from "zod";
import { callStructured } from "../../llm";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { PlannedQuery } from "../types";

/**
 * Query Generator (guide §4.4): a sub-question is not a search query.
 * Produces one query per retrieval channel, tuned to how that channel matches text.
 * On a loop it receives the Coverage Evaluator's gap analysis and only targets the gaps.
 */

const Queries = z.object({
  queries: z.array(
    z.object({
      subQuestion: z.string().describe("The sub-question this query serves, copied exactly"),
      webQuery: z.string().describe("Keyword-dense web search query: key entities, technical terms, years. No question words."),
      docQuery: z.string().describe("Distinctive keywords likely to appear verbatim inside a private document"),
      apiQuery: z.string().describe("2-5 word topic phrase for encyclopedia / academic-paper search"),
    }),
  ),
});

export async function queryGenerator(state: ResearchStateType): Promise<ResearchUpdate> {
  const isLoop = state.coverageStatus === "missing";
  const already = state.queryHistory.slice(-30);

  const user = isLoop
    ? `Research question: ${state.question}
Sub-questions: ${state.researchQuestions.map((q) => `\n- ${q}`).join("")}

The coverage evaluator found these gaps:
${state.gapAnalysis}

Queries already tried (do not repeat or lightly reword them):
${already.map((q) => `- ${q}`).join("\n") || "(none)"}

Write 1-4 NEW queries that target only the gaps. Use different angles, sources or terminology than before.`
    : `Research question: ${state.question}
${state.priorContext ? `\nAlready known from prior research (no need to search for this again):\n${state.priorContext}\n` : ""}
Sub-questions:${state.researchQuestions.map((q) => `\n- ${q}`).join("")}

Write exactly one query set per sub-question.`;

  try {
    const out = await callStructured({
      tier: "fast",
      schema: Queries,
      name: "query_generator",
      system:
        "You turn research sub-questions into optimised retrieval queries. Web queries are keyword-dense (entities, technical terms, dates), never phrased as questions. Example: 'What were the limitations of pre-transformer NLP models?' -> 'RNN LSTM limitations natural language processing before transformers'.",
      user,
    });
    const seen = new Set(already.map((q) => q.toLowerCase()));
    const pendingQueries: PlannedQuery[] = out.queries.filter((q) => q.webQuery && !seen.has(q.webQuery.toLowerCase()));
    if (!pendingQueries.length) throw new Error("no new queries generated");
    return {
      pendingQueries,
      queryHistory: pendingQueries.map((q) => q.webQuery),
      messages: [
        log(
          "query_generator",
          `${isLoop ? "Gap-filling" : "Generated"} ${pendingQueries.length} quer${pendingQueries.length === 1 ? "y" : "ies"}`,
          pendingQueries.map((q) => q.webQuery),
        ),
      ],
    };
  } catch (err) {
    // Fallback: search the sub-questions directly so the pipeline keeps moving.
    const pendingQueries = (isLoop ? [state.gapAnalysis || state.question] : state.researchQuestions).map((q) => ({
      subQuestion: q,
      webQuery: q,
      docQuery: q,
      apiQuery: q.split(/\s+/).slice(0, 6).join(" "),
    }));
    return {
      pendingQueries,
      queryHistory: pendingQueries.map((q) => q.webQuery),
      messages: [log("query_generator", "Query model failed, using sub-questions as queries")],
      errors: [{ node: "query_generator", tool: "llm", error: String(err), at: new Date().toISOString() }],
    };
  }
}
