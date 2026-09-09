"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { campaignsCopy } from "@/lib/copy/campaigns";
import type { AskAnswer } from "@/lib/campaigns/state";
import { cn } from "@/lib/utils";

/**
 * Ask Relay: six chips, no free text (§23.1c, orchestrator §8 and §12.1).
 *
 * No text box, and that is the feature. The six questions are the ones Relay
 * can answer from what it holds; a box would invite a seventh and answer it
 * with a guess. Every answer arrives already assembled from the campaign's own
 * counts, so this component chooses nothing and computes nothing.
 */
export function AskRelay({ questions }: { questions: AskAnswer[] }) {
  const [asked, setAsked] = useState<string | null>(null);
  const answer = questions.find((question) => question.id === asked);

  return (
    <Card label={campaignsCopy.askLabel}>
      <p className="type-small mb-2.5 text-muted">{campaignsCopy.askHint}</p>
      <div className="flex flex-wrap gap-chips">
        {questions.map((question) => (
          <button
            key={question.id}
            type="button"
            data-testid="ask-chip"
            aria-pressed={asked === question.id}
            onClick={() => setAsked(asked === question.id ? null : question.id)}
            className={cn(
              "rounded-pill border px-3 py-1 text-13",
              "transition-colors duration-micro ease-standard",
              "focus-visible:outline-none focus-visible:ring-2",
              asked === question.id
                ? "border-transparent bg-soft text-action"
                : "border-line bg-ground text-muted hover:text-ink",
            )}
          >
            {question.question}
          </button>
        ))}
      </div>

      {answer === undefined ? null : (
        <p data-testid="ask-answer" className="type-body mt-3 rounded-input bg-soft px-3 py-2.5">
          {answer.answer}
        </p>
      )}
    </Card>
  );
}
