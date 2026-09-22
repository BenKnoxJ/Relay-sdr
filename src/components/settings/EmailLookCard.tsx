"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { emailLookCopy as c } from "@/lib/copy/send";
import { EMAIL_FONT_NAMES, EMAIL_FONT_SIZE_MAX, EMAIL_FONT_SIZE_MIN, previewDocument, type EmailFont, type EmailLook } from "@/lib/outreach/emailLook";

import { FIELD, SaveLine } from "./SaveLine";

type LookInput = { font: EmailFont; fontSize: number; signature: string };

const SIZES = Array.from({ length: EMAIL_FONT_SIZE_MAX - EMAIL_FONT_SIZE_MIN + 1 }, (_, index) => EMAIL_FONT_SIZE_MIN + index);
const PREVIEW_DELAY_MS = 400;

/**
 * Your email look (Relay P7): the font and size Relay sends in, the
 * signature pasted from Outlook, and a live preview of an email in them.
 *
 * The signature box is rich text, because an Outlook signature is: pasting
 * keeps its bold, colours, links and logo. It only ever holds what the server
 * would store. A paste is not dropped in as the browser offers it; its HTML
 * goes to the server, is sanitised there, and the box is set to what came
 * back. Typing adds text; a drop is refused. Save sanitises again. Every
 * `innerHTML` written below is an answer from the server's `sanitizeSignature`.
 *
 * The preview is the email as the server builds it, in a frame sandboxed with
 * no permissions: no script, no form, no link out of it, and nothing inside
 * can reach the app.
 */
export function EmailLookCard({
  initial,
  initialPreview,
  save,
  preview,
}: {
  initial: EmailLook;
  initialPreview: string;
  save: (input: LookInput) => Promise<{ look: EmailLook; preview: string } | { error: string }>;
  preview: (input: LookInput) => Promise<{ preview: string; signature: string } | { error: string }>;
}) {
  const [font, setFont] = useState<EmailFont>(initial.font);
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [html, setHtml] = useState(initialPreview);
  const [line, setLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(0);
  const fontId = useId();
  const sizeId = useId();
  const signatureId = useId();

  // The saved signature, already sanitised on the server, is the box's starting content.
  useEffect(() => {
    if (editor.current !== null) editor.current.innerHTML = initial.signature;
  }, [initial.signature]);

  const current = (): LookInput => ({ font, fontSize, signature: editor.current?.innerHTML ?? "" });

  /** Ask for the preview of what the card now holds; only the latest answer is shown. */
  function refresh(input: LookInput, replaceSignature: boolean) {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const ask = ++asked.current;
      const answer = await preview(input).catch(() => null);
      if (answer === null || ask !== asked.current) return;
      if ("error" in answer) {
        setLine(answer.error);
        return;
      }
      setHtml(answer.preview);
      if (replaceSignature && editor.current !== null) editor.current.innerHTML = answer.signature;
    }, replaceSignature ? 0 : PREVIEW_DELAY_MS);
  }

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const pasted = event.clipboardData.getData("text/html");
    if (pasted === "") return; // Plain text: the browser inserts it as text.
    event.preventDefault();
    // A signature is pasted whole: the pasted HTML replaces the box, through the server's sanitiser.
    setLine(null);
    refresh({ font, fontSize, signature: pasted }, true);
  }

  async function onSave() {
    setSaving(true);
    setLine(null);
    try {
      const answer = await save(current());
      if ("error" in answer) {
        setLine(answer.error);
        return;
      }
      if (editor.current !== null) editor.current.innerHTML = answer.look.signature;
      setHtml(answer.preview);
      setLine(c.saved);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card label={c.title} aside={<SaveLine line={line} />}>
      <div data-testid="email-look" className="grid gap-4">
        <p className="type-small text-muted">{c.note}</p>

        <div className="flex flex-wrap gap-3">
          <label htmlFor={fontId} className="grid gap-1">
            <span className="type-label">{c.font}</span>
            <select
              id={fontId}
              data-testid="email-look-font"
              value={font}
              onChange={(event) => {
                const next = event.currentTarget.value as EmailFont;
                setFont(next);
                refresh({ ...current(), font: next }, false);
              }}
              className={`${FIELD} w-56`}
            >
              {EMAIL_FONT_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={sizeId} className="grid gap-1">
            <span className="type-label">{c.size}</span>
            <select
              id={sizeId}
              data-testid="email-look-size"
              value={fontSize}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                setFontSize(next);
                refresh({ ...current(), fontSize: next }, false);
              }}
              className={`${FIELD} w-24`}
            >
              {SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} {c.sizeUnit}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-1">
          <span id={signatureId} className="type-label">
            {c.signature}
          </span>
          <div
            ref={editor}
            role="textbox"
            aria-multiline="true"
            aria-labelledby={signatureId}
            aria-placeholder={c.signaturePlaceholder}
            contentEditable
            suppressContentEditableWarning
            data-testid="email-look-signature"
            onPaste={onPaste}
            // A drop would put the browser's HTML in the box without passing the server's sanitiser: paste instead.
            onDrop={(event) => event.preventDefault()}
            onInput={() => refresh(current(), false)}
            className={`${FIELD} min-h-24 bg-panel empty:before:text-muted empty:before:content-[attr(aria-placeholder)]`}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <PillButton data-testid="email-look-save" disabled={saving} onClick={() => void onSave()}>
              {saving ? c.saving : c.save}
            </PillButton>
            <PillButton
              variant="text"
              data-testid="email-look-clear"
              disabled={saving}
              onClick={() => {
                if (editor.current !== null) editor.current.innerHTML = "";
                refresh({ ...current(), signature: "" }, false);
              }}
            >
              {c.clear}
            </PillButton>
          </div>
        </div>

        <div className="grid gap-1">
          <span className="type-label">{c.preview}</span>
          <p className="type-small text-muted">{c.previewNote}</p>
          <iframe
            title={c.preview}
            data-testid="email-look-preview"
            sandbox=""
            srcDoc={previewDocument(html)}
            // The frame's own document is white paper and black ink, as Outlook shows it, in either theme.
            className="h-72 w-full rounded-input border border-line bg-panel"
          />
        </div>
      </div>
    </Card>
  );
}
