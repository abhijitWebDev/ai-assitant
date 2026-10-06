import { graphMermaid } from "@/lib/agent/graph";
import { describeConfig } from "@/lib/config";

export const runtime = "nodejs";

/** Active configuration (no secrets) plus the compiled graph as a Mermaid diagram (guide §7.5). */
export async function GET() {
  const keys = {
    llm: Boolean(
      process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GROQ_API_KEY,
    ),
    tavily: Boolean(process.env.TAVILY_API_KEY),
  };
  return Response.json({ config: describeConfig(), keys, mermaid: graphMermaid() });
}
