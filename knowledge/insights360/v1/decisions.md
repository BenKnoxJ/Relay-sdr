---
last_verified: 2026-07-03
sources: (internal path)
---
# Insights360 — Decisions

Product-specific locked decisions. One-liner per decision, dated. Cross-cutting decisions go to `(internal path)`.

- **2026-06-23** — **The v3.1 integration pivot (LOCKED).** Insights360 is the platform we grow: each module (Risk, QA, deeper Insights, Teams+CRM) is built into the existing app on its existing stack (GitHub + Vercel/Next.js App Router + Clerk + Neon + AWS batch pipeline), replacing the greenfield "Realtime AI App" plan; real-time becomes the capstone, built last. Source: Master Product Document v3.1 (see `sources`), summarised in `(internal path)`.
- **2026-06-23** — **Design law: post-call-native, real-time-ready (§21.2).** Module-phase schema/event decisions must leave the capstone seams (ASR provider interface, event spine, channel-attribution field, live-capable call lifecycle).

*This catalogue is new (started 2026-07-03) and not exhaustive — earlier Insights360 decisions (stack choices, pipeline design) predate it and have not been back-filled. Check `RECENT.md`, the master doc's decision log (§35), and the repo before assuming absence.*
