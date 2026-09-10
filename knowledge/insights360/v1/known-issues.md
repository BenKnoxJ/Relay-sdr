---
last_verified: 2026-06-03
---
# Insights360 — Known Issues

Living document. Updated by agents as issues are discovered, fixed, or verified. New issues append to **Open**; resolved issues move to **Recently fixed** with a strikethrough and a PR link.

## Open

*None catalogued yet. New issues land here.*

## Recently fixed

### 2026-06-11 — Go-live hardening Tier 1: agents roster + tenant-aware threshold — PR [#67](https://github.com/Conversant-Technologies-Ltd/insights360/pull/67)

Tier 1 of the NPTC go-live hardening slice ([SPRNT-223](https://conversanttechnology.atlassian.net/browse/SPRNT-223)), draft PR open.

- ~~Agents list derived only from Call records — an agent with no calls in the selected period disappeared entirely; name variants ("Jane Smith" / "jane smith") produced duplicate cards~~ — **FIXED**. New `/api/roster` (Clerk members with DDI/extension) outer-merged with the leaderboard (email-first, normalized-name fallback); zero-call members render "0 calls", leaderboard grouping is case-insensitive, unmatched call-only names carry a "Not matched to roster" tag, and roster members with a quiet period get a "No calls in this period" agent page instead of "Agent not found".
- ~~Agents sorting non-deterministic on ties; no bottom-performers view; nameAsc crashed on null names~~ — **FIXED**. Deterministic tie-breakers (score → volume → name) mirrored server/client, "Lowest QA Score" sort added, zero-call agents always sort last.
- ~~Client-side grade bands tenant-unaware (badge fixed at 90/80/70/60 while filters derived from the tenant threshold — badge ⇄ filter disagreed off-default); "needs review"/attention floors and copy hardcoded 60/70~~ — **FIXED**. `bandsForThreshold()` in `lib/grade-bands.ts` is the single band-geometry source (server `deriveGradeRanges` wraps it); `/api/calls` + `/api/risks` expose `pass_threshold`; QA/Calls/Risks/Dashboard/Agent/Call-detail grade score-first against tenant bands.
- ~~Pass threshold display-only in Settings — changing it required an engineer hand-editing S3~~ — **FIXED**. Settings → QA Rules gains a Scoring settings modal (overall / default-rule / critical-rule thresholds); overall capped at 80 so the A band stays reachable.

Deferred to follow-ups: per-tenant TTL cache for the qa-config S3 read, `pass_threshold` on the single-call API (call-detail currently fetches config separately), help pages still describing default bands (WI-7 sweep), zero-call roster members hidden under a queue filter (no queue data on roster records).

### 2026-06-03 — Settings save UX: silent resync + advisory QA weight sum — PR [#63](https://github.com/Conversant-Technologies-Ltd/insights360/pull/63)

Post-Wave-0 follow-up reported by the product owner during testing. Task [SPRNT-215](https://conversanttechnology.atlassian.net/browse/SPRNT-215) under epic [SPRNT-141](https://conversanttechnology.atlassian.net/browse/SPRNT-141).

- ~~Every Settings save (QA rule, category, risk type, AI output) flashed a full-page reload and the edit looked reverted~~ — **FIXED**. `loadSettings()` set `loading=true` on every call, so the post-save `onSaved()` refetch tripped the full-page `<LoadingSpinner/>` and remounted the active tab — resetting its local state and the in-place echo-guards. A `silent` resync path now reloads without the spinner; the tab stays mounted and folds in the server value in place. **This is the systemic root cause** behind the per-surface "doesn't stick" symptoms patched individually before — AI Output (P0-13/14, PR #62) and Classification remove (PR #34): the writes always persisted; the remount made them look lost.
- ~~QA config save was hard-rejected unless enabled rule weights summed to exactly 100%, and the rule editor's Save button was disabled on any other total — impossible to add a rule (>100%) or lower a weight to make room (<100%) one edit at a time~~ — **FIXED**. The scoring engine (`cci-lite-analyser`) normalises by total weight (`overall_score = Σ(score·weight) / Σ(weight)`), so weights are relative and any positive sum scores correctly. The 100% target is now advisory on both the server validator (`config-defaults.ts validateQAConfig`) and the client `canSave` gate; the amber "doesn't add up to 100%" heads-up stays. The hard guard came in with the SPRNT-192 weights-banner / write-hardening work and over-reached past what scoring requires.

### 2026-06-02 — Wave 0: Emergency Credibility (17 P0s) — PR [#62](https://github.com/Conversant-Technologies-Ltd/insights360/pull/62)

First wave of the v2 master roadmap — a hotfix sweep of the 17 P0 findings from the 2026-06-01 production audit. Task [SPRNT-212](https://conversanttechnology.atlassian.net/browse/SPRNT-212) under epic [SPRNT-141](https://conversanttechnology.atlassian.net/browse/SPRNT-141).

- ~~Pass-rate KPIs (Dashboard/QA/Agents/Agent) computed against a hardcoded `PASS_THRESHOLD=70`, wrong for any tenant on a different threshold~~ — **FIXED**. stats + agent-stats read the tenant's `overall_pass_threshold` via a shared `getOverallPassThreshold()` helper. (P0-21, P0-22)
- ~~Agent "passed calls" count derived from total calls while pass rate is over scored calls only — overstated when unscored calls exist~~ — **FIXED** (uses scored-call count). (P0-03)
- ~~Dashboard "Total Calls" progress bar used a hardcoded `/100` denominator (full for any tenant ≥100 calls)~~ — **FIXED** (bar removed; an absolute count has no denominator). (P0-01)
- ~~Agent "Talk Ratio" showed a fake "✓ Balanced" 50/50 split when no talk-ratio data existed~~ — **FIXED** (no-data state). (P0-04)
- ~~AI Output language selector appeared not to persist / snapped back on reload~~ — **FIXED**. `AIOutputTab` now resyncs to the server value after save/reload and clears the stuck "saving" indicator on `ETAG_MISMATCH`. Write path was already correct (`response_language` allow-listed); the defect was client display. (P0-13, P0-14)
- ~~QA rules could only be disabled by deleting them — edit modal had no Enabled toggle~~ — **FIXED**. (P0-10)
- ~~A failed category/risk-type usage fetch silently suppressed all delete warnings (every item looked unused)~~ — **FIXED** (deletes warn when usage is unknown). (P0-12)
- ~~Team-member "Permanent Deletion" warning claimed it deleted the account + all data; the action only removes org membership~~ — **FIXED** (reworded). (P0-15)
- ~~Help docs: critical-rule threshold documented as 90 (actual 80); false claims that critical rules are surfaced on call detail/dashboard, that calls can be re-processed, and that the agent page compares periods~~ — **FIXED**. (P0-11/16, P0-17, P0-18, P0-19)
- ~~"Update password" signed the user out and redirected to /forgot-password (a live customer lost their session)~~ — **FIXED** (in-app Clerk change-password form; session preserved). See SEC-014. (P0-20)
- ~~Dashboard sidebar + content rendered outside the `<SignedIn>` guard — half-auth shell on first paint~~ — **FIXED** (whole shell behind the guard + `RedirectToSignIn`). See SEC-013.
- ~~Dead "Export" button on Calls Explorer (no handler, no route)~~ — **REMOVED**; real CSV export tracked as [SPRNT-213](https://conversanttechnology.atlassian.net/browse/SPRNT-213). (P0-02)

**Not a bug (audit false positive):** "sentimentScore double-scales in `mapV1Call.js`" — the formula reduces to `50 + 50·posFrac − 50·negFrac` (correct 0–100), the dashboard trend reads DB 0..1 values (not this field), and the field only feeds an unimported helper. Left unchanged. **Follow-ups (Wave 1):** real CSV export (SPRNT-213); reconcile the S3 read-path sentiment scale (0–100) vs the DB path (0..1); read remaining hardcoded "70%" tooltip/UI defaults from `DEFAULT_QA_CONFIG`.

### 2026-05-18 — Settings write-path hardening + Classification UX fixes — PRs [#33](https://github.com/Conversant-Technologies-Ltd/insights360/pull/33), [#34](https://github.com/Conversant-Technologies-Ltd/insights360/pull/34)

Polish pass on the SPRNT-156 self-serve work. No Jira ticket — direct follow-up to PR #30.

- ~~Settings → Classification "Remove" appeared to succeed but a page refresh brought the row back~~ — **FIXED** in PR #34. The delete handlers called `scheduleSave(true)` synchronously in the same event handler as `setCategories`, so `flushSave` read `latestRef.current` *before* React committed the new state and the `[categories, riskTypes]` effect that mirrors state → ref had a chance to run. The unchanged list was persisted to S3. Delete handlers now sync `latestRef.current` manually before scheduling the save.
- ~~Settings PUT endpoints silently substituted `DEFAULT_*_CONFIG` on `AccessDenied` (or any non-`NoSuchKey` S3 error) and then merged the UI's payload over those defaults — a one-shot data-loss path that would destroy `model_settings`, `risk_severities`, `schema_version`, and `config_version` on a single transient IAM blip~~ — **FIXED** in PR #33. `/api/settings/ai-config` and `/api/settings/qa-config` PUTs now read S3 directly; only `NoSuchKey` is treated as "first save"; every other read error returns `503 Config read failed` *before* any write. GET handlers still use the defaults-substituting helpers (display-path tolerance during onboarding is fine).
- ~~UI sent the full config blob on every save, risking clobber of any server-managed field that drifted out of the React state~~ — **FIXED** in PR #33. Both endpoints declare an allowlist of UI-mutable keys (`call_reason_categories`, `risk_types` for ai-config; `rule_categories`, `qa_rules` for qa-config); the UI sends only those keys and the backend merges them over the S3 before-state.
- ~~`scoring_settings` was in the qa-config allowlist but is a nested object — the shallow merge would have atomically wiped siblings on any partial patch~~ — **REMOVED** from the allowlist in PR #33. No writers exist today; re-add only when a writer posts the full object or the merge loop learns to deep-merge specific keys.
- ~~`flushSave` aborted silently (`status` → `idle`, no toast) when an abandoned empty-label row was in state — clicks on "Remove" against a real row silently no-op'd~~ — **FIXED** in PR #33. Empty draft rows are now auto-purged before save; a missing `other` category surfaces an explicit toast and an error status.
- ~~CategoriesTab's `useState` initialiser only ran at mount, so refetched config from the parent never landed in local state~~ — **FIXED** in PR #33. A `useEffect([config])` with diff-before-overwrite semantics was added. A `justSavedRef` snapshot recognises post-save refetches as our own echo and skips reconciliation, eliminating the keystroke-clobber race where typing-ahead during a save would be reverted to the just-saved snapshot.
- ~~Settings PUT endpoints accepted any payload, returning 200 + writing on malformed bodies (arrays, primitives, bad JSON)~~ — **FIXED** in PR #33. Body shape guard now rejects with `400` before any S3 work.

Cross-cutting: the implementation plan for this work is committed at `docs/superpowers/plans/2026-05-18-settings-write-hardening-bugfixes.md`. Known follow-ups not in these PRs: debounce-flush-on-unmount loses the last edit when navigating away mid-typing; TOCTOU on read-modify-write (deferred to Theme 6 Postgres audit log); GET/PUT helper asymmetry on the ai-config / qa-config routes is intentional but undocumented in code.

### 2026-05-14 — Settings self-serve MVP (Theme 2, Sprint 2 quick wins) — PR [#30](https://github.com/Conversant-Technologies-Ltd/insights360/pull/30)

Four "contact support" walls in Settings are now self-serve for admins. Parent ticket [SPRNT-156](https://conversanttechnology.atlassian.net/browse/SPRNT-156), under epic [SPRNT-141](https://conversanttechnology.atlassian.net/browse/SPRNT-141).

- ~~Org name + timezone read-only with "Contact support to request changes"~~ — **FIXED** (editable form wired to existing `PUT /api/settings/organization`, dirty-state save bar) ([SPRNT-158](https://conversanttechnology.atlassian.net/browse/SPRNT-158))
- ~~Call Categories read-only with "Contact support" notice~~ — **FIXED** (full add/edit/delete with auto-slug, delete-warning showing affected call count via new `/api/settings/categories/usage`, `other` fallback protected) ([SPRNT-159](https://conversanttechnology.atlassian.net/browse/SPRNT-159))
- ~~Risk Types read-only with "Contact support" notice~~ — **FIXED** (same shape as Categories; usage counts from `risks` JSONB via new `/api/settings/risk-types/usage`) ([SPRNT-160](https://conversanttechnology.atlassian.net/browse/SPRNT-160))
- ~~Supervisor role unreachable — API accepted it, invite-modal dropdown only listed Viewer + Admin~~ — **FIXED** (Supervisor option added between Viewer and Admin) ([SPRNT-157](https://conversanttechnology.atlassian.net/browse/SPRNT-157))

Cross-cutting: new `lib/audit-log.ts` appends `{timestamp, userId, action, resource, before, after}` JSONL lines to `{tenantId}/audit-log/{YYYY-MM}.jsonl` in `CONFIG_BUCKET` on every Settings PUT (org / ai-config / qa-config). Best-effort — S3 failures never block the save. Stopgap until Theme 6 ships a Postgres `audit_log` table. ([SPRNT-161](https://conversanttechnology.atlassian.net/browse/SPRNT-161))

Sprint 3 follow-up: QA Rules inline editor + sandbox + grade-boundary editor + versioning is the next Theme 2 piece, not yet ticketed.



### 2026-05-13 — Credibility calculation bugs (Sprint 1 §1) — PR [#13](https://github.com/Conversant-Technologies-Ltd/insights360/pull/13)

All eight bugs from the May 2026 product audit `§1 Critical calculation bugs` are resolved on `feature/SPRNT-129-credibility-calc-bugs`. Parent ticket [SPRNT-129](https://conversanttechnology.atlassian.net/browse/SPRNT-129).

- ~~High-risk progress bar multiplied by 5× for no documented reason — 2 of 100 displayed as 10%~~ — **FIXED** ([SPRNT-130](https://conversanttechnology.atlassian.net/browse/SPRNT-130))
- ~~Pass rate unweighted by call duration — voicemails count the same as 30-minute calls~~ — **FIXED** (duration-weighted variant now exposed alongside the unweighted gauge) ([SPRNT-131](https://conversanttechnology.atlassian.net/browse/SPRNT-131))
- ~~Sample-size blindness on agent leaderboard — 3-call agent at 99 outranks 300-call agent at 94~~ — **FIXED** (min-5-calls filter + Bayesian shrinkage to league mean) ([SPRNT-132](https://conversanttechnology.atlassian.net/browse/SPRNT-132)). **⚠️ SUPERSEDED 2026-05-13 by commit `93e7ae3` (deliberate UX reversal):** the `MIN_LEADERBOARD_CALLS` filter and Bayesian shrinkage were intentionally removed so the /agents leaderboard shows *every* agent ranked by raw `avg_score`, with `call_count` shown beside each for the reader to judge confidence. The Dashboard "Top Performers" widget keeps `MIN_CALLS=10`. **This is the current intended behaviour — do NOT re-add leaderboard shrinkage/min-call guards.** (Re-flagged as a "regression" in the 2026-06-23 NPTC go-live audit and dismissed.)
- ~~Trend % shows "—" instead of "Baseline" on first period; +100% on n=3 vs n=6 treated as real signal~~ — **FIXED** (Baseline + Low-n labels via `*_trend_status` fields) ([SPRNT-133](https://conversanttechnology.atlassian.net/browse/SPRNT-133))
- ~~Sentiment normalisation fragile: ×100 server-side then re-normalised in frontend~~ — **FIXED** (canonical 0..1 wire format throughout) ([SPRNT-134](https://conversanttechnology.atlassian.net/browse/SPRNT-134))
- ~~Grade boundaries hardcoded (A 90+, B 80+...) but pass threshold is configurable per tenant — grades don't follow~~ — **FIXED** (`deriveGradeRanges(passThreshold)` shared helper) ([SPRNT-135](https://conversanttechnology.atlassian.net/browse/SPRNT-135))
- ~~Compliance rate uses hardcoded rule names ('Verification', 'Data Protection'...); custom rules ignored~~ — **FIXED** (read `is_compliance` flag from qa-config, with `category === 'compliance'` fallback) ([SPRNT-136](https://conversanttechnology.atlassian.net/browse/SPRNT-136))
- ~~Rule pass-rate top-5 ignores rule weight — a 0.20-weight critical rule ranks equal with a 0.05 soft-skill rule~~ — **FIXED** (sort by weight desc, then pass-rate asc; weight exposed on each entry) ([SPRNT-137](https://conversanttechnology.atlassian.net/browse/SPRNT-137))

Cross-cutting cleanup: per-tenant qa-config S3 reader extracted into `lib/qa-config.ts`; `/api/settings/qa-config` and `/api/stats` now share it.

### 2026-07-17 — Wave 2: applicability gate + nine deterministic analyser fixes — PRs [#147](https://github.com/Conversant-Technologies-Ltd/insights360/pull/147), [#148](https://github.com/Conversant-Technologies-Ltd/insights360/pull/148) — **MERGED & DEPLOYED 2026-07-17, production-verified**

The customer-reported defect — non-conversations (voicemail, IVR, gatekeeper screens) scored as real calls and counted in QA averages (~20% of one customer's outbound volume; boolean applicability ~78–80% vs a ≥95% gate) — is addressed on two stacked branches under [SPRNT-425](https://conversanttechnology.atlassian.net/browse/SPRNT-425). PR #147 ([SPRNT-427](https://conversanttechnology.atlassian.net/browse/SPRNT-427)): nine deterministic fixes (enum drop+log, zero-weight not-scoreable shape, normalised rule matching incl. typographic apostrophes/`&`, collapse logging, risk `other` guarantee, one 70 pass-threshold default, truncation flag, scoring-settings dump removal, botocore retry budget). PR #148 ([SPRNT-428](https://conversanttechnology.atlassian.net/browse/SPRNT-428)): direction-aware applicability gate runs FIRST on outbound; non-applicable calls write an honest skip-record and skip the ~4k-token generation (~25–30% of outbound); Call-2 variant drops the applicability section and moves sentiment last; inbound/internal byte-for-byte unchanged; empty transcripts honestly non-applicable; `exclude_internal` opt-out wired (default OFF). Merge gated on: ≥95% boolean applicability (3-run judged vs the fresh direction-rubric re-baseline: 78.7% mean, noise ±1–2 calls), hanssens prompt-diff neutrality, token saving confirmed. Not merged, not deployed — historical labels unchanged pending the P-4 backfill decision.
