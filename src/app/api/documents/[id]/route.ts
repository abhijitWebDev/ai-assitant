import { deleteDocument } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteDocument(id);
  return Response.json({ ok: true });
}
