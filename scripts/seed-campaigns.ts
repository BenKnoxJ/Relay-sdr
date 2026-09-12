/**
 * Development only: one real campaign in each state a campaign can reach
 * today, for looking at the screens and shooting them, without running
 * research.
 *
 *   DATABASE_URL=postgresql://…/relay_pa_dev \
 *     npx tsx scripts/seed-campaigns.ts --email rep@example.test [--with-mailbox] [--out ids.json]
 *
 * Each campaign is started through the real write path (`createCampaign`:
 * the campaign, its Event and its research job in one transaction). Research
 * is then settled the way the research handler settles it, from the signed
 * contract data the tests use (`tests/lib/campaignPacks.ts`):
 *
 *   researching  the job left queued (no worker runs here)
 *   complete     `research.completed` with the complete test pack
 *   partial      `research.completed` with the signed brief B v3.2 pack
 *   stopped      `research.completed` with the signed brief C v3.2 stop
 *   failed       the job failed `took_too_long`
 *
 * `--with-mailbox` also gives the rep a placeholder mailbox row, so Start's
 * button is enabled on this database. It holds no token and connects nothing.
 *
 * Refuses to run in production, or against a database whose name does not
 * end in `_dev` or `_test`. The rep must exist: load the app once with
 * `DEV_USER_EMAIL` set to that address first.
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { PackShape } from "../agents/research/output.schema";
import { nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { prisma } from "@/lib/db";
import { createCampaign } from "@/lib/repo/campaigns";
import { recordResearchCompleted } from "@/lib/repo/research";

import { briefFields, completePack, partialBrief, partialPack, stoppedBrief, stoppedPack } from "../tests/lib/campaignPacks";

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function refuseUnlessDevelopment(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let name = "";
  try {
    name = new URL(raw).pathname.replace(/^\//, "");
  } catch {
    // reported below
  }
  if (process.env.NODE_ENV === "production" || !/_(dev|test)$/.test(name)) {
    console.error(`seed-campaigns: refusing to seed database ${JSON.stringify(name)}: development and test databases only (name ending _dev or _test).`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  refuseUnlessDevelopment();
  const email = argument("email");
  if (email === undefined) {
    console.error("seed-campaigns: --email <the rep's address> is required");
    process.exit(2);
  }
  const user = await prisma.user.findFirst({ where: { email } });
  if (user === null) {
    console.error(`seed-campaigns: no user ${email}. Load the app once with DEV_USER_EMAIL=${email} first.`);
    process.exit(2);
  }
  const owner = { orgId: user.orgId, userId: user.id };

  if (process.argv.includes("--with-mailbox")) {
    const existing = await prisma.connectedAccount.findFirst({ where: { userId: user.id, provider: "graph" } });
    if (existing === null) {
      await prisma.connectedAccount.create({
        data: { orgId: user.orgId, userId: user.id, provider: "graph", encTokens: "seed:no-token", scopes: [] },
      });
    }
  }

  const start = async (brief: ResearchBrief) => {
    const { campaign, job } = await createCampaign(prisma, {
      ...owner,
      startRequestId: randomUUID(),
      name: nameFrom(brief.who),
      brief,
    });
    if (job === null) throw new Error("seed-campaigns: a fresh start made no research job");
    return { id: campaign.id, job };
  };

  const settle = async (job: { id: string; orgId: string }, pack: PackShape, outcome: "complete" | "partial" | "insufficient") => {
    await recordResearchCompleted(prisma, {
      orgId: job.orgId,
      jobId: job.id,
      runId: "seed",
      pack: JSON.parse(JSON.stringify(pack)),
      report: { seeded: true },
      facts: { product: "insights360", version: 2, hash: "seed", draft: false },
      knowledge: { product: "insights360", version: 1, hash: "seed" },
      partial: pack.partial,
      missingModules: [...pack.missingModules],
      outcome,
      scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  };

  // Oldest first, so the list (newest first) reads researching at the top.
  const failed = await start(toResearchBrief(briefFields({ who: "Heads of operations at UK housing associations with a repairs line" })));
  await prisma.job.update({
    where: { id: failed.job.id },
    data: { status: "failed", error: "research: took_too_long — seeded: a rail was reached before any module was written" },
  });

  const stopped = await start(stoppedBrief() as ResearchBrief);
  await settle(stopped.job, stoppedPack(), "insufficient");

  const partial = await start(partialBrief() as ResearchBrief);
  await settle(partial.job, partialPack(), "partial");

  const complete = await start(
    toResearchBrief(
      briefFields({
        who: "Claims operations leads at mid-sized UK insurers, MGAs and claims handlers",
        howMany: 20,
        channels: ["email", "linkedin"],
        scope: { extraCountries: [], places: [], orgTypes: ["general insurer", "managing general agent"], size: { unit: "employees", min: 50, max: 2000 }, rolesInclude: ["claims operations lead"], rolesExclude: ["claims handler"] },
      }),
    ),
  );
  await settle(complete.job, completePack(), "complete");

  const researching = await start(toResearchBrief(briefFields({ who: "Transport managers at Midlands fleet operators", channels: ["email", "calls"] })));

  const ids = { researching: researching.id, complete: complete.id, partial: partial.id, stopped: stopped.id, failed: failed.id };
  const out = argument("out");
  if (out === undefined) console.log(JSON.stringify(ids, null, 2));
  else writeFileSync(out, `${JSON.stringify(ids, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
