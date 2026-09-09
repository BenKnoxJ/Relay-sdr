# The agent bench

No agent is enabled until its output has been run locally, checked against its
rubric, and seen on the real screen. The bench is that surface: one command that
runs a signed definition and writes down what came back, and one development-only
page that renders what it wrote in the components a rep would meet it in.

## The command

    npm run agent -- <kind> --brief fixtures/briefs/<name>.md [--name <slug>]
                     [--live --yes] [--out <path>]

It loads `agents/<kind>/`, reads the input out of the brief, runs the real
`runAgent` — the same loop the worker calls, recording the same steps into
`agent_runs` and `agent_run_steps` — validates the answer against the
definition's own output schema, and writes `fixtures/agents/<kind>/<name>.json`.
It exits 1 when the answer does not validate, and the fixture it leaves says
what was wrong and what the attempt cost.

Two modes:

* **recorded** (the default) replays a scripted provider from
  `fixtures/recorded/<kind>/<name>.json`. Nothing leaves the machine, nothing is
  spent, and the same run happens every time — which is what lets CI run it.
  Refused unless `NODE_ENV` is explicitly `development` or `test`.
* **`--live`** reaches the real Messages API on whichever credential the
  environment holds (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`). It
  prints a ceiling for what the run could cost and then refuses to start without
  `--yes`.

Runs are recorded under an org called `bench`, created on first use. Nothing
else in the application database is touched.

A brief is a markdown file a person can read; the agent's input is the first
fenced ```json block in it. JSON rather than YAML front matter because these
inputs are deeply nested — research's is a brief, a facts file and a breadth —
and hand-parsing YAML into a strict schema is a correctness hazard for no gain.

## The page

`/bench` lists every checked-in fixture; `/bench/<kind>/<name>` renders one, with
what it cost above it and its rubric below. The rubric is parsed out of
`agents/<kind>/rubric.md`, so the checklist is the rubric rather than a second
copy of it. The two checks the bench can settle itself — the output is the shape
the definition asks for, and something really ran and cost something — are shown
apart from the rest, which are a person looking at the screen. Those ticks are
kept in `localStorage` and go nowhere.

The bench does not exist in production, for two independent reasons:

1. Its pages are named `page.dev.tsx`, and `pageExtensions` in
   `next.config.mjs` only counts that suffix when `NODE_ENV` is `development`.
   A production build therefore has no `/bench` route at all.
2. `benchEnabled()` (`src/lib/bench/devOnly.ts`) refuses anything but an
   explicit `development`, which covers a build made in development and served.

Sign-in is a third gate: `src/middleware.ts` protects every page by default.

## Fixtures

`fixtures/agents/<kind>/<name>.json` — one output, with its input, what the run
cost, and the validation result. Two sources:

* `run` — produced by the command. Carries a `run` block.
* `sample` — a checked-in output with no run behind it, for the four definitions
  that are not runnable yet. `run` is `null` and the page says so, so a sample
  can never be mistaken for evidence that an agent works.

`tests/bench/fixtures.test.ts` re-validates every one of them against its
definition's schema on every run, so a schema change breaks the fixtures rather
than leaving the bench rendering something the agent can no longer produce.
