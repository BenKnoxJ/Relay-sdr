import { z } from "zod";

/** What the echo stub must answer with. */
export const echoOutputSchema = z
  .object({
    text: z.string().min(1).max(500),
  })
  .strict();

export type EchoOutput = z.infer<typeof echoOutputSchema>;
