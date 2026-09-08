/**
 * Campaigns (master doc §23.1c). Day one has no campaigns, so the only string
 * here is the one the brief box's Start comes back with.
 *
 * It lives here and not in `copy/home.ts` because the router that returns it
 * is the Campaigns router: the line is Campaigns answering for itself, and
 * Home is only where it happens to be read out today. With it in Home's file,
 * `src/server/api/routers/campaigns.ts` imported a page's copy to describe its
 * own behaviour, which is a coupling that gets worse as Home grows.
 */
export const campaignsCopy = {
  /**
   * What Start says today. Starting a campaign is slice 1; until then the box
   * takes the sentence, keeps nothing, and says what happens next — which is
   * the §22.7 rule applied to a control rather than to a page.
   */
  next: "Campaigns arrive next",
} as const;
