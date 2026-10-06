import { guardThread, requireUser, threadNotFound } from "@/lib/auth";
import { deleteDocument, documentThread } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const threadId = documentThread(id);
  if (!threadId) return threadNotFound();
  const denied = guardThread(threadId, user);
  if (denied) return denied;
  deleteDocument(id);
  return Response.json({ ok: true });
}
