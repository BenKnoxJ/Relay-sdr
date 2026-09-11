/**
 * `ResearchPack` — `research.v3.signed.md` §3.
 *
 * The contract lives in `output/`: one schema per module in `modules.ts`, and
 * the assembled pack with its pack-level rules in `pack.ts`. This file is the
 * loader's and the consumers' single import.
 */
export * from "./output/modules";
export * from "./output/pack";
export * from "./output/derived";
export * from "./output/scope";
export { urlSchema } from "../_shared/item.schema";
