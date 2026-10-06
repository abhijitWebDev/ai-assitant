import { requireUser } from "@/lib/auth";
import { listThreads } from "@/lib/db";

export const runtime = "nodejs";

/** The signed-in user's threads, newest first. */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json({ threads: listThreads(user) });
}
