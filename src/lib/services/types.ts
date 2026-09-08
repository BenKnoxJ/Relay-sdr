/**
 * Integration adapter contracts (§19).
 *
 * Every external system is reached through one of these interfaces. Each has a
 * deterministic contract mock (fixtures under `fixtures/integrations/`) and a
 * live client; `services()` picks between them from `INTEGRATIONS`.
 *
 * **Adapters never touch the database.** They take the projection they need,
 * do the call, and hand the result back; persisting a refreshed token or
 * recording a ServiceCall row is the caller's job, through `src/lib/repo`.
 * That is not a convention — `eslint.config.mjs` bans `@/lib/db` and
 * `@prisma/client` under `src/lib/services/**`, and `tests/lint/services.test.ts`
 * proves it.
 *
 * Carried from Sales360, which built and tested both clients against the live
 * APIs (§6: carry the tested service layers). What changed: the environment
 * keys are Relay's, Lusha and Notify are not here (Lusha is a later slice,
 * Notify is dropped), and Zoho keeps only the slice-1 thin write-back — calls
 * and deals arrive in slice 3 (§19).
 */

/**
 * Minimal ConnectedAccount projection an adapter needs: never the whole row.
 *
 * `orgId` rides along even though no adapter reads it, because the caller's
 * token-refresh hook does: writing the new blob back goes through `mutate`,
 * which needs the tenant, and re-reading the row to find it would mean a
 * database round trip inside a hook whose whole point is that the adapter did
 * not do one.
 */
export type ConnectedAccountRef = {
  id: string;
  orgId: string;
  userId: string;
  /** Matches the `Provider` enum in `prisma/schema.prisma`. */
  provider: "graph" | "linkedin";
  /** AES-256-GCM blob from `crypto.ts` wrapping `MailTokens`. */
  encTokens: string;
};

/** The decrypted token blob stored in `ConnectedAccount.encTokens`. */
export type MailTokens = {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 instant at which `accessToken` expires. */
  expiresAt: string;
};

/** Mail metadata as returned by a Graph `$select` list; fields follow `select`. */
export type MailMeta = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  receivedDateTime?: string;
  subject?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  [key: string]: unknown;
};

// ------------------------------------------------------------ Graph mail

/** What a read-back of one message says: enough to tell a draft from a sent item. */
export type MailState =
  | { notFound: true }
  | {
      notFound?: false;
      id: string;
      internetMessageId: string;
      conversationId: string;
      isDraft: boolean;
      sentDateTime?: string;
    };

export interface GraphMailService {
  createDraft(
    account: ConnectedAccountRef,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string }>;
  send(
    account: ConnectedAccountRef,
    draftId: string,
  ): Promise<{ id: string; internetMessageId: string; conversationId: string }>;
  /**
   * Read one message back by id. The send path uses it to answer the only question
   * that matters after a failure: did this draft already go out? A missing message
   * is an ordinary answer, not an error.
   */
  getMessage(account: ConnectedAccountRef, id: string): Promise<MailState>;
  /**
   * Throw away a draft we are not going to send — after an edit, the old draft in
   * the mailbox still carries the old words. A draft that is already gone is a
   * success, not an error.
   */
  deleteDraft(account: ConnectedAccountRef, id: string): Promise<void>;
  listSince(account: ConnectedAccountRef, since: Date, select: string[]): Promise<MailMeta[]>;
}

// ------------------------------------------------------------------ Zoho

export type ZohoField = {
  api_name: string;
  field_label?: string;
  data_type: string;
  read_only?: boolean;
  pick_list_values?: { display_value: string; actual_value: string }[];
};

export type ZohoLeadInput = {
  Email: string;
  Last_Name: string;
  Company: string;
  First_Name?: string;
  Designation?: string;
  Website?: string;
  City?: string;
  Country?: string;
  Phone?: string;
  Lead_Source?: string;
  Lead_Status?: string;
  /** The Zoho user the lead belongs to — the rep who is working them. */
  Owner?: { id: string };
  [field: string]: unknown;
};

/** An arbitrary set of Zoho Lead fields to merge into an existing record. */
export type ZohoLeadFields = Record<string, unknown>;

/** What Relay needs to know about a lead that already exists in CRM. */
export type ZohoLeadMatch = { id: string; optOut: boolean; isCustomer: boolean };

/**
 * The slice-1 thin write-back (§19): read customers and do-not-contact, upsert
 * the lead, append a note, mirror the opt-out. Calls and deals are slice 3 and
 * are deliberately absent — an interface that cannot log a call is one no
 * caller can accidentally start logging calls through.
 *
 * There is no `deleteLead` here for the same reason. The live client has one,
 * because the live smoke probe has to clean up the lead it created, but it is
 * not on the interface: nothing Relay ships should be able to delete a lead
 * out of a customer's CRM (§25, rule 1).
 */
export interface ZohoService {
  fields(module: "Leads"): Promise<ZohoField[]>;
  upsertLead(lead: ZohoLeadInput): Promise<{ id: string; created: boolean }>;
  addNote(leadId: string, note: string): Promise<{ id: string }>;
  setStatus(leadId: string, status: string): Promise<void>;
  /** The lead already in CRM for this address, or failing that this company. */
  findLead(query: { email?: string; domain?: string }): Promise<ZohoLeadMatch | null>;
  /** Merge fields into an existing lead — the do-not-contact write, and little else. */
  updateLead(id: string, fields: ZohoLeadFields): Promise<void>;
}

// ----------------------------------------------------------------- Errors

export type ServiceName = "graph" | "zoho";

/** Thrown by every live client on a non-2xx response. Carries no response body. */
export class ServiceError extends Error {
  readonly service: ServiceName;
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(args: {
    service: ServiceName;
    status: number;
    code?: string;
    requestId?: string;
    message?: string;
  }) {
    super(
      args.message ??
        `${args.service} request failed with ${args.status}${args.code ? ` (${args.code})` : ""}`,
    );
    this.name = "ServiceError";
    this.service = args.service;
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
  }
}

/**
 * The send reached Microsoft (202) but the read-back of the sent item's ids failed.
 * The mail IS delivered — callers must never treat this as an unsent touch; record
 * the send and reconcile the ids later.
 */
export class SentButUnverifiedError extends ServiceError {
  readonly draftId: string;
  constructor(args: { draftId: string; status: number; code?: string; requestId?: string; cause?: unknown }) {
    super({
      service: "graph",
      status: args.status,
      code: args.code,
      requestId: args.requestId,
      message: `message ${args.draftId} was sent but its ids could not be read back`,
    });
    this.name = "SentButUnverifiedError";
    this.draftId = args.draftId;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}

/** Injection points shared by every live client. */
export type LiveDeps = {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
};
