import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { settingsCopy } from "@/lib/copy/settings";

/**
 * Settings, as far as the shell goes (master doc §23.1f).
 *
 * The four signed cards in one column, no tabs, in the signed order, each
 * saying the same thing: it arrives with the connect step. Task 10b fills
 * Mailbox in — connect, disconnect, health chip — and the other three follow
 * their own tasks, into these cards rather than beside them.
 */
const CARDS = [
  settingsCopy.mailbox,
  settingsCopy.linkedin,
  settingsCopy.voice,
  settingsCopy.calls,
];

export default function SettingsPage() {
  return (
    <>
      <PageHeader title={settingsCopy.title} note={settingsCopy.note} />
      {/* One column, 720px, as the signed mock draws it (section 5). */}
      <div className="grid max-w-[720px] gap-grid">
        {CARDS.map((heading) => (
          <Card key={heading} label={heading}>
            <p className="type-body text-muted">{settingsCopy.coming}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
