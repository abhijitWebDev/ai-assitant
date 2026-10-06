import { deleteThread, listDocuments, listReports } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
  const { id } = await ctx.params;
  deleteThread(id);
  return Response.json({ ok: true });
}
