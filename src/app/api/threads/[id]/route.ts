import { guardThread, requireUser } from "@/lib/auth";
import { deleteThread, listDocuments, listReports } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const denied = guardThread(id, user);
  if (denied) return denied;
  const reports = listReports(id).map((r) => ({
    id: r.id,
    question: r.question,
    report: r.report,
    created_at: r.created_at,
    evidence: JSON.parse(r.evidence_json),
    meta: JSON.parse(r.meta_json),
  }));
  return Response.json({ reports, documents: listDocuments(id) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const denied = guardThread(id, user);
  if (denied) return denied;
  deleteThread(id);
  return Response.json({ ok: true });
}
