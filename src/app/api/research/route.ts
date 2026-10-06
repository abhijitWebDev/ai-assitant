import { runResearch } from "@/lib/agent/run";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST { question, threadId } → Server-Sent Events, one event per agent step.
 * Closing the connection aborts the graph run.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { question?: string; threadId?: string } | null;
  const question = body?.question?.trim();
  const threadId = body?.threadId?.trim();
  if (!question || !threadId) {
    return Response.json({ error: "Send a question and a threadId." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        for await (const event of runResearch({ question, threadId, signal: request.signal })) send(event);
      } catch (err) {
        if (!request.signal.aborted) {
          console.error("[research] run failed", err);
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
