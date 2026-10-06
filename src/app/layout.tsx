import type { Metadata } from "next";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Desk",
  description: "A LangGraph multi-agent system that plans, searches, checks its own coverage and writes cited reports.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
