import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { PeopleTab } from "@/components/people/PeopleTab";
import type { PersonView } from "@/components/people/PersonDrawer";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { findMoreCopy } from "@/lib/copy/findMore";
import { parsePeopleFilter } from "@/lib/outreach/peopleList";
import { londonDay } from "@/lib/outreach/sequence";
import { serverCaller } from "@/server/api/caller";
import { getCampaign } from "@/server/campaigns";

import {
  addNoteAction,
  approveDraftAction,
  markStepAction,
  meetingBookedAction,
  rejectDraftAction,
  setOutcomeAction,
  setPhoneAction,
  tryAgainAction,
  undoAction,
} from "./peopleActions";
import { chooseIndustry, confirmPlan, createPlayCampaigns, findMorePeople, pauseOutreach, retryPeople, retryResearch, retryRevealEmails, revealEmails, reviewPeople, startOutreach, widenResearch, writeEmails } from "./actions";

/**
 * One campaign (master doc §23.1c, mock 3b and 3c).
 *
 * The page resolves the campaign and hands it over whole; every state the
 * screen has is a state of that one object, derived on the server from the
 * campaign and its research. An id that is not one of the rep's campaigns is a
 * 404 rather than an empty page.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (campaign === null) notFound();

  // Start sends the rep here and says research has started and nothing was
  // bought or sent (§23.1d); a widening, an edit and Try again say Relay is
  // looking again. The line is shown on arrival.
  const query = await searchParams;
  const banner =
    query.started === "1"
      ? campaignsCopy.toastStarted
      : query.again === "1"
        ? campaignsCopy.toastLookingAgain
        : query.confirmed === "1"
          ? campaignsCopy.toastFinding
          : query.revealing === "1"
            ? campaignsCopy.toastRevealing
            : query.writing === "1"
              ? campaignsCopy.toastWriting
              : query.more === "1"
                ? findMoreCopy.toastFinding
                : null;

  const running = campaign.live && (campaign.outreach?.batches.length ?? 0) > 0;
  const people = running ? await peopleView(campaign.id, query) : undefined;

  return (
    <CampaignPage
      // The page holds the state it draws; a new version or state is a new page.
      key={`${campaign.briefVersion}:${campaign.state}`}
      campaign={campaign}
      banner={banner}
      onWiden={widenResearch}
      onRetry={retryResearch}
      onConfirm={confirmPlan}
      onCreatePlays={createPlayCampaigns}
      onRetryPeople={retryPeople}
      onChooseIndustry={chooseIndustry}
      onReview={reviewPeople}
      onReveal={revealEmails}
      onRetryReveal={retryRevealEmails}
      onWriteEmails={writeEmails}
      onStartOutreach={startOutreach}
      onPauseOutreach={pauseOutreach}
      onFindMore={findMorePeople}
      {...(people === undefined ? {} : { people })}
    />
  );
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The People tab, when it is the view open: the rep's people on this campaign and whoever `?person=` names. */
async function peopleView(campaignId: string, query: Record<string, string | string[] | undefined>) {
  if (first(query.tab) !== "people") return { active: false, content: null };
  const caller = await serverCaller();
  const list = await caller.tracking.campaignPeopleTracking({ campaignId });
  const personId = first(query.person);
  let person: PersonView | null = null;
  if (personId !== undefined && personId !== "") {
    try {
      person = await caller.tracking.personTracking({ personId: personId.slice(0, 100) });
      // A person on another of the rep's campaigns is not this tab's.
      if (person.campaignId !== campaignId) person = null;
    } catch (error) {
      if (!(error instanceof TRPCError && (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST"))) throw error;
    }
  }
  return {
    active: true,
    content: (
      <PeopleTab
        key="people"
        campaignId={campaignId}
        today={londonDay(new Date())}
        paused={list.paused}
        rows={list.rows}
        filter={parsePeopleFilter(query)}
        person={person}
        personMissing={personId !== undefined && personId !== "" && person === null}
        actions={{
          markStep: markStepAction,
          undo: undoAction,
          addNote: addNoteAction,
          setOutcome: setOutcomeAction,
          meetingBooked: meetingBookedAction,
          setPhone: setPhoneAction,
          approveDraft: approveDraftAction,
          rejectDraft: rejectDraftAction,
          tryAgain: tryAgainAction,
        }}
      />
    ),
  };
}
