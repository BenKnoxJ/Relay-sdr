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
  external: [
    "@prisma/client",
    ".prisma/client",
    // The Agent SDK bridge spawns a subprocess from a native binary that ships
    // beside its own package.json; bundled, it cannot find itself. Left in
    // node_modules, under vendor/, where `npm ci` puts it.
    "@relay/claude-code-bridge",
  ],
});
