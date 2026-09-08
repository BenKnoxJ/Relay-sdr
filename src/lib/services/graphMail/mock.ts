import graphFixture from "../../../../fixtures/integrations/graph-message.json";
import { ServiceError, type ConnectedAccountRef, type GraphMailService, type MailMeta, type MailState } from "../types";

export type GraphMockCall =
  | { method: "createDraft"; accountId: string; msg: { to: string; subject: string; body: string } }
  | { method: "send"; accountId: string; draftId: string }
  | { method: "getMessage"; accountId: string; id: string }
  | { method: "deleteDraft"; accountId: string; id: string }
  | { method: "listSince"; accountId: string; since: Date; select: string[] };

const ID_PREFIX = "AAMk-mock-";

/** Deterministic contract mock: ids are numbered from 1 per instance. */
export class MockGraphMailService implements GraphMailService {
  readonly calls: GraphMockCall[] = [];
  private n = 0;
  /** Drafts this instance has created, and which of them have been sent. */
  private readonly drafts = new Set<string>();
  private readonly sent = new Set<string>();
  /** What `listSince` returns; null means the committed inbox fixture. */
  private inbox: MailMeta[] | null = null;

  reset(): void {
    this.calls.length = 0;
    this.n = 0;
    this.drafts.clear();
    this.sent.clear();
    this.inbox = null;
  }

  /** Hand the mailbox a specific set of messages for the next `listSince`. */
  setInbox(messages: MailMeta[]): void {
    this.inbox = messages;
  }

  async createDraft(account: ConnectedAccountRef, msg: { to: string; subject: string; body: string }) {
    this.calls.push({ method: "createDraft", accountId: account.id, msg });
    this.n += 1;
    const id = `${ID_PREFIX}${this.n}`;
    this.drafts.add(id);
    return { id };
  }

  async send(account: ConnectedAccountRef, draftId: string) {
    this.calls.push({ method: "send", accountId: account.id, draftId });
    // A draft this mailbox never had, or one already thrown away, is a 404 from
    // Graph — and `LiveGraphMailService.send` classifies that as a hard failure,
    // NOT as sent-but-unverified. A mock that answered happily would let Phase 1
    // develop against a state machine the live client refuses.
    if (!this.drafts.has(draftId)) {
      throw new ServiceError({ service: "graph", status: 404, code: "ErrorItemNotFound" });
    }
    const n = draftId.slice(ID_PREFIX.length);
    this.sent.add(draftId);
    return {
      id: `${ID_PREFIX}${n}`,
      internetMessageId: `<mock-${n}@relay.example>`,
      conversationId: `AAQk-mock-conv-${n}`,
    };
  }

  async getMessage(account: ConnectedAccountRef, id: string): Promise<MailState> {
    this.calls.push({ method: "getMessage", accountId: account.id, id });
    if (!this.drafts.has(id)) return { notFound: true };
    const n = id.slice(ID_PREFIX.length);
    return {
      id,
      internetMessageId: `<mock-${n}@relay.example>`,
      conversationId: `AAQk-mock-conv-${n}`,
      isDraft: !this.sent.has(id),
      ...(this.sent.has(id) ? { sentDateTime: "2026-10-14T07:00:00Z" } : {}),
    };
  }

  async deleteDraft(account: ConnectedAccountRef, id: string): Promise<void> {
    this.calls.push({ method: "deleteDraft", accountId: account.id, id });
    // `drafts` is an in-memory Set standing in for a mailbox, not a Prisma
    // delegate: this forgets a mock draft, it does not delete a row. The delete
    // ban's selector cannot tell a Set held on a field from a model, which is
    // why it asks for the directive below.
    // eslint-disable-next-line no-restricted-syntax -- in-memory Set, not Prisma
    this.drafts.delete(id);
  }

  async listSince(account: ConnectedAccountRef, since: Date, select: string[]): Promise<MailMeta[]> {
    this.calls.push({ method: "listSince", accountId: account.id, since, select });
    const value = this.inbox ?? (graphFixture.inbox.value as MailMeta[]);
    return value.filter((m) => {
      const at = m.receivedDateTime ? Date.parse(m.receivedDateTime) : NaN;
      return Number.isNaN(at) || at >= since.getTime();
    });
  }
}
