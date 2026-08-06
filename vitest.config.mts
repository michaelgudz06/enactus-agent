import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The agent falls back to an in-memory lead when no service key is present.
    // Tests rely on that: they never reach a real Supabase project.
    env: { SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_URL: "" },
  },
});
