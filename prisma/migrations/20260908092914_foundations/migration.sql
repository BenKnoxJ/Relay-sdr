-- CreateEnum
CREATE TYPE "role" AS ENUM ('rep', 'admin');

-- CreateEnum
CREATE TYPE "provider" AS ENUM ('graph', 'zoho', 'linkedin', 'lusha');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('healthy', 'expiring', 'revoked', 'paused');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('user', 'system');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "agent_run_status" AS ENUM ('running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "agent_run_step_kind" AS ENUM ('model', 'tool');

-- CreateTable
CREATE TABLE "orgs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "clerk_id" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "role" NOT NULL DEFAULT 'rep',
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_accounts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "provider" NOT NULL,
    "enc_tokens" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "account_status" NOT NULL DEFAULT 'healthy',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "poll_cursor" TEXT,
    "daily_cap" INTEGER NOT NULL DEFAULT 10,
    "window_start" TEXT NOT NULL DEFAULT '09:00',
    "window_end" TEXT NOT NULL DEFAULT '16:30',
    "days" TEXT[] DEFAULT ARRAY['mon', 'tue', 'wed', 'thu']::TEXT[],
    "ramp_start" INTEGER NOT NULL DEFAULT 5,
    "paused_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "provider" NOT NULL,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_kind" "actor_kind" NOT NULL,
    "actor_user_id" TEXT,
    "kind" TEXT NOT NULL,
    "campaign_id" TEXT,
    "person_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "worker_id" TEXT,
    "input" JSONB NOT NULL,
    "response_digest" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "agent_run_status" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "cost_total" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_steps" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" "agent_run_step_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "tokens_cached" INTEGER NOT NULL DEFAULT 0,
    "tokens_reasoning" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "tool_key" TEXT,
    "input" JSONB,
    "output" JSONB,
    "provider_meta" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_facts_versions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_facts_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "side_effects" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "side_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE INDEX "users_org_id_idx" ON "users"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_org_id_email_key" ON "users"("org_id", "email");

-- CreateIndex
CREATE INDEX "connected_accounts_org_id_provider_idx" ON "connected_accounts"("org_id", "provider");

-- CreateIndex
CREATE INDEX "connected_accounts_status_expires_at_idx" ON "connected_accounts"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_user_id_provider_key" ON "connected_accounts"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "oauth_states_org_id_user_id_idx" ON "oauth_states"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "events_org_id_at_idx" ON "events"("org_id", "at");

-- CreateIndex
CREATE INDEX "events_kind_at_idx" ON "events"("kind", "at");

-- CreateIndex
CREATE INDEX "events_campaign_id_at_idx" ON "events"("campaign_id", "at");

-- CreateIndex
CREATE INDEX "events_person_id_at_idx" ON "events"("person_id", "at");

-- CreateIndex
CREATE INDEX "jobs_status_next_at_priority_idx" ON "jobs"("status", "next_at", "priority");

-- CreateIndex
CREATE INDEX "jobs_lease_until_idx" ON "jobs"("lease_until");

-- CreateIndex
CREATE INDEX "jobs_org_id_created_at_idx" ON "jobs"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_org_id_idempotency_key_key" ON "jobs"("org_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "agent_runs_org_id_started_at_idx" ON "agent_runs"("org_id", "started_at");

-- CreateIndex
CREATE INDEX "agent_runs_job_id_idx" ON "agent_runs"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_steps_tool_key_key" ON "agent_run_steps"("tool_key");

-- CreateIndex
CREATE INDEX "agent_run_steps_org_id_started_at_idx" ON "agent_run_steps"("org_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_steps_run_id_index_key" ON "agent_run_steps"("run_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_steps_org_id_tool_key_key" ON "agent_run_steps"("org_id", "tool_key");

-- CreateIndex
CREATE INDEX "product_facts_versions_org_id_activated_at_idx" ON "product_facts_versions"("org_id", "activated_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_facts_versions_org_id_product_version_key" ON "product_facts_versions"("org_id", "product", "version");

-- CreateIndex
CREATE INDEX "side_effects_org_id_at_idx" ON "side_effects"("org_id", "at");

-- CreateIndex
CREATE INDEX "side_effects_job_id_idx" ON "side_effects"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "side_effects_org_id_key_key" ON "side_effects"("org_id", "key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_facts_versions" ADD CONSTRAINT "product_facts_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
