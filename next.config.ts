import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone, used by the Docker image (see Dockerfile).
  output: "standalone",
  // Native / Node-only packages are loaded with require() instead of being bundled.
  serverExternalPackages: ["better-sqlite3", "@langchain/langgraph-checkpoint-sqlite", "unpdf", "mammoth"],
};

export default nextConfig;
