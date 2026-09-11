"use client";

import { useId, useRef, useState } from "react";

import { Card } from "@/components/Card";
import { linkedinCopy, settingsCopy } from "@/lib/copy/settings";
import { getProfile, saveProfile, type RepProfile } from "@/lib/fixtures/repProfile";
import { checkLinkedinUrl } from "@/lib/settings/validate";

import { FIELD, SaveLine } from "./SaveLine";

/**
 * The LinkedIn card (master doc §23.1f, mock section 5): the profile link and
 * one line saying posting arrives with Content. No connect button, because in
 * slice 1 Relay prepares messages and the rep pastes them; the link is so a
 * draft can name the profile.
 *
 * Saves on blur, guarded on the value having changed since the last save, as
 * `DailyCapField` does. A link that is not a profile link is refused on the
 * same line the "Saved" would have used, and the field keeps what the rep
 * typed so they can fix it rather than retype it.
 *
 * `initial` exists so a test can hand in a profile; left out, the adapter's
 * own is used, which is the page's case.
 */
export function LinkedInCard({ initial }: { initial?: RepProfile }) {
  const [url, setUrl] = useState(() => (initial ?? getProfile()).linkedinUrl ?? "");
  const [line, setLine] = useState<string | null>(null);
  const lastSaved = useRef(url);
  const id = useId();

  function onBlur(event: React.FocusEvent<HTMLInputElement>) {
    const raw = event.currentTarget.value;
    if (raw === lastSaved.current) return;
    const checked = checkLinkedinUrl(raw);
    if (!checked.ok) {
      setLine(checked.message);
      return;
    }
    saveProfile({ linkedinUrl: checked.value });
    lastSaved.current = raw;
    setLine(settingsCopy.saved);
  }

  return (
    <Card label={settingsCopy.linkedin} aside={<SaveLine line={line} />}>
      <div className="grid gap-2">
        <div className="flex items-center gap-2.5">
          <label htmlFor={id} className="type-small w-[136px] shrink-0 text-muted">
            {linkedinCopy.profileLabel}
          </label>
          <input
            id={id}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={url}
            placeholder={linkedinCopy.placeholder}
            onChange={(event) => setUrl(event.currentTarget.value)}
            onBlur={onBlur}
            className={FIELD}
          />
        </div>
        <p className="type-small text-muted">{linkedinCopy.note}</p>
      </div>
    </Card>
  );
}
