import { config } from "./config";

/**
 * Jev (TypeSafe's "System One" model): fast typed decisions, not text. Used where an
 * agent only needs to judge something, so the LLM can be skipped when Jev is sure.
 * Every caller treats a failure as "no answer" and falls back to its LLM path.
 * API: https://docs.typesafe.ai/introduction/quickstart
 */

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export function jevEnabled(): boolean {
  return Boolean(config.jev.apiKey);
}

/** Ask several typed questions about one state in a single call. Throws on any failure. */
export async function askJev<K extends string>(
  state: string | Record<string, unknown>,
  questions: Record<K, JevQuestion>,
): Promise<Record<K, JevAnswer>> {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.jev.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.jev.model, state, questions }),
    signal: AbortSignal.timeout(config.jev.timeoutMs),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const json = (await res.json()) as { answers?: Record<K, JevAnswer> };
  if (!json.answers) throw new Error("Jev returned no answers");
  for (const id of Object.keys(questions) as K[])
    if (!json.answers[id]) throw new Error(`Jev returned no answer for "${id}"`);
  return json.answers;
}
