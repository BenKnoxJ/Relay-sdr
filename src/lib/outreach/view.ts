import type { OutreachDraft } from "@prisma/client";

import { inboxCopy, type FitWord, type NeedsYouReason } from "@/lib/copy/inbox";
import type { DraftItem, Opener } from "@/lib/fixtures/inbox";
import type { QueuedDraft } from "@/lib/repo/outreach";

import { firstNameOf, previewFields } from "./adapter";

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

export function draftItemOf(draft: QueuedDraft, repName: string): DraftItem {
  const preview = previewFields(draft.campaignPerson.preview);
  const needsYou: NeedsYouReason | null = draft.state === "needs_you" ? "checks" : draft.state === "failed" ? "not_written" : null;
  return {
    kind: "draft",
    id: draft.id,
    person: { name: preview.name, title: preview.title, company: preview.company, email: draft.campaignPerson.person?.email ?? null },
    ordinal: 1,
    total: 1,
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
    envelope: { greeting: `Hi ${firstNameOf(preview.name)},`, signOff: firstNameOf(repName) },
    campaignName: draft.campaign.name,
    written: draft.state !== "failed",
  };
}

export const noPersonFactLine = inboxCopy.noPersonFact;
