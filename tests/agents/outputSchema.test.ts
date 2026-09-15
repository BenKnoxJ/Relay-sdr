import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { outreachOutputSchema } from "../../agents/outreach/output.schema";
import { researchOutputSchema } from "../../agents/research/output.schema";
import { objectShapedOutput } from "@/lib/agents/run";

/**
 * The structured-output tool a provider receives must be an object at the
 * top level (the Messages API refuses `input_schema` without `type: object`).
 * Outreach's draft is a discriminated union, so its JSON schema is `anyOf`
 * with no type; the run shapes it to an object without changing what the
 * model answers, and validation stays the signed zod schema's.
 */
describe("objectShapedOutput", () => {
  it("folds a union output into one object: every property, only the shared keys required, the discriminator as its values", async () => {
    const json = await Promise.resolve(objectShapedOutput(outreachOutputSchema).jsonSchema);
    expect(json.type).toBe("object");
    expect(json.anyOf).toBeUndefined();
    const properties = json.properties as Record<string, { enum?: string[] }>;
    expect(properties.kind?.enum).toEqual(["message", "call"]);
    for (const key of ["subject", "body", "ask", "talkingPoint", "opener", "claims"]) expect(properties[key]).toBeDefined();
    // Shared by both members: the discriminator, the opener and the claims; a message's body and ask are not required of a call.
    expect([...(json.required as string[])].sort()).toEqual(["claims", "kind", "opener"]);
  });

  it("still validates with the definition's own schema: the signed good fixture passes, a bad one fails", async () => {
    const shaped = objectShapedOutput(outreachOutputSchema);
    const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "agents", "outreach", "fixtures", name), "utf8")) as unknown;
    expect((await shaped.validate!(fixture("output.good.json"))).success).toBe(true);
    expect((await shaped.validate!(fixture("output.bad.json"))).success).toBe(false);
    expect((await shaped.validate!({ kind: "message" })).success).toBe(false);
  });

  it("leaves an object output untouched", async () => {
    const json = await Promise.resolve(objectShapedOutput(researchOutputSchema).jsonSchema);
    expect(json.type).toBe("object");
    expect(json.anyOf).toBeUndefined();
  });
});
