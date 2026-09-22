import graphFixture from "../../../../fixtures/integrations/graph-message.json";
import { ServiceError, type ConnectedAccountRef, type GraphMailService, type MailMeta, type MailState, type NewMail } from "../types";

export type GraphMockCall =
  | { method: "createDraft"; accountId: string; msg: NewMail }
  | { method: "createReply"; accountId: string; messageId: string; reply: { to: string; html: string } }
  | { method: "send"; accountId: string; draftId: string }
  | { method: "getMessage"; accountId: string; id: string }
  | { method: "deleteDraft"; accountId: string; id: string }
  | { method: "listSince"; accountId: string; since: Date; select: string[] }
  | { method: "conversationHasReply"; accountId: string; conversationId: string; sinceMessageId: string };

const ID_PREFIX = "AAMk-mock-";

/**
 * A recipient address the mock answers for, in development only: mail sent
 * to `someone+replied@…` has a reply waiting in its conversation, so the
 * "they replied" path can be walked on a local server without a real mailbox.
 * Tests use `injectReply` instead.
 */
export const MOCK_REPLIER = /\+replied@/i;

type MockMessage = { to: string; conversationId: string; isDraft: boolean };

/** The mock mailbox's contents. Held apart from the client so one process can share it. */
export type MockMailbox = {
  n: number;
  messages: Map<string, MockMessage>;
  /** Conversations somebody other than the owner has written in. */
  replied: Set<string>;
  /** What `listSince` returns; null means the committed inbox fixture. */
  inbox: MailMeta[] | null;
};

export function emptyMockMailbox(): MockMailbox {
  return { n: 0, messages: new Map(), replied: new Set(), inbox: null };
}

/**
 * Deterministic contract mock: ids are numbered from 1 per mailbox. It keeps
 * the live client's state machine: a draft is sent once, a reply is drafted
 * only on a message this mailbox has, into that message's conversation, and
 * a draft that is gone is a 404.
 */
export class MockGraphMailService implements GraphMailService {
  readonly calls: GraphMockCall[] = [];

  constructor(private readonly box: MockMailbox = emptyMockMailbox()) {}

  reset(): void {
    this.calls.length = 0;
    this.box.n = 0;
    this.box.messages.clear();
    this.box.replied.clear();
    this.box.inbox = null;
  }

  /** Hand the mailbox a specific set of messages for the next `listSince`. */
  setInbox(messages: MailMeta[]): void {
    this.box.inbox = messages;
  }

  /** Put a reply from the prospect into a conversation, for the reply check to find. */
  injectReply(conversationId: string): void {
    this.box.replied.add(conversationId);
  }

  private mint(message: Omit<MockMessage, "conversationId"> & { conversationId?: string }): string {
    this.box.n += 1;
    const n = this.box.n;
    const id = `${ID_PREFIX}${n}`;
    this.box.messages.set(id, { ...message, conversationId: message.conversationId ?? `AAQk-mock-conv-${n}` });
    return id;
  }

  async createDraft(account: ConnectedAccountRef, msg: NewMail) {
    this.calls.push({ method: "createDraft", accountId: account.id, msg });
    return { id: this.mint({ to: msg.to, isDraft: true }) };
  }

  async createReply(account: ConnectedAccountRef, messageId: string, reply: { to: string; html: string }) {
    this.calls.push({ method: "createReply", accountId: account.id, messageId, reply });
    const original = this.box.messages.get(messageId);
    // Graph answers 404 for a message this mailbox does not have.
    if (original === undefined) throw new ServiceError({ service: "graph", status: 404, code: "ErrorItemNotFound" });
    return { id: this.mint({ to: reply.to, isDraft: true, conversationId: original.conversationId }) };
  }

  async send(account: ConnectedAccountRef, draftId: string) {
    this.calls.push({ method: "send", accountId: account.id, draftId });
    // A draft this mailbox never had, or one already thrown away or sent, is a
    // 404 from Graph — and `LiveGraphMailService.send` classifies that as a
    // hard failure, NOT as sent-but-unverified. A mock that answered happily
    // would let Relay develop against a state machine the live client refuses.
    const message = this.box.messages.get(draftId);
    if (message === undefined || !message.isDraft) {
      throw new ServiceError({ service: "graph", status: 404, code: "ErrorItemNotFound" });
    }
    message.isDraft = false;
    if (MOCK_REPLIER.test(message.to)) this.box.replied.add(message.conversationId);
    const n = draftId.slice(ID_PREFIX.length);
    return { id: draftId, internetMessageId: `<mock-${n}@relay.example>`, conversationId: message.conversationId };
  }

  async getMessage(account: ConnectedAccountRef, id: string): Promise<MailState> {
    this.calls.push({ method: "getMessage", accountId: account.id, id });
    const message = this.box.messages.get(id);
    if (message === undefined) return { notFound: true };
    const n = id.slice(ID_PREFIX.length);
    return {
      id,
      internetMessageId: `<mock-${n}@relay.example>`,
      conversationId: message.conversationId,
      isDraft: message.isDraft,
      ...(message.isDraft ? {} : { sentDateTime: "2026-10-14T07:00:00Z" }),
    };
  }

  async deleteDraft(account: ConnectedAccountRef, id: string): Promise<void> {
    this.calls.push({ method: "deleteDraft", accountId: account.id, id });
    // `messages` is an in-memory Map standing in for a mailbox, not a Prisma
    // delegate: this forgets a mock draft, it does not delete a row. The delete
    // ban's selector cannot tell a Map held on a field from a model, which is
    // why it asks for the directive below.
    if (this.box.messages.get(id)?.isDraft === true) {
      // eslint-disable-next-line no-restricted-syntax -- in-memory Map, not Prisma
      this.box.messages.delete(id);
    }
  }

  async listSince(account: ConnectedAccountRef, since: Date, select: string[]): Promise<MailMeta[]> {
    this.calls.push({ method: "listSince", accountId: account.id, since, select });
    const value = this.box.inbox ?? (graphFixture.inbox.value as MailMeta[]);
    return value.filter((m) => {
      const at = m.receivedDateTime ? Date.parse(m.receivedDateTime) : NaN;
      return Number.isNaN(at) || at >= since.getTime();
    });
  }

  async conversationHasReply(account: ConnectedAccountRef, conversationId: string, sinceMessageId: string): Promise<boolean> {
    this.calls.push({ method: "conversationHasReply", accountId: account.id, conversationId, sinceMessageId });
    return this.box.replied.has(conversationId);
  }
}
