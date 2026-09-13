/**
 * The printed research pack (task 20): "What Relay learned", laid out as a
 * document to save as a PDF and share inside the rep's company.
 *
 * Only the pack's own frame is here: its cover, its opening page and its
 * footer. Every part of it reuses the research page's words
 * (`src/lib/copy/research.ts`), and research's own words reach the paper as
 * research wrote them.
 */
export const reportCopy = {
  /** The research page's one way to the pack. */
  printAction: "Print / save PDF",
  /** What the pack is called, on its cover and in the name a saved PDF is given. */
  kind: "Campaign Research Pack",
  /** Who the pack is for. On the cover, and in the footer of every page after it. */
  classification: "Internal: not for prospects",
  classificationNote:
    "This pack holds competitor prices, what the product can't do, what not to claim, contact rules, open questions, and public sources that name people. Share it inside your company only.",
  whoLabel: "Who to reach, as the campaign was briefed",
  fields: {
    product: "Product",
    motion: "Motion",
    where: "Where",
    channels: "Channels",
    researched: "Researched",
    sources: "Sources",
  },
  notDated: "Date not given",
  contents: "In this pack",
  glance: "At a glance",
  howToRead: "How to read this pack",
  howToReadText:
    "Every finding carries its source and how sure research is of it: strong, moderate, weak, or a guess. A quote is the source's own words; everything else is research's reading of the sources. Kinds of buyer and example firms are who to aim at: nobody has been contacted.",
  preparedBy: "Prepared by Relay from this campaign's research.",
  /** The footer of every page after the cover, and its page number: "Page 3 of 21". */
  footer: "Relay · Campaign Research Pack · Internal: not for prospects",
  page: "Page",
  pageOf: "of",
  /** Joins the campaign's name to the pack's in the name a saved PDF is given. */
  titleJoin: " · ",
} as const;
