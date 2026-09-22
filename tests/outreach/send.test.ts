import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { emailLookCopy, sendCopy } from "@/lib/copy/send";
import { prisma } from "@/lib/db";
import { SEND_DAILY_CAP } from "@/lib/outreach/send";
import { toDbDate } from "@/lib/outreach/sequence";
import { createCampaign } from "@/lib/repo/campaigns";
import { EMAIL_LOOK_SAVED, EMAIL_SENT, SEND_CLAIMED, SendRefused, readyToSend, sendEmail, sendOffersFor } from "@/lib/repo/outreachSend";
import { MockGraphMailService, emptyMockMailbox } from "@/lib/services/graphMail/mock";
import { SentButUnverifiedError, ServiceError, type ConnectedAccountRef } from "@/lib/services/types";
import { resetServices } from "@/lib/services";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * Sending from Outlook (Relay P7) on the real database against the mock
 * mailbox: Email 1 goes as a new HTML message in the rep's font with their
 * signature, Emails 2 and 3 as replies in its thread; a reply found stops the
 * send and marks the person replied; nothing sends early, paused, over the cap
 * or without a mailbox; a double press sends once; a send whose outcome is
 * unclear is settled by reading the message back, never by sending again; and
 * another rep's or org's person cannot be sent to.
 */

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  resetServices();
  (globalThis as { __relayMockMailbox?: unknown }).__relayMockMailbox = undefined;
});

function contextFor(session: Session): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return { prisma, headers: new Headers(), session, actor: () => (pending ??= ensureUser(prisma, session)) };
}
const sessionOf = (clerkId: string, email: string): Session => ({ clerkId, profile: async () => ({ email, name: "Sam Carter" }) });
const rep = () => sessionOf("user_rep", "rep@example.test");
const colleague = () => sessionOf("user_colleague", "colleague@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");
const caller = (session: Session) => appRouter.createCaller(contextFor(session));
const actorOf = (session: Session) => ensureUser(prisma, session);

/** Monday 5 October 2026: Email 1 is due that day, Email 2 on Monday 12th, Email 3 on Wednesday 21st. */
const START = "2026-10-05";
const at = (day: string) => () => new Date(`${day}T10:00:00Z`);
const EMAIL1_DAY = at("2026-10-05");
const EMAIL2_DAY = at("2026-10-12");
const EMAIL3_DAY = at("2026-10-21");

let serial = 0;

/** A started campaign with `n` kept, revealed people, each with all three emails approved. */
async function campaignWith(actor: Actor, n: number, options: { startOn?: string; email?: (i: number) => string } = {}): Promise<{ campaignId: string; people: string[] }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  const people: string[] = [];
  for (let i = 0; i < n; i += 1) {
    serial += 1;
    // One draft job per person, as the drafter runs one per person.
    const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
    const person = await prisma.person.create({ data: { orgId: actor.orgId, email: options.email?.(i) ?? `p${serial}@firm${serial}.co.uk`, emailType: "work", name: `Avery Person${serial}` } });
    const row = await prisma.campaignPerson.create({
      data: {
        orgId: actor.orgId, campaignId: campaign.id, briefVersion: 1, jobId: job.id, provider: "lusha", providerId: `lusha-${serial}`, personId: person.id, status: "chosen", source: "bought", rank: serial, score: 80, whyPicked: "fits", companyKey: `firm${serial}`,
        preview: { name: `Avery Person${serial}`, company: `Firm ${serial}` }, review: "kept", reviewedAt: new Date(), reviewedByUserId: actor.userId, reveal: "revealed", revealedAt: new Date(), outreachStartOn: toDbDate(options.startOn ?? START),
      },
    });
    for (const [touch, subject, body] of [["email1", "Calls behind complaints", "Complaints <arrive> late & cost.\n\nWorth a look?"], ["email2", null, "A short follow-up."], ["breakup", "Closing the loop", "I'll leave it here."]] as const) {
      await prisma.outreachDraft.create({
        data: { orgId: actor.orgId, campaignId: campaign.id, briefVersion: 1, campaignPersonId: row.id, ownerUserId: actor.userId, jobId: job.id, touch, attempt: 1, state: "approved", decidedAt: new Date(), decidedByUserId: actor.userId, body, ask: "Worth a look?", opener: { ref: "x", kind: "role_pain" }, subject, findings: [], advice: [], lookup: {}, generations: 1 },
      });
    }
    people.push(row.id);
  }
  return { campaignId: campaign.id, people };
}

/** The rep's mailbox, connected with sending allowed. The mock reads no token. */
async function connect(actor: Actor, overrides: { status?: "healthy" | "expiring" | "revoked" | "paused"; scopes?: string[] } = {}): Promise<void> {
  await prisma.connectedAccount.create({ data: { orgId: actor.orgId, userId: actor.userId, provider: "graph", encTokens: "test:no-token", scopes: overrides.scopes ?? ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"], status: overrides.status ?? "healthy" } });
}

const send = (mail: MockGraphMailService, actor: Actor, personId: string, step: string, now: () => Date) =>
  sendEmail(prisma, mail, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: personId, step, now });

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof SendRefused) return error.refusal;
    throw error;
  }
}

const sends = (mail: MockGraphMailService) => mail.calls.filter((call) => call.method === "send");
const sentEvents = (personId: string) => prisma.outreachEvent.findMany({ where: { campaignPersonId: personId, kind: "sent" }, orderBy: { seq: "asc" } });

async function repWithPerson(options: Parameters<typeof campaignWith>[2] = {}) {
  const actor = await actorOf(rep());
  await connect(actor);
  const { campaignId, people } = await campaignWith(actor, 1, options);
  return { actor, campaignId, personId: people[0]! };
}

describe("Email 1", () => {
  it("goes as a new HTML message in the rep's font with their signature, and is marked sent with its ids", async () => {
    const { actor, campaignId, personId } = await repWithPerson();
    await caller(rep()).send.saveLook({ font: "Calibri", fontSize: 12, signature: "<p><b>Sam Carter</b><br>Sales</p><script>alert(1)</script>" });
    const mail = new MockGraphMailService();

    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });

    const created = mail.calls.find((call) => call.method === "createDraft");
    expect(created).toMatchObject({ method: "createDraft", msg: { to: expect.stringMatching(/@firm\d+\.co\.uk$/), subject: "Calls behind complaints" } });
    const html = created?.method === "createDraft" ? created.msg.html : "";
    expect(html).toContain("font-family:Calibri, Arial, sans-serif;font-size:12pt");
    // The card's envelope, in order: greeting, the body escaped, the sign-off, then the signature.
    expect(html.indexOf("Hi Avery,")).toBeLessThan(html.indexOf("Complaints &lt;arrive&gt; late &amp; cost."));
    expect(html.indexOf("Worth a look?")).toBeLessThan(html.indexOf(">Sam</p>"));
    expect(html.indexOf(">Sam</p>")).toBeLessThan(html.indexOf("<b>Sam Carter</b>"));
    expect(html).not.toContain("script");
    expect(mail.calls.some((call) => call.method === "conversationHasReply" || call.method === "createReply")).toBe(false);

    const row = await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId, step: "email1" } });
    expect(row).toMatchObject({ orgId: actor.orgId, campaignId, byUserId: actor.userId, state: "sent", messageId: "AAMk-mock-1", conversationId: "AAQk-mock-conv-1", graphDraftId: "AAMk-mock-1" });
    expect(await sentEvents(personId)).toEqual([expect.objectContaining({ step: "email1", byUserId: actor.userId, happenedOn: toDbDate("2026-10-05") })]);
    const events = await prisma.event.findMany({ where: { orgId: actor.orgId, kind: EMAIL_SENT } });
    expect(events).toEqual([expect.objectContaining({ campaignId, after: expect.objectContaining({ messageId: "AAMk-mock-1", conversationId: "AAQk-mock-conv-1" }) })]);
  });

  it("goes in Aptos 11 with no signature when the rep has set nothing", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    await send(mail, actor, personId, "email1", EMAIL1_DAY);
    const created = mail.calls.find((call) => call.method === "createDraft");
    const html = created?.method === "createDraft" ? created.msg.html : "";
    expect(html).toMatch(/^<div style="font-family:Aptos, Calibri, Arial, sans-serif;font-size:11pt">.*<\/div>$/);
    expect(html).not.toContain("<div><p");
  });
});

describe("Emails 2 and 3", () => {
  it("go as replies in Email 1's conversation, after checking it for a reply", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    await send(mail, actor, personId, "email1", EMAIL1_DAY);

    expect(await send(mail, actor, personId, "email2", EMAIL2_DAY)).toEqual({ outcome: "sent" });
    expect(mail.calls.filter((call) => call.method === "conversationHasReply")).toEqual([expect.objectContaining({ conversationId: "AAQk-mock-conv-1", sinceMessageId: "AAMk-mock-1" })]);
    expect(mail.calls.filter((call) => call.method === "createReply")).toEqual([expect.objectContaining({ messageId: "AAMk-mock-1", reply: expect.objectContaining({ to: expect.stringMatching(/@firm/) }) })]);
    expect(mail.calls.filter((call) => call.method === "createDraft")).toHaveLength(1);
    const email2 = await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId, step: "email2" } });
    expect(email2).toMatchObject({ state: "sent", conversationId: "AAQk-mock-conv-1" });

    expect(await send(mail, actor, personId, "breakup", EMAIL3_DAY)).toEqual({ outcome: "sent" });
    const email3 = await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId, step: "breakup" } });
    expect(email3).toMatchObject({ state: "sent", conversationId: "AAQk-mock-conv-1" });
    expect((await sentEvents(personId)).map((event) => event.step)).toEqual(["email1", "email2", "breakup"]);
  });

  it("are not sent when the prospect replied: the person is marked replied and the rep told why", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    await send(mail, actor, personId, "email1", EMAIL1_DAY);
    mail.injectReply("AAQk-mock-conv-1");

    expect(await send(mail, actor, personId, "email2", EMAIL2_DAY)).toEqual({ outcome: "replied" });
    expect(mail.calls.some((call) => call.method === "createReply")).toBe(false);
    expect(sends(mail)).toHaveLength(1);
    expect(await prisma.outreachSend.count({ where: { campaignPersonId: personId, step: "email2" } })).toBe(0);
    const replied = await prisma.outreachEvent.findMany({ where: { campaignPersonId: personId, kind: "replied" } });
    expect(replied).toEqual([expect.objectContaining({ step: "email1", byUserId: actor.userId })]);
    // The sequence has stopped: nothing is offered, and a second press is refused.
    const offers = await sendOffersFor(prisma, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: personId, now: EMAIL2_DAY() });
    expect(offers.email2).toEqual({ kind: "none" });
    expect(await refusalOf(send(mail, actor, personId, "email2", EMAIL2_DAY))).toBe("none");
    expect(sendCopy.replied).toBe("They replied, so this wasn't sent.");
  });

  it("are refused when Email 1 went by hand: there is no thread to reply in", async () => {
    const { actor, personId } = await repWithPerson();
    await prisma.outreachEvent.create({ data: { orgId: actor.orgId, campaignId: (await prisma.campaignPerson.findUniqueOrThrow({ where: { id: personId } })).campaignId, campaignPersonId: personId, step: "email1", kind: "sent", happenedOn: toDbDate(START), byUserId: actor.userId } });
    const mail = new MockGraphMailService();
    expect(await refusalOf(send(mail, actor, personId, "email2", EMAIL2_DAY))).toBe("by_hand");
    expect(mail.calls).toEqual([]);
  });
});

describe("nothing sends early, paused, or without a mailbox", () => {
  it("refuses before the due day, and the offer says from when", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    await send(mail, actor, personId, "email1", EMAIL1_DAY);
    const friday = at("2026-10-09");
    expect(await refusalOf(send(mail, actor, personId, "email2", friday))).toBe("not_due");
    expect((await sendOffersFor(prisma, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: personId, now: friday() })).email2).toEqual({ kind: "not_due", from: "2026-10-12" });
    expect(mail.calls.filter((call) => call.method !== "createDraft" && call.method !== "send")).toEqual([]);
    expect(await refusalOf(send(new MockGraphMailService(), actor, personId, "email1", at("2026-10-02")))).toBe("none");
  });

  it("refuses on a paused campaign", async () => {
    const { actor, campaignId, personId } = await repWithPerson();
    await prisma.campaign.update({ where: { id: campaignId }, data: { outreachPausedAt: new Date() } });
    const mail = new MockGraphMailService();
    expect(await refusalOf(send(mail, actor, personId, "email1", EMAIL1_DAY))).toBe("paused");
    expect(mail.calls).toEqual([]);
    expect(await prisma.outreachSend.count()).toBe(0);
  });

  it("refuses with no mailbox, a revoked or expiring one, or one not allowed to send", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const mail = new MockGraphMailService();
    expect(await refusalOf(send(mail, actor, people[0]!, "email1", EMAIL1_DAY))).toBe("no_mailbox");
    for (const overrides of [{ status: "revoked" as const }, { status: "expiring" as const }, { scopes: ["offline_access", "User.Read", "Mail.ReadWrite"] }]) {
      await prisma.connectedAccount.deleteMany({ where: { userId: actor.userId } });
      await connect(actor, overrides);
      expect(await refusalOf(send(mail, actor, people[0]!, "email1", EMAIL1_DAY))).toBe("no_mailbox");
    }
    expect(mail.calls).toEqual([]);
  });

  it("refuses an email that is not approved, and a step that is not an email", async () => {
    const { actor, personId } = await repWithPerson();
    await prisma.outreachDraft.updateMany({ where: { campaignPersonId: personId, touch: "email1" }, data: { state: "to_review", decidedAt: null, decidedByUserId: null } });
    const mail = new MockGraphMailService();
    expect(await refusalOf(send(mail, actor, personId, "email1", EMAIL1_DAY))).toBe("none");
    expect(await refusalOf(send(mail, actor, personId, "li_connect", EMAIL1_DAY))).toBe("none");
    expect(await refusalOf(send(mail, actor, personId, "nope", EMAIL1_DAY))).toBe("none");
    expect(mail.calls).toEqual([]);
  });
});

describe("once and only once", () => {
  it("sends once for a double press, however the presses land", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    const results = await Promise.all([1, 2, 3].map(() => send(mail, actor, personId, "email1", EMAIL1_DAY).catch((error: unknown) => (error instanceof SendRefused ? { refused: error.refusal } : Promise.reject(error)))));
    expect(results.filter((result) => "outcome" in result && result.outcome === "sending").length + results.filter((result) => "refused" in result).length).toBe(2);
    expect(results.filter((result) => "outcome" in result && result.outcome === "sent")).toHaveLength(1);
    expect(sends(mail)).toHaveLength(1);
    expect(await sentEvents(personId)).toHaveLength(1);
    // And again, afterwards: the step is done.
    expect(await refusalOf(send(mail, actor, personId, "email1", EMAIL1_DAY))).toBe("none");
    expect(sends(mail)).toHaveLength(1);
  });

  it("reports a press already under way instead of sending again", async () => {
    const { actor, campaignId, personId } = await repWithPerson();
    await prisma.outreachSend.create({ data: { orgId: actor.orgId, campaignId, campaignPersonId: personId, step: "email1", byUserId: actor.userId, state: "sending" } });
    const mail = new MockGraphMailService();
    expect(await send(mail, actor, personId, "email1", () => new Date())).toEqual({ outcome: "sending" });
    expect(mail.calls).toEqual([]);
  });
});

/** A mailbox whose send reaches Microsoft (or not) and then cannot say so. */
class UnclearSend extends MockGraphMailService {
  constructor(
    private readonly delivered: boolean,
    box = emptyMockMailbox(),
  ) {
    super(box);
  }
  async send(account: ConnectedAccountRef, draftId: string): Promise<never> {
    if (this.delivered) await super.send(account, draftId);
    else this.calls.push({ method: "send", accountId: account.id, draftId });
    throw new SentButUnverifiedError({ draftId, status: 504 });
  }
}

describe("a send whose outcome is unclear", () => {
  it("is settled by reading the message back: it went, so it is marked sent, and nothing is sent twice", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new UnclearSend(true);
    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });
    expect(mail.calls.map((call) => call.method)).toEqual(["createDraft", "send", "getMessage"]);
    expect(await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId } })).toMatchObject({ state: "sent", messageId: "AAMk-mock-1" });
    expect(await sentEvents(personId)).toHaveLength(1);
  });

  it("stays unverified while the read-back still finds a draft, and only a check once the row is stale calls it not sent", async () => {
    const { actor, personId } = await repWithPerson();
    const box = emptyMockMailbox();
    const unclear = new UnclearSend(false, box);
    expect(await send(unclear, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "unverified" });
    expect(await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId } })).toMatchObject({ state: "unverified", graphDraftId: "AAMk-mock-1" });

    // Checked straight away: still a draft, still unverified, and nothing sent.
    const check = new MockGraphMailService(box);
    expect(await send(check, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "unverified" });
    expect(check.calls.map((call) => call.method)).toEqual(["getMessage"]);

    // Checked once the row is stale: it did not go, so it is a failed send, offered again.
    await prisma.$executeRaw`UPDATE outreach_sends SET updated_at = now() - interval '10 minutes'`;
    expect(await send(check, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "failed", reason: "provider" });
    expect(await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId } })).toMatchObject({ state: "failed" });

    const retry = new MockGraphMailService(box);
    expect(await send(retry, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });
    // The same draft, read back first, then sent: no second draft.
    expect(retry.calls.map((call) => call.method)).toEqual(["getMessage", "send"]);
    expect(await sentEvents(personId)).toHaveLength(1);
  });

  it("stays unverified when the message cannot be found, and a later press only checks, never sends", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new UnclearSend(true);
    mail.getMessage = async (account, id) => {
      mail.calls.push({ method: "getMessage", accountId: account.id, id });
      return { notFound: true };
    };
    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "unverified" });
    const offers = await sendOffersFor(prisma, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: personId, now: EMAIL1_DAY() });
    expect(offers.email1).toEqual({ kind: "unverified" });

    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "unverified" });
    expect(sends(mail)).toHaveLength(1);
    expect(await sentEvents(personId)).toHaveLength(0);
  });

  it("finishes a press that died half-way once it is stale, from the mailbox's own answer", async () => {
    const { actor, campaignId, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    const account = { id: "a", orgId: actor.orgId, userId: actor.userId, provider: "graph" as const, encTokens: "x" };
    const { id } = await mail.createDraft(account, { to: "x@firm.co.uk", subject: "s", html: "h" });
    await mail.send(account, id);
    await prisma.outreachSend.create({ data: { orgId: actor.orgId, campaignId, campaignPersonId: personId, step: "email1", byUserId: actor.userId, state: "sending", graphDraftId: id } });
    await prisma.$executeRaw`UPDATE outreach_sends SET updated_at = now() - interval '10 minutes'`;
    mail.calls.length = 0;

    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });
    expect(mail.calls.map((call) => call.method)).toEqual(["getMessage"]);
    expect(await sentEvents(personId)).toHaveLength(1);
  });

  it("a mailbox refusal fails the send, keeps nothing half-done, and says the mailbox needs connecting", async () => {
    const { actor, personId } = await repWithPerson();
    const mail = new MockGraphMailService();
    mail.createDraft = async () => {
      throw new ServiceError({ service: "graph", status: 401 });
    };
    expect(await send(mail, actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "failed", reason: "mailbox" });
    expect(await prisma.outreachSend.findFirstOrThrow({ where: { campaignPersonId: personId } })).toMatchObject({ state: "failed", graphDraftId: null });
    // A failed send is known not to have gone: the next press sends it.
    expect(await send(new MockGraphMailService(), actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });
  });
});

describe("the daily cap", () => {
  async function sentOnDay(actor: Actor, count: number, day: string) {
    const { campaignId, people } = await campaignWith(actor, 1);
    for (let i = 0; i < count; i += 1) {
      await prisma.outreachEvent.create({ data: { orgId: actor.orgId, campaignId, campaignPersonId: people[0]!, step: "email2", kind: "sent", happenedOn: toDbDate(day), byUserId: actor.userId } });
    }
  }

  it(`stops at ${SEND_DAILY_CAP} a day per mailbox, counted from today's sent emails`, async () => {
    const { actor, personId } = await repWithPerson();
    await sentOnDay(actor, SEND_DAILY_CAP, "2026-10-05");
    const mail = new MockGraphMailService();
    expect(await refusalOf(send(mail, actor, personId, "email1", EMAIL1_DAY))).toBe("cap");
    expect((await sendOffersFor(prisma, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: personId, now: EMAIL1_DAY() })).email1).toEqual({ kind: "cap", cap: 30 });
    expect(mail.calls).toEqual([]);
    // Yesterday's do not count.
    expect(await send(mail, actor, personId, "email1", at("2026-10-06"))).toEqual({ outcome: "sent" });
  });

  it("does not count a send left unsettled on an earlier day", async () => {
    const { actor, personId } = await repWithPerson();
    const { campaignId, people } = await campaignWith(actor, 1);
    await sentOnDay(actor, SEND_DAILY_CAP - 1, "2026-10-05");
    await prisma.outreachSend.create({ data: { orgId: actor.orgId, campaignId, campaignPersonId: people[0]!, step: "email1", byUserId: actor.userId, state: "unverified", claimedAt: new Date("2026-10-02T10:00:00Z") } });
    expect(await send(new MockGraphMailService(), actor, personId, "email1", EMAIL1_DAY)).toEqual({ outcome: "sent" });
  });

  it(`lets the ${SEND_DAILY_CAP}th go and not the one after, even when they are pressed together`, async () => {
    const actor = await actorOf(rep());
    await connect(actor);
    await sentOnDay(actor, SEND_DAILY_CAP - 1, "2026-10-05");
    const { people } = await campaignWith(actor, 3);
    const mail = new MockGraphMailService();
    const results = await Promise.all(people.map((personId) => send(mail, actor, personId, "email1", EMAIL1_DAY).catch((error: unknown) => (error instanceof SendRefused ? error.refusal : Promise.reject(error)))));
    expect(results.filter((result) => typeof result === "object" && result.outcome === "sent")).toHaveLength(1);
    expect(results.filter((result) => result === "cap")).toHaveLength(2);
    expect(sends(mail)).toHaveLength(1);
  });
});

describe("scoping", () => {
  it("another rep in the org, or another org, cannot send to the rep's person or read its offers", async () => {
    const { personId } = await repWithPerson();
    for (const session of [colleague(), stranger()]) {
      const other = await actorOf(session);
      await connect(other);
      const mail = new MockGraphMailService();
      expect(await refusalOf(send(mail, other, personId, "email1", EMAIL1_DAY))).toBe("not_found");
      expect(mail.calls).toEqual([]);
      const refused = await caller(session).send.email({ personId, step: "email1" }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TRPCError);
      expect((refused as TRPCError).code).toBe("NOT_FOUND");
      expect(await sendOffersFor(prisma, { orgId: other.orgId, userId: other.userId, campaignPersonId: personId, now: EMAIL1_DAY() })).toEqual({});
      expect((await readyToSend(prisma, { orgId: other.orgId, userId: other.userId, now: EMAIL1_DAY() })).items).toEqual([]);
    }
    expect(await prisma.outreachSend.count()).toBe(0);
  });
});

describe("through the router", () => {
  it("sends through the process's mock mailbox, writes the claim's Event, and refuses with a plain reason", async () => {
    const { actor, personId } = await repWithPerson({ startOn: "2026-01-05" });
    expect(await caller(rep()).send.email({ personId, step: "email1" })).toEqual({ outcome: "sent" });
    expect(await prisma.event.count({ where: { orgId: actor.orgId, kind: SEND_CLAIMED } })).toBe(1);
    const again = await caller(rep()).send.email({ personId, step: "email1" }).catch((error: unknown) => error);
    expect(again).toMatchObject({ code: "BAD_REQUEST", message: sendCopy.refused.none });
    // Email 2 finds Email 1 in the same process-wide mock mailbox.
    expect(await caller(rep()).send.email({ personId, step: "email2" })).toEqual({ outcome: "sent" });
    const view = await caller(rep()).tracking.personTracking({ personId });
    expect(view.tracking.steps.filter((step) => step.state === "done").map((step) => step.id)).toEqual(["email1", "email2"]);
    expect(view.sendOffers.breakup).toEqual({ kind: expect.stringMatching(/^(send|not_due)$/) });
  });

  it("lists approved emails that are not sent yet, due first, on running campaigns only", async () => {
    const { actor, personId } = await repWithPerson();
    const ready = await readyToSend(prisma, { orgId: actor.orgId, userId: actor.userId, now: EMAIL1_DAY() });
    expect(ready.items.map((item) => [item.step, item.due, item.offer.kind])).toEqual([
      ["email1", "2026-10-05", "send"],
      ["email2", "2026-10-12", "not_due"],
      ["breakup", "2026-10-21", "not_due"],
    ]);
    expect(ready).toMatchObject({ sentToday: 0, mailbox: true });
    expect(ready.items[0]).toMatchObject({ campaignPersonId: personId, name: expect.stringMatching(/^Avery /), subject: "Calls behind complaints" });
  });
});

describe("the email look", () => {
  it("stores the signature sanitised, records that it changed and not what it says, and refuses a font not on the list", async () => {
    const actor = await actorOf(rep());
    const saved = await caller(rep()).send.saveLook({ font: "Georgia", fontSize: 10, signature: `<p style="color:#123456;position:fixed">Sam <a href="javascript:alert(1)" onclick="x()">me</a><img src="https://example.test/logo.png" onerror="x()"></p><style>*{}</style>` });
    expect(saved.look).toEqual({ font: "Georgia", fontSize: 10, signature: '<p style="color:#123456">Sam <a target="_blank" rel="noopener noreferrer">me</a><img src="https://example.test/logo.png" /></p>' });
    expect(saved.preview).toContain("Georgia");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    expect(user.emailSignature).toBe(saved.look.signature);
    const events = await prisma.event.findMany({ where: { orgId: actor.orgId, kind: EMAIL_LOOK_SAVED } });
    expect(events).toEqual([expect.objectContaining({ after: { font: "Georgia", fontSize: 10, signatureLength: saved.look.signature.length } })]);

    const bad = await caller(rep()).send.saveLook({ font: "Comic Sans" as "Aptos", fontSize: 10, signature: "" }).catch((error: unknown) => error);
    expect(bad).toMatchObject({ code: "BAD_REQUEST" });
    const tooBig = await caller(rep()).send.saveLook({ font: "Aptos", fontSize: 40, signature: "" }).catch((error: unknown) => error);
    expect(tooBig).toMatchObject({ code: "BAD_REQUEST" });
    expect(emailLookCopy.refused.bad_font).toBeTruthy();
  });

  it("defaults to Aptos 11 with no signature, and previews a look before it is saved", async () => {
    await actorOf(rep());
    expect((await caller(rep()).send.look()).look).toEqual({ font: "Aptos", fontSize: 11, signature: "" });
    const { preview } = await caller(rep()).send.preview({ font: "Arial", fontSize: 14, signature: "<p>Sam</p><script>x()</script>" });
    expect(preview).toContain("font-size:14pt");
    expect(preview).toContain("<p>Sam</p>");
    expect(preview).not.toContain("script");
  });
});
