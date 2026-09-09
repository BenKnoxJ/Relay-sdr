// The Claude Agent SDK bridge, as a workspace package of its own.
//
// `ai-sdk-provider-claude-code` 4.x and the Agent SDK under it peer on zod 4,
// and Relay pins zod 3.25.76 for every schema it owns. A plain install refuses
// the pair. This package exists so npm has somewhere to put a zod 4 that is not
// the root: it declares the bridge and zod 4 as its own dependencies, npm nests
// both under vendor/claude-code-bridge/node_modules because they conflict with
// the root, and every `import { z } from "zod"` in src/ and agents/ still
// resolves to 3.25.76. `npm ci` proves it on every install; no
// `--legacy-peer-deps`, no override.
//
// Nothing here is Relay code: it re-exports the bridge. The one place it is
// imported is src/lib/agents/provider.ts.
export * from "ai-sdk-provider-claude-code";
