import { Card } from "./Card";
import { Chip } from "./Chip";
import { DailyCapField } from "./DailyCapField";
import { PillButton } from "./PillButton";

import { mailboxCopy, settingsCopy } from "@/lib/copy/settings";

/** Exactly what `connections.get` returns, in the two shapes it has. */
export type MailboxState =
  | { connected: false; adminCap: number; none: string; connect: string }
  | {
      connected: true;
      address: string | null;
      status: "healthy" | "expiring" | "paused";
      healthTone: "ok" | "warn";
      health: string;
      healthNote: string | null;
      cap: number;
      adminCap: number;
      capNote: string;
      provider: string;
      window: string;
      days: string;
      ramp: string;
    };

/**
 * The Mailbox card (master doc §23.1f, mock section 5).
 *
 * Pure: every value and both actions arrive as props, so the Settings route can
 * be a server component that resolves the session and this can be rendered in a
 * test without one — the same shape `HomeDayOne` takes.
 *
 * Two states and no third. A mailbox the rep disconnected reads as one they
 * never connected, because "connect it" is the only thing they can do about
 * either; `connections.get` makes that decision, and this renders it.
 *
 * One primary button per card (§21, "one accent … on one control per card").
 * There is exactly one on every state of this card: Connect when there is no
 * mailbox, "Connect it again" when there is one Microsoft has stopped
 * accepting, and none at all when the mailbox is working — where the only
 * control is a text-variant Disconnect.
 *
 * The re-link button matters more than it looks. Without it the only route out
 * of `expiring` is Disconnect and then Connect, and Disconnect destroys the
 * stored tokens — so recovering from an expiry the rep did not cause would mean
 * throwing away the connection first.
 */
export function MailboxCard({
  state,
  banner,
  connect,
  disconnect,
  saveCap,
}: {
  state: MailboxState;
  /** The line from a callback that has just come back, or null. */
  banner: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  saveCap: (previous: string | null, form: FormData) => Promise<string | null>;
}) {
  return (
    <Card label={settingsCopy.mailbox}>
      {banner === null ? null : (
        // `role="status"` and not an alert: a connect that worked and one that
        // did not are both answers to something the rep just did, and neither
        // interrupts what they are doing now.
        <p role="status" className="type-small mb-3 text-muted">
          {banner}
        </p>
      )}

      {state.connected ? (
        <div className="grid justify-items-start gap-3">
          <div className="flex w-full items-start justify-between gap-3">
            <div>
              {/* The address is the heading of the card's content, so it is the
                  first thing read out; the provider sits under it as detail. */}
              <p className="type-body text-ink">{state.address}</p>
              <p className="type-small text-muted">{state.provider}</p>
            </div>
            <Chip tone={state.healthTone}>{state.health}</Chip>
          </div>

          {state.healthNote === null ? null : (
            <p className="type-small text-warn">{state.healthNote}</p>
          )}

          {state.status !== "expiring" ? null : (
            <form action={connect} className="justify-self-start">
              <PillButton type="submit">{mailboxCopy.connectAgain}</PillButton>
            </form>
          )}

          <DailyCapField
            cap={state.cap}
            adminCap={state.adminCap}
            note={state.capNote}
            action={saveCap}
          />

          <Row label={mailboxCopy.windowLabel} value={state.window} />
          <Row label={mailboxCopy.daysLabel} value={state.days} />
          <Row label={mailboxCopy.rampLabel} value={state.ramp} />

          <div className="mt-1">
            <form action={disconnect}>
              <PillButton type="submit" variant="text">
                {mailboxCopy.disconnect}
              </PillButton>
            </form>
            <p className="type-small mt-1 max-w-prose text-muted">{mailboxCopy.disconnectNote}</p>
          </div>
        </div>
      ) : (
        <div className="grid justify-items-start gap-3">
          <p className="type-body text-muted">{state.none}</p>
          <form action={connect}>
            <PillButton type="submit">{state.connect}</PillButton>
          </form>
        </div>
      )}
    </Card>
  );
}

/**
 * One read-only line: the label at the width the cap field's label uses, so
 * the four rows line up on a single left edge rather than each finding its own.
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="type-small w-[136px] shrink-0 text-muted">{label}</span>
      <span className="type-body text-ink">{value}</span>
    </div>
  );
}
