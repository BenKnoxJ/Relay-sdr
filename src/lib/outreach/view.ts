import type { OutreachDraft } from "@prisma/client";

import { EMAIL_TOUCHES } from "../../../agents/outreach/input.schema";
import { inboxCopy, type FitWord, type NeedsYouReason } from "@/lib/copy/inbox";
import type { DraftItem, Opener } from "@/lib/fixtures/inbox";
import type { QueuedDraft } from "@/lib/repo/outreach";

import { firstNameOf, previewFields } from "./adapter";
import { envelopeOf } from "./envelope";

/**
 * A stored draft as the Inbox card draws it: the signed `DraftItem` shape, so
 * the card the fixtures drew is the card real drafts land on. No provider
 * ids, no lookup internals: the opener's words, its source and its date.
 */

type StoredOpener = { ref: string; kind: string; text?: string; source?: string; date?: string };

function openerOf(value: unknown): Opener {
  const opener = (value ?? {}) as StoredOpener;
  const kind = opener.kind === "person_fact" || opener.kind === "firm_fact" ? opener.kind : "role_pain";
  return { id: opener.ref ?? "", kind, text: opener.text ?? "", source: opener.source ?? "", date: opener.date ?? "" };
}

function fitOf(roleMatch: string | null): FitWord {
  return roleMatch === "exact" ? "strong" : roleMatch === "phrase" ? "fair" : "weak";
}

function findingTexts(value: OutreachDraft["findings"]): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => (entry !== null && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string" ? [(entry as { text: string }).text] : [])) : [];
}

/**
 * `signature` is the rep's Settings signature as stored (HTML). The card
 * shows it as plain lines, because the rep reads the card and copies from it.
 */
export function draftItemOf(draft: QueuedDraft, repName: string, signature = ""): DraftItem {
  const preview = previewFields(draft.campaignPerson.preview);
  // A touch parked with nothing written (the drafting limit) reads as not written, whatever its state.
  const needsYou: NeedsYouReason | null = draft.state === "failed" || (draft.state === "needs_you" && draft.body === null) ? "not_written" : draft.state === "needs_you" ? "checks" : null;
  return {
    kind: "draft",
    id: draft.id,
    person: { name: preview.name, title: preview.title, company: preview.company, email: draft.campaignPerson.person?.email ?? null },
    // Where this email sits in the person's three: "Email 2 of 3".
    ordinal: Math.max(1, (EMAIL_TOUCHES as readonly string[]).indexOf(draft.touch) + 1),
    total: EMAIL_TOUCHES.length,
    draft: {
      kind: "message",
      ...(draft.subject === null ? {} : { subject: draft.subject }),
      body: draft.editedBody ?? draft.body ?? "",
      ask: draft.ask ?? "",
      opener: { ref: openerOf(draft.opener).id || "none", kind: openerOf(draft.opener).kind },
      claims: draft.claims,
    },
    opener: openerOf(draft.opener),
    emailFound: draft.campaignPerson.person !== null,
    fit: fitOf(draft.campaignPerson.roleMatch),
    sends: null,
    needsYou,
    findings: findingTexts(draft.findings),
    advice: findingTexts(draft.advice),
    envelope: envelopeOf({ firstName: firstNameOf(preview.name), repName: firstNameOf(repName), signature }),
    campaignName: draft.campaign.name,
    written: draft.state !== "failed" && draft.body !== null,
  };
}

export const noPersonFactLine = inboxCopy.noPersonFact;
