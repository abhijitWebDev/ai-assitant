import { auth } from "@clerk/nextjs/server";
import { canUseThread } from "./db";

/**
 * The signed-in Clerk user for an API route, or a ready-made error response.
 *
 *   const user = await requireUser();
 *   if (user instanceof Response) return user;
 */
export async function requireUser(): Promise<string | Response> {
  const { userId } = await auth();
  return (
    userId ?? Response.json({ error: "Sign in to continue." }, { status: 401 })
  );
}

/** 404 rather than 403 for someone else's thread, so ids cannot be probed. */
export function threadNotFound() {
  return Response.json({ error: "Thread not found." }, { status: 404 });
}

/** Null when this user may use the thread (theirs, or a new id), otherwise the 404 to return. */
export function guardThread(threadId: string, userId: string): Response | null {
  return canUseThread(threadId, userId) ? null : threadNotFound();
}
