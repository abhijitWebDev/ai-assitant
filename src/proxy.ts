import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Attaches the Clerk session to every request so `auth()` works in route handlers.
 * It does not block anything: the landing page stays public, and each API route
 * checks the user and thread ownership itself (src/lib/auth.ts).
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
    // Clerk's auto-proxy path.
    "/__clerk/:path*",
  ],
};
