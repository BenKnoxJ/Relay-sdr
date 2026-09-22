/**
 * The choices behind how a sent email looks (Relay P7): fonts, sizes and the
 * defaults. Constants only, so a screen can import them without bringing the
 * HTML sanitiser into the browser; building and sanitising live in
 * `emailHtml.ts`, on the server.
 */

/** The fonts a rep can choose: common Outlook fonts, each with a fallback stack. */
export const EMAIL_FONTS = {
  Aptos: "Aptos, Calibri, Arial, sans-serif",
  Calibri: "Calibri, Arial, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  "Segoe UI": "'Segoe UI', Tahoma, Arial, sans-serif",
  Verdana: "Verdana, Geneva, sans-serif",
  Tahoma: "Tahoma, Verdana, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  "Times New Roman": "'Times New Roman', Times, serif",
} as const;
export type EmailFont = keyof typeof EMAIL_FONTS;
export const EMAIL_FONT_NAMES = Object.keys(EMAIL_FONTS) as EmailFont[];

export const DEFAULT_EMAIL_FONT: EmailFont = "Aptos";
export const DEFAULT_EMAIL_FONT_SIZE = 11;
/** Point sizes offered; the column's CHECK holds the same bounds. */
export const EMAIL_FONT_SIZE_MIN = 8;
export const EMAIL_FONT_SIZE_MAX = 20;
/** The longest signature kept, in characters after sanitising (a CHECK too). */
export const SIGNATURE_MAX = 20_000;

export const isEmailFont = (value: string): value is EmailFont => Object.prototype.hasOwnProperty.call(EMAIL_FONTS, value);

export type EmailLook = { font: EmailFont; fontSize: number; signature: string };

export const DEFAULT_EMAIL_LOOK: EmailLook = { font: DEFAULT_EMAIL_FONT, fontSize: DEFAULT_EMAIL_FONT_SIZE, signature: "" };

/**
 * A whole HTML document around an email the server built, for Settings'
 * preview frame. The frame is sandboxed with no permissions at all, so even
 * HTML the sanitiser missed could not run a script, submit a form or reach
 * the app; what is inside is already sanitised on the server.
 */
export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head><body style="margin:16px;background:#ffffff;color:#000000">${html}</body></html>`;
}
