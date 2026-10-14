import type { NextCachePreset } from "../adapters/types.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { ClientFactory } from "../clients/factory.ts";
import { UserInputError } from "../errors.ts";
import { missingInputs, skipEntries, type EnvValues } from "../translate/env-plan.ts";
import type { JobEvents } from "./events.ts";
import type { JobStore } from "./job-store.ts";
import { buildPlan as defaultBuildPlan, type MigrationPlan } from "./plan.ts";
import type { JobQueue } from "./queue.ts";
import { resetForRetry } from "./runner.ts";
import type { Job, JobEvent } from "./types.ts";

export interface StartInput {
  projectId: string;
  workerName: string;
  nextCache: NextCachePreset;
  values: Record<string, string>;
  skip: string[];
}

export interface JobService {
  plan(projectId: string): Promise<MigrationPlan>;
  start(input: StartInput): Promise<Job>;
  list(): Promise<Job[]>;
  get(id: string): Promise<Job | null>;
  retry(id: string): Promise<Job>;
  log(id: string): Promise<string>;
  subscribe(id: string, fn: (e: JobEvent) => void): () => void;
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createJobService(d: {
  store: JobStore;
  events: JobEvents;
  queue: JobQueue;
  clients: ClientFactory;
  credentials: CredentialStore;
  buildPlan?: typeof defaultBuildPlan;
}): JobService {
  const buildPlan = d.buildPlan ?? defaultBuildPlan;
  // Plans waiting for approval, with their fetched values, held in memory only.
  const drafts = new Map<string, { plan: MigrationPlan; values: EnvValues; accountId: string }>();

  async function accountId(): Promise<string> {
    const id = (await d.credentials.read()).cloudflare?.accountId;
    if (!id) throw new UserInputError("Choose a Cloudflare account on the Connect page first.");
    return id;
  }

  return {
    async plan(projectId) {
      const account = await accountId();
      const { plan, values } = await buildPlan(
        { vercel: await d.clients.vercel(), github: await d.clients.github(), cloudflare: d.clients.cloudflare, accountId: account },
        projectId,
      );
      drafts.set(projectId, { plan, values, accountId: account });
      return plan;
    },

    async start(input) {
      const draft = drafts.get(input.projectId);
      if (!draft) throw new UserInputError("Build the plan for this project first.", 409);
      if (draft.plan.blockers.length) throw new UserInputError(draft.plan.blockers.join(" "));
      if (!WORKER_NAME.test(input.workerName)) {
        throw new UserInputError("Worker names use lowercase letters, digits and hyphens, up to 63 characters.");
      }
      const env = skipEntries(draft.plan.env, input.skip);
      // Only accept typed values for entries Vercel didn't supply.
      const typed = Object.fromEntries(
        env.entries.filter((e) => e.needsInput && input.values[e.id]).map((e) => [e.id, input.values[e.id] as string]),
      );
      const values = { ...draft.values, ...typed };
      const missing = missingInputs(env, values);
      if (missing.length) {
        throw new UserInputError(`Enter a value, or choose Skip, for: ${missing.map((e) => e.key).join(", ")}.`);
      }
      const plan: MigrationPlan = { ...draft.plan, env, workerName: input.workerName, nextCache: input.nextCache };
      const job = await d.store.create(plan, draft.accountId, values);
      drafts.delete(input.projectId);
      d.queue.enqueue(job.id);
      return job;
    },

    list: () => d.store.list(),
    get: (id) => d.store.get(id),

    async retry(id) {
      const job = await d.store.get(id);
      if (!job) throw new UserInputError("That job doesn't exist.", 404);
      if (job.status !== "failed" && job.status !== "paused") {
        throw new UserInputError("Only failed or paused jobs can be retried.", 409);
      }
      const reset = resetForRetry(job);
      await d.store.save(reset);
      d.queue.enqueue(id);
      return reset;
    },

    log: (id) => d.store.readLog(id),
    subscribe: (id, fn) => d.events.subscribe(id, fn),
  };
}
