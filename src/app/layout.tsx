import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Desk",
  description:
    "A LangGraph multi-agent system that plans, searches, checks its own coverage and writes cited reports.",
  // Icon set in public/ (src/app/favicon.ico would override /favicon.ico, so there is none).
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/site.webmanifest",
};

/**
 * Clerk's shadcn theme reads the same CSS tokens ChaiUI defines, so sign-in and the user menu
 * follow light and dark mode; the variables below pin the ChaiUI details (warm hairlines, fonts).
 */
const clerkAppearance = {
  theme: shadcn,
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorBackground: "var(--card)",
    colorForeground: "var(--foreground)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorNeutral: "var(--foreground)",
    colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)",
    colorBorder: "var(--card-edge-hover)",
    colorRing: "var(--ring)",
    colorDanger: "var(--destructive)",
    colorModalBackdrop: "rgb(0 0 0 / 0.55)",
    fontFamily: "var(--font-manrope)",
    fontFamilyButtons: "var(--font-montserrat)",
    borderRadius: "0.625rem",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">
        <ClerkProvider appearance={clerkAppearance}>
          <ThemeProvider>{children}</ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
