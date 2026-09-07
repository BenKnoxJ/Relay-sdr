import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  test: {
    // Database tests share one Postgres schema: run files in sequence.
    fileParallelism: false,
    projects: [
      {
        // Both extensions, so a component test written outside tests/ui fails
        // loudly on a missing DOM rather than being collected by no project
        // at all and silently reported as passing.
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/ui/**"],
          environment: "node",
          setupFiles: ["tests/setup.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "ui",
          include: ["tests/ui/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
    ],
  },
});
