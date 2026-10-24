import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../../config";
import { askJev, jevEnabled, type JevQuestion } from "../../jev";
import { callStructured, mapLimit, shrinkToFit } from "../../llm";
import { truncate } from "../../text";
import { log, type ResearchStateType, type ResearchUpdate } from "../state";
import type { EvidenceChunk, RawResult, ToolError } from "../types";

/**
 * Evidence Extractor (guide §4.6): for every raw result
 *   1. extracts the passage that actually answers the sub-question
 *   2. scores it 0-10 for relevance
 * Deduplication, the relevance threshold and size-capped eviction happen in the
 * evidence-store reducer (state.ts), so they apply to every write, not just this node.
 */

const Scored = z.object({
  items: z.array(
    z.object({
      index: z.number().int().describe("The [n] number of the result"),
      score: z.number().min(0).max(10).describe("Relevance to the sub-question: 0 = unrelated, 10 = directly answers it"),
      passage: z
        .string()
        .describe("The relevant facts from the result, kept close to the original wording, max ~120 words. Empty if irrelevant."),
    }),
  ),
});

/**
 * Jev pre-filter: one call scores every result for the sub-question, and results it is
 * confident are unrelated never reach the LLM. Only clear misses are dropped; the LLM
 * still scores everything else 0-10. If Jev fails, nothing is dropped.
 */
export async function jevPrefilter(
  subQuestion: string,
  results: RawResult[],
): Promise<{ kept: RawResult[]; dropped: number; error?: string }> {
  if (!jevEnabled() || results.length < 2) return { kept: results, dropped: 0 };
  try {
    const questions: Record<string, JevQuestion> = {};
    results.forEach((_, i) => {
      questions[`r${i + 1}`] = {
        type: "score",
        instructions: `How useful is result [${i + 1}] for answering the sub-question?`,
        criteria: [
          "Unrelated to the sub-question",
          "Same general topic, but says nothing that answers it",
          "Partly answers it",
          "Mostly answers it",
          "Directly answers it with specific facts",
        ],
      };
    });
    const state = {
      subQuestion,
      results: results.map((r, i) => ({ n: i + 1, title: r.title, content: truncate(r.content, 1500) })),
    };
    const answers = await askJev(state, questions);
    const kept = results.filter((_, i) => {
      const a = answers[`r${i + 1}`];
      return !(a.type === "score" && a.score < config.jev.dropBelowScore && a.confidence >= config.jev.dropConfidence);
    });
    return { kept, dropped: results.length - kept.length };
  } catch (err) {
    return { kept: results, dropped: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function evidenceExtractor(state: ResearchStateType): Promise<ResearchUpdate> {
  // Group by sub-question and drop exact URL repeats inside each group.
  const groups = new Map<string, RawResult[]>();
  for (const r of state.rawResults) {
    const g = groups.get(r.subQuestion) ?? [];
    if (!g.some((x) => x.url === r.url && x.content === r.content)) g.push(r);
    groups.set(r.subQuestion, g);
  }

  const errors: ToolError[] = [];
  const retrievedAt = new Date().toISOString();

  let jevDropped = 0;
  const perGroup = await mapLimit([...groups.entries()], config.limits.llmConcurrency, async ([subQuestion, all]) => {
    const { kept: results, dropped, error } = await jevPrefilter(subQuestion, all);
    jevDropped += dropped;
    if (error) errors.push({ node: "evidence_extractor", tool: "jev", query: subQuestion, error: `${error} (no pre-filter)`, at: retrievedAt });
    if (!results.length) return [];
    const listing = (cap: number) =>
      results.map((r, i) => `[${i + 1}] ${r.title} (${r.sourceType}/${r.provider})\n${truncate(r.content, cap)}`).join("\n\n");
    const prompt = (cap: number) => `Sub-question: ${subQuestion}\n\nResults:\n${listing(cap)}`;
    try {
      const out = await callStructured({
        tier: "fast",
        schema: Scored,
        name: "evidence_extractor",
        system:
          "You extract evidence for a research sub-question. For each numbered result, pull out only the facts relevant to the sub-question and score relevance strictly. Never add facts that are not in the result.",
        user: prompt(1500),
        // The fallback model has a small per-minute token limit: read less of each result.
        fit: (maxChars) => shrinkToFit(prompt, maxChars, 1500, 200),
      });
      return out.items
        .filter((it) => it.index >= 1 && it.index <= results.length && it.passage.trim())
        .map((it): EvidenceChunk => {
          const r = results[it.index - 1];
          return {
            id: randomUUID(),
            subQuestion,
            content: it.passage.trim(),
            title: r.title,
            url: r.url,
            sourceType: r.sourceType,
            provider: r.provider,
            retrievedAt,
            score: it.score,
          };
        });
    } catch (err) {
      errors.push({ node: "evidence_extractor", tool: "llm", query: subQuestion, error: String(err), at: retrievedAt });
      // Degrade gracefully: keep raw content at the threshold score so research can continue.
      return results.map(
        (r): EvidenceChunk => ({
          id: randomUUID(),
          subQuestion,
          content: truncate(r.content, 800),
          title: r.title,
          url: r.url,
          sourceType: r.sourceType,
          provider: r.provider,
          retrievedAt,
          score: config.limits.minRelevance,
        }),
      );
    }
  });

  const candidates = perGroup.flat();
  const passing = candidates.filter((c) => c.score >= config.limits.minRelevance).length;

  return {
    evidenceStore: candidates,
    errors,
    messages: [
      log(
        "evidence_extractor",
        `Scored ${candidates.length} passages, ${passing} passed the relevance threshold (≥${config.limits.minRelevance})` +
          (jevDropped ? `; Jev filtered out ${jevDropped} unrelated result${jevDropped === 1 ? "" : "s"} first` : ""),
      ),
    ],
  };
}
