import { describe, expect, it } from "vitest";

import { DEFAULT_EMAIL_LOOK, emailHtml, lookOf, previewDocument, sanitizeSignature } from "@/lib/outreach/emailHtml";

/**
 * How a sent email looks (Relay P7): the text escaped, the rep's font and
 * size, the card's envelope in order, and a pasted signature cut down to
 * formatting and links, with nothing that runs, loads a stylesheet or
 * escapes its own box, in the app's preview or in a prospect's mail client.
 */

const XSS = [
  `<script>alert(1)</script>`,
  `<img src="x" onerror="alert(1)">`,
  `<img src="data:image/svg+xml;base64,PHN2Zz4=">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="  JaVaScRiPt:alert(1)">x</a>`,
  `<a href="//evil.example/x">x</a>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<object data="x"></object><embed src="x">`,
  `<form action="https://evil.example"><input name="q"><button>go</button></form>`,
  `<svg onload="alert(1)"><circle /></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `<style>body{display:none}</style>`,
  `<link rel="stylesheet" href="https://evil.example/x.css">`,
  `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
  `<base href="https://evil.example/">`,
  `<p style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999">cover</p>`,
  `<p style="background:url(https://evil.example/track.png)">t</p>`,
  `<p style="background-image:url(javascript:alert(1))">t</p>`,
  `<p style="color:expression(alert(1))">t</p>`,
  `<p style="font-family:x;}</style><script>alert(1)</script>">t</p>`,
  `<!--[if mso]><script>alert(1)</script><![endif]-->`,
  `<p onclick="alert(1)" onmouseover="alert(1)">t</p>`,
];

describe("sanitizeSignature", () => {
  it.each(XSS)("leaves nothing that runs, loads or escapes: %s", (input) => {
    const out = sanitizeSignature(input);
    expect(out).not.toMatch(/<(script|style|iframe|object|embed|form|input|button|svg|math|link|meta|base)\b/i);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).not.toMatch(/javascript:|data:|expression\(|url\(|position|z-index|href="\/\//i);
  });

  it("keeps an Outlook signature's formatting, links and hosted images", () => {
    const pasted = `<div style="font-family:Aptos;font-size:11pt;color:#1F3864"><p style="margin:0"><b>Sam Carter</b> | Sales</p><p style="margin:0"><a href="https://conversant.example">conversant.example</a> · <a href="mailto:sam@conversant.example">email</a> · <a href="tel:+441234567890">call</a></p><table cellpadding="0"><tr><td width="80"><img src="https://conversant.example/logo.png" alt="Conversant" width="80"></td></tr></table></div>`;
    const out = sanitizeSignature(pasted);
    expect(out).toContain('<div style="font-family:Aptos;font-size:11pt;color:#1F3864">');
    expect(out).toContain("<b>Sam Carter</b>");
    expect(out).toContain('<a href="https://conversant.example" target="_blank" rel="noopener noreferrer">');
    expect(out).toContain('href="mailto:sam@conversant.example"');
    expect(out).toContain('href="tel:+441234567890"');
    expect(out).toContain('<img src="https://conversant.example/logo.png" alt="Conversant" width="80" />');
    expect(out).toContain('<td width="80">');
  });

  it("drops a plain-http image, and reads a signature with nothing visible as none", () => {
    expect(sanitizeSignature(`<img src="http://x.example/a.png">`)).toBe("<img />");
    expect(sanitizeSignature(`<p><br></p>&nbsp; <div> </div>`)).toBe("");
    expect(sanitizeSignature(`<!-- Outlook -->`)).toBe("");
  });
});

describe("emailHtml", () => {
  const parts = { greeting: "Hi Avery,", body: "First <b>line</b> & more.\nSame paragraph.\n\nSecond paragraph?", signOff: "Sam" };

  it("escapes the text, keeps the card's paragraphs, and puts greeting, body, sign-off and signature in that order", () => {
    const html = emailHtml(parts, { font: "Aptos", fontSize: 11, signature: "<p>Sam Carter</p>" });
    expect(html).toBe(
      '<div style="font-family:Aptos, Calibri, Arial, sans-serif;font-size:11pt">' +
        '<p style="margin:0 0 11pt 0">Hi Avery,</p>' +
        '<p style="margin:0 0 11pt 0">First &lt;b&gt;line&lt;/b&gt; &amp; more.<br>Same paragraph.</p>' +
        '<p style="margin:0 0 11pt 0">Second paragraph?</p>' +
        '<p style="margin:0 0 11pt 0">Sam</p>' +
        "<div><p>Sam Carter</p></div></div>",
    );
  });

  it("sanitises the signature again when it builds, and never takes a font or size off the list", () => {
    const html = emailHtml(parts, { font: "x;background:url(evil)" as "Aptos", fontSize: 99, signature: "<script>alert(1)</script><p>Sam</p>" });
    expect(html).toMatch(/^<div style="font-family:Aptos, Calibri, Arial, sans-serif;font-size:11pt">/);
    expect(html).not.toContain("script");
    expect(html).not.toContain("evil");
  });

  it("leaves the sign-off out when there is none", () => {
    expect(emailHtml({ ...parts, signOff: " " }, DEFAULT_EMAIL_LOOK)).not.toContain(">Sam<");
  });

  it("reads a stored look defensively", () => {
    expect(lookOf({ emailFont: "Comic Sans", emailFontSize: 3, emailSignature: "<p onclick='x'>S</p>" })).toEqual({ font: "Aptos", fontSize: 11, signature: "<p>S</p>" });
  });

  it("wraps a preview as a whole document", () => {
    expect(previewDocument("<p>x</p>")).toMatch(/^<!doctype html>.*<body[^>]*><p>x<\/p><\/body><\/html>$/);
  });
});
