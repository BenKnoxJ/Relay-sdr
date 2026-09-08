/**
 * `services()` — which adapter set a process gets, and the promise the hooks make.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnv } from "@/lib/env";
import { MockGraphMailService } from "@/lib/services/graphMail/mock";
import { LiveGraphMailService } from "@/lib/services/graphMail/live";
import { MockZohoService } from "@/lib/services/zoho/mock";
import { LiveZohoService } from "@/lib/services/zoho/live";
import {
  defaultServicesDeps,
  guardHooks,
  resetServices,
  services,
  type ServicesDeps,
} from "@/lib/services";

import { TEST_ENC_KEY, account, json, stubFetch, testEnv } from "./helpers";

const saved = { ...process.env };

beforeEach(() => {
  resetServices();
  resetEnv();
});

afterEach(() => {
  // Restore key by key rather than reassigning `process.env`: replacing the
  // object leaves anything that captured the old one writing into a dead copy.
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  resetServices();
  resetEnv();
});

describe("services()", () => {
  it("hands out the mocks under INTEGRATIONS=mock", () => {
    process.env.INTEGRATIONS = "mock";
    const set = services();
    expect(set.graphMail).toBeInstanceOf(MockGraphMailService);
    expect(set.zoho).toBeInstanceOf(MockZohoService);
  });

  it("hands out the live clients under INTEGRATIONS=live", () => {
    process.env.INTEGRATIONS = "live";
    process.env.TOKEN_ENC_KEY = TEST_ENC_KEY;
    const set = services();
    expect(set.graphMail).toBeInstanceOf(LiveGraphMailService);
    expect(set.zoho).toBeInstanceOf(LiveZohoService);
  });

  it("memoises on the deps object's identity", () => {
    process.env.INTEGRATIONS = "mock";
    const deps: ServicesDeps = {};
    expect(services(deps)).toBe(services(deps));
    expect(services()).toBe(services(defaultServicesDeps));
    // A different object rebuilds the set — which is why the deps belong in a
    // module constant and not in a literal at the call site.
    expect(services({})).not.toBe(services({}));
  });

  it("resetServices makes the next call re-read the environment", () => {
    process.env.INTEGRATIONS = "mock";
    const mock = services().graphMail;
    process.env.INTEGRATIONS = "live";
    process.env.TOKEN_ENC_KEY = TEST_ENC_KEY;
    expect(services().graphMail).toBe(mock);
    resetServices();
    resetEnv();
    expect(services().graphMail).toBeInstanceOf(LiveGraphMailService);
  });
});

describe("the token hooks cannot break a request that worked", () => {
  /**
   * The contract in `ServicesDeps` says a hook must not throw. Task 10b's hooks
   * will write to `ConnectedAccount`, and a database that is briefly unavailable
   * must not turn a delivered mail into an error the caller retries — that is
   * how one send becomes two.
   *
   * Driven through a real refresh rather than by calling the wrapper directly,
   * so what is proved is the thing that matters: `createDraft` resolves.
   */
  async function refreshWith(deps: ServicesDeps) {
    const fetchStub = stubFetch([
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);
    const graph = new LiveGraphMailService(testEnv(), {
      fetchImpl: fetchStub.impl,
      now: () => new Date("2026-09-02T09:00:00.000Z"),
      ...guardHooks(deps),
    });
    return graph.createDraft(account("2026-09-02T08:00:00.000Z"), {
      to: "a@example.com",
      subject: "s",
      body: "b",
    });
  }

  it("swallows a hook that throws synchronously", async () => {
    const onTokenRefresh = vi.fn(() => {
      throw new Error("database is down");
    });
    await expect(refreshWith({ onTokenRefresh })).resolves.toEqual({ id: "AAMk-live-1" });
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
  });

  it("swallows a hook that rejects", async () => {
    const onTokenRefresh = vi.fn(async () => {
      throw new Error("database is down");
    });
    await expect(refreshWith({ onTokenRefresh })).resolves.toEqual({ id: "AAMk-live-1" });
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
  });

  it("swallows a refusal hook that throws, and still raises the refusal", async () => {
    const onRefreshFailed = vi.fn(() => {
      throw new Error("database is down");
    });
    const fetchStub = stubFetch([() => json({ error: "invalid_grant" }, 400)]);
    const graph = new LiveGraphMailService(testEnv(), {
      fetchImpl: fetchStub.impl,
      now: () => new Date("2026-09-02T09:00:00.000Z"),
      ...guardHooks({ onRefreshFailed }),
    });
    // The hook's failure is swallowed; the ServiceError it was told about is not.
    await expect(
      graph.createDraft(account("2026-09-02T08:00:00.000Z"), { to: "a@example.com", subject: "s", body: "b" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
  });

  it("leaves a hook that works alone, and passes it the account and the new tokens", async () => {
    const onTokenRefresh = vi.fn();
    await expect(refreshWith({ onTokenRefresh })).resolves.toEqual({ id: "AAMk-live-1" });
    expect(onTokenRefresh.mock.calls[0]?.[0]).toMatchObject({ id: "acc_1", orgId: "org_1" });
    expect(onTokenRefresh.mock.calls[0]?.[1]).toMatchObject({ accessToken: "access-2" });
  });

  it("hands back no hook at all when the caller supplied none", () => {
    expect(guardHooks({})).toEqual({ onTokenRefresh: undefined, onRefreshFailed: undefined });
  });
});
