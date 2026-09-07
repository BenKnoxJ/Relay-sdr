import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "worker/main": "src/worker/main.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Prisma's client is generated into node_modules and loads a native engine;
  // bundling it breaks that lookup.
  external: ["@prisma/client", ".prisma/client"],
});
