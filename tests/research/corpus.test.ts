import { describe, expect, it } from "vitest";

import { createCorpus, normaliseUrl } from "@/lib/research/corpus";

describe("the corpus", () => {
  it("normalises URLs so the same page is one entry", () => {
    expect(normaliseUrl("HTTPS://WWW.Example.com/Path/#frag")).toBe("https://example.com/Path");
    expect(normaliseUrl("https://example.com:443/a/")).toBe("https://example.com/a");
    expect(normaliseUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    expect(normaliseUrl("not a url ")).toBe("not a url");
  });

  it("holds pages and snippets, and answers has() only when there is text", () => {
    const corpus = createCorpus();
    corpus.addSnippet("https://www.example.com/a/", "a snippet");
    expect(corpus.has("https://example.com/a")).toBe(true);
    corpus.addPage("https://example.com/a#x", "the page");
    corpus.addSnippet("https://example.com/a", "a snippet");
    expect(corpus.textFor("https://example.com/a/")).toBe("the page\na snippet");
    expect(corpus.size()).toBe(1);
    corpus.markUnreadable("https://Example.com/b/");
    expect(corpus.unreadable.has("https://example.com/b")).toBe(true);
    expect(corpus.has("https://example.com/b")).toBe(false);
  });
});
