import { ensureThread, listDocuments, saveDocument } from "@/lib/db";
import { chunkText, extractText, indexDocument } from "@/lib/retrieval/docs";

export const runtime = "nodejs";

const MAX_BYTES = 15 * 1024 * 1024;

/** POST multipart { threadId, file } — parse, chunk and index a private document for this thread. */
export async function POST(request: Request) {
  const form = await request.formData();
  const threadId = String(form.get("threadId") ?? "").trim();
  const file = form.get("file");
  if (!threadId || !(file instanceof File)) {
    return Response.json({ error: "Send a threadId and a file." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "Files must be 15 MB or smaller." }, { status: 413 });
  }
  try {
    const text = await extractText({ name: file.name, type: file.type, buffer: Buffer.from(await file.arrayBuffer()) });
    if (!text.trim()) {
      return Response.json(
        { error: `No text found in ${file.name}. Scanned PDFs need OCR before upload.` },
        { status: 422 },
      );
    }
    ensureThread(threadId, `Documents: ${file.name}`);
    const chunks = chunkText(text);
    const doc = saveDocument(threadId, file.name, file.type || "application/octet-stream", text, chunks);
    // The document is saved either way; without vectors it is still found by keyword search.
    let warning: string | undefined;
    try {
      await indexDocument(doc);
    } catch (err) {
      console.warn("[lancedb] indexing failed for", doc.name, err);
      warning = `${file.name} was added, but semantic indexing failed, so only keyword search will find it.`;
    }
    return Response.json({ document: doc, chunks: chunks.length, documents: listDocuments(threadId), warning });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
