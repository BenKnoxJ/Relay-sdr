import sanitizeHtml from "sanitize-html";

import {
  DEFAULT_EMAIL_FONT,
  DEFAULT_EMAIL_FONT_SIZE,
  EMAIL_FONTS,
  EMAIL_FONT_SIZE_MAX,
  EMAIL_FONT_SIZE_MIN,
  isEmailFont,
  type EmailLook,
} from "./emailLook";

export * from "./emailLook";

/**
 * How a sent email looks (Relay P7): the rep's font and size, the greeting,
 * body and sign-off exactly as the draft card shows them, then the signature
 * they pasted from Outlook.
 *
 * Pure: no clock, no database. Graph does not apply the rep's Outlook font or
 * signature to a message sent through the API, so Relay sends HTML that
 * carries both.
 *
 * The signature is the one piece of HTML a rep supplies, and it is shown back
 * in the app (Settings' preview) and sent to prospects, so it passes through
 * `sanitizeSignature` on save and again when an email is built. What survives
 * is formatting and links: no script, no event handler, no `<style>` element,
 * no iframe or form, no `javascript:` or `data:` link, and inline styles only
 * from a short list whose values cannot carry a `url(…)` or an `expression`
 * or position anything outside the signature's own box.
 */

/** A stored look, read defensively: an unknown font or an out-of-range size falls back to the default. */
export function lookOf(row: { emailFont: string; emailFontSize: number; emailSignature: string }): EmailLook {
  return {
    font: isEmailFont(row.emailFont) ? row.emailFont : DEFAULT_EMAIL_FONT,
    fontSize: Number.isInteger(row.emailFontSize) && row.emailFontSize >= EMAIL_FONT_SIZE_MIN && row.emailFontSize <= EMAIL_FONT_SIZE_MAX ? row.emailFontSize : DEFAULT_EMAIL_FONT_SIZE,
    signature: sanitizeSignature(row.emailSignature),
  };
}

// A colour, a length or a short keyword: nothing with brackets but rgb()/rgba(), nothing with a colon or a semicolon.
const COLOUR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.\s,%]+\)$/i, /^[a-z]{3,20}$/i];
const LENGTH = [/^-?\d+(\.\d+)?(px|pt|em|rem|%)?$/i, /^auto$/i];
const LENGTHS = [/^(-?\d+(\.\d+)?(px|pt|em|rem|%)?|auto)(\s+(-?\d+(\.\d+)?(px|pt|em|rem|%)?|auto)){0,3}$/i];
const FONT_FAMILY = [/^[a-z0-9 ,'"-]{1,120}$/i];
const KEYWORD = [/^[a-z-]{1,20}$/i];
const BORDER = [/^[a-z0-9 #.,()%-]{1,60}$/i];

const ALLOWED_STYLES: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    color: COLOUR,
    "background-color": COLOUR,
    "font-family": FONT_FAMILY,
    "font-size": LENGTH,
    "font-weight": [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
    "font-style": [/^(normal|italic|oblique)$/i],
    "text-decoration": KEYWORD,
    "text-align": [/^(left|right|center|justify)$/i],
    "vertical-align": KEYWORD,
    "line-height": LENGTH,
    margin: LENGTHS,
    "margin-top": LENGTH,
    "margin-bottom": LENGTH,
    "margin-left": LENGTH,
    "margin-right": LENGTH,
    padding: LENGTHS,
    "padding-top": LENGTH,
    "padding-bottom": LENGTH,
    "padding-left": LENGTH,
    "padding-right": LENGTH,
    width: LENGTH,
    height: LENGTH,
    border: BORDER,
    "border-top": BORDER,
    "border-bottom": BORDER,
    "border-left": BORDER,
    "border-right": BORDER,
    "border-collapse": KEYWORD,
  },
};

const SIGNATURE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "a", "img", "table", "thead", "tbody", "tr", "td", "th", "hr", "ul", "ol", "li", "small"],
  allowedAttributes: {
    "*": ["style"],
    // `target` and `rel` are set by the transform below, never taken from the paste.
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan", "width", "valign", "align"],
    th: ["colspan", "rowspan", "width", "valign", "align"],
    table: ["cellpadding", "cellspacing", "border", "width"],
  },
  allowedSchemes: ["https", "http", "mailto", "tel"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  allowedStyles: ALLOWED_STYLES,
  // Script, style, iframe, form and the rest go with everything inside them, not just their tags.
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head", "xml", "iframe", "object", "embed"],
  // Every link opens outside whatever is showing it, and tells the destination nothing.
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
  },
};

/**
 * The signature as it may be stored, shown and sent. Outlook's own comments
 * and conditional blocks go with the rest; an empty result means no signature.
 */
export function sanitizeSignature(html: string): string {
  const clean = sanitizeHtml(html, SIGNATURE_OPTIONS).trim();
  // Nothing visible (an empty paragraph, a lone <br>) is no signature.
  return sanitizeHtml(clean, { allowedTags: ["img"], allowedAttributes: { img: ["src"] } }).replace(/&nbsp;|\s/g, "") === "" ? "" : clean;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML: every character that means something in HTML, escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** A block of plain text as paragraphs: a blank line starts a new one, a single line break stays one. */
function paragraphs(text: string, margin: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== "")
    .map((block) => `<p style="margin:0 0 ${margin} 0">${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

export type EmailParts = {
  /** "Hi Avery," as the draft card shows it. */
  greeting: string;
  /** The approved text: the rep's edit if they made one. */
  body: string;
  /** The rep's first name as the card signs off; empty for none. */
  signOff: string;
};

/**
 * The email as HTML: greeting, body and sign-off in the rep's font and size,
 * one blank line between paragraphs as the card draws them, then the
 * signature. The signature is sanitised again here, so a row written before a
 * tightening of the rules cannot send what the rules now refuse.
 */
export function emailHtml(parts: EmailParts, look: EmailLook): string {
  const font = EMAIL_FONTS[isEmailFont(look.font) ? look.font : DEFAULT_EMAIL_FONT];
  const size = Number.isInteger(look.fontSize) && look.fontSize >= EMAIL_FONT_SIZE_MIN && look.fontSize <= EMAIL_FONT_SIZE_MAX ? look.fontSize : DEFAULT_EMAIL_FONT_SIZE;
  const gap = `${size}pt`;
  const text = [paragraphs(parts.greeting, gap), paragraphs(parts.body, gap), parts.signOff.trim() === "" ? "" : paragraphs(parts.signOff, gap)].join("");
  const signature = sanitizeSignature(look.signature);
  // The signature keeps its own fonts, as it does in Outlook; it only inherits the rep's where it sets none.
  return (
    `<div style="font-family:${escapeHtml(font)};font-size:${size}pt">` +
    text +
    (signature === "" ? "" : `<div>${signature}</div>`) +
    `</div>`
  );
}
