# Echo — pass rubric

Echo's rubric is the runtime's, not a quality bar. It is spike proof 1 (§24)
with the provider replaced by a mock, plus the live half.

| # | Check | Pass |
|---|---|---|
| 1 | Steps recorded | a run with two tool calls has five steps: three `model` and two `tool`, indexed in the order they happened, each model step before the tool call it asked for |
| 2 | Tokens | every step's `tokensIn`, `tokensOut`, `tokensCached` and `tokensReasoning` equal the response `usage` fields exactly |
| 3 | Cost | every step's `cost` equals its tokens times the pinned price table; `AgentRun.costTotal` equals the sum of the steps, to the last of the column's six decimal places |
| 4 | Provider metadata | raw `providerMetadata` and the normalised usage are stored on every model step |
| 5 | Replay | a second run with the same inputs, against steps left by the first, executes the tool body zero times and creates no new tool step |
| 6 | Cap | `maxModelSteps: 1` against a model that keeps calling tools ends `failed(cap)` and accepts no partial answer |
| 7 | Abort | a signal aborted mid-run ends `failed(aborted)` with the run row closed |
| 8 | End to end | an `echo` job runs under the worker's own loop, reaches `done`, and leaves one run with at least three steps and a cost above zero |
| 9 | Live | `scripts/spike/cost-check.ts` on `claude-opus-5` prints recorded tokens against the response's own usage with zero mismatches, and cost within $0.0001 |

Rows 1 to 8 are `tests/agents/`. Row 9 needs a credential and is the only
manual step.
