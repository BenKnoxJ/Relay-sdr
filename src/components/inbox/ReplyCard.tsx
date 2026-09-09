import { Card } from "@/components/Card";
import { inboxCopy, type ReplyLabel } from "@/lib/copy/inbox";
import type { ReplyItem } from "@/lib/fixtures/inbox";

import { LabelRow } from "./LabelRow";
import { WhoLine } from "./WhoLine";

/**
 * The reply card (master doc §23.1b; mock section 2b).
 *
 * Their message in full, the email it answers collapsed beneath it, and one
 * job: label it. No Zoho record link on the card; every label appends a Note
 * over there and the rep does not need to see it happen.
 *
 * "Reply from your mailbox" is a link, because that is what it is: the thread
 * in their own mailbox when the fixture has one, or a `mailto:` to the person
 * when it does not. Drafted replies are 1b; until then nothing here writes an
 * email.
 *
 * The sent email is a native `<details>`: collapsed by default, opens on a
 * click or Enter, and needs no script to do either.
 */
export function ReplyCard({
  item,
  onLabel,
}: {
  item: ReplyItem;
  onLabel: (id: string, label: ReplyLabel) => void;
}) {
  const href =
    item.threadUrl ??
    `mailto:${mailtoAddress(item.person.email ?? "")}?subject=${encodeURIComponent(`Re: ${item.sent.subject}`)}`;

  return (
    <Card>
      <WhoLine person={item.person} aside={`${inboxCopy.repliedAt} ${item.receivedAt}`} />

      <div
        data-testid="their-message"
        className="type-body mb-3 rounded-input border border-line bg-ground px-3.5 py-3"
      >
        {item.message.map((paragraph, index) => (
          <p key={index} className="mb-2 last:mb-0">
            {paragraph}
          </p>
        ))}
      </div>

      <details data-testid="sent-email" className="mb-4 text-12 text-muted">
        <summary className="cursor-pointer rounded-input focus-visible:outline-none focus-visible:ring-2">
          {inboxCopy.yourEmail} {item.sent.sentAt}
          {inboxCopy.join}&ldquo;{item.sent.subject}&rdquo;
        </summary>
        <div className="type-body mt-2 max-w-measure text-muted">
          {item.sent.body.map((paragraph, index) => (
            <p key={index} className="mb-2 last:mb-0">
              {paragraph}
            </p>
          ))}
        </div>
      </details>

      <h3 className="type-label mb-2 text-12">{inboxCopy.labelThis}</h3>
      <LabelRow onChoose={(label) => onLabel(item.id, label)} />

      <div className="mt-4 flex justify-end">
        <a
          href={href}
          className="rounded-pill text-13 font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
        >
          {inboxCopy.replyFromMailbox} &rarr;
        </a>
      </div>
    </Card>
  );
}

/**
 * The address part of a `mailto:`, percent-encoded on both sides of the `@`
 * (RFC 6068 §2) so a `?`, `&`, `%`, `+` or a space in a real address can
 * neither start the query early nor be read back as something else. The `@`
 * itself stays, because that is how a mail client, and a rep reading the
 * status bar, expects an address to look.
 */
function mailtoAddress(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return encodeURIComponent(email);
  return `${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}`;
}
