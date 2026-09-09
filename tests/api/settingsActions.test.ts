import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { saveDailyCap } from "@/app/(app)/settings/actions";
import { mailboxCopy } from "@/lib/copy/settings";

/**
 * The cap field's server action, against a caller that refuses (Task 10b).
 *
 * The stub is the procedure's answer and nothing else — `tests/api/
 * connections.test.ts` checks that the answer is the right one. What matters
 * here is the shape of what comes back to `useActionState`: a line the field
 * can show, or a throw, and there is no error boundary under `(app)` to catch
 * the second.
 */

const setDailyCap = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/server/api/caller", async (importOriginal) => ({
  // The real predicates: which codes are a line and which are a fault is the
  // thing under test, so stubbing them would test nothing.
  ...(await importOriginal<typeof import("@/server/api/caller")>()),
  serverCaller: async () => ({ connections: { setDailyCap: async (input: { cap: number }) => setDailyCap(input) } }),
}));

function form(cap: string): FormData {
  const data = new FormData();
  data.set("cap", cap);
  return data;
}

describe("saveDailyCap", () => {
  it("shows the card's own line when the mailbox was disconnected in another tab", async () => {
    setDailyCap.mockRejectedValueOnce(
      new TRPCError({ code: "PRECONDITION_FAILED", message: mailboxCopy.none }),
    );

    await expect(saveDailyCap(null, form("3"))).resolves.toBe(mailboxCopy.none);
  });

  // A fault carries the driver's message, and that must never reach a rep as
  // though somebody had written it as copy.
  it("rethrows a fault rather than showing it", async () => {
    setDailyCap.mockRejectedValueOnce(
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Can't reach database server" }),
    );

    await expect(saveDailyCap(null, form("3"))).rejects.toThrow("Can't reach database server");
  });

  it("passes a good cap through and returns the saved line", async () => {
    setDailyCap.mockResolvedValueOnce({ cap: 3, saved: mailboxCopy.saved });

    await expect(saveDailyCap(null, form("3"))).resolves.toBe(mailboxCopy.saved);
    expect(setDailyCap).toHaveBeenCalledWith({ cap: 3 });
  });
});
