import { z } from "zod";

/** What the echo stub is given. One string, because one string is enough to prove a loop. */
export const echoInputSchema = z
  .object({
    text: z.string().min(1).max(500),
  })
  .strict();

export type EchoInput = z.infer<typeof echoInputSchema>;
