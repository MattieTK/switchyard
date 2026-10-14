import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "../../src/auth/store.ts";
import type { ClientFactory } from "../../src/clients/factory.ts";
import { UserInputError } from "../../src/errors.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import type { MigrationPlan, PlanDeps } from "../../src/pipeline/plan.ts";
import { createJobService } from "../../src/pipeline/service.ts";
import { buildEnvPlan } from "../../src/translate/env-plan.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const { plan: env, values } = buildEnvPlan(
  [
    { id: "a", key: "API_KEY", value: "fetched", type: "encrypted", target: ["production"] },
    { id: "s", key: "SENSITIVE", type: "sensitive", target: ["production"] },
    { id: "t", key: "OTHER_SENSITIVE", type: "sensitive", target: ["production"] },
  ],
  [],
);
const plan: MigrationPlan = { ...samplePlan, env };

async function setup(opts: { accountId?: string; plan?: MigrationPlan } = {}) {
  const dir = await makeTempDir();
  const credentials = createCredentialStore(join(dir, "c.json"));
  if (opts.accountId) {
    await credentials.update(() => ({ cloudflare: { accessToken: "x", expiresAt: 0, accountId: opts.accountId } }));
  }
  const store = createJobStore(join(dir, "jobs"));
  const queue = { enqueue: vi.fn(), idle: async () => {} };
  const buildPlan = vi.fn(async (_d: PlanDeps, _projectId: string) => ({ plan: opts.plan ?? plan, values }));
  const clients = { vercel: async () => ({}), github: async () => ({}), cloudflare: {} } as unknown as ClientFactory;
  const service = createJobService({ store, events: createJobEvents(), queue, clients, credentials, buildPlan });
  return { service, store, queue, buildPlan };
}

const input = { projectId: "prj_1", workerName: "shop", nextCache: "kv" as const, values: {}, skip: [] };

describe("createJobService", () => {
  it("asks for a Cloudflare account before planning", async () => {
    const { service } = await setup();
    await expect(service.plan("prj_1")).rejects.toThrow("Choose a Cloudflare account");
  });

  it("builds a plan for the chosen account", async () => {
    const { service, buildPlan } = await setup({ accountId: "acc" });
    expect(await service.plan("prj_1")).toBe(plan);
    expect(buildPlan.mock.calls[0]?.[0]).toMatchObject({ accountId: "acc" });
  });

  it("refuses to start without a plan, with blockers, or with missing values", async () => {
    const { service } = await setup({ accountId: "acc" });
    await expect(service.start(input)).rejects.toThrow("Build the plan");
    await service.plan("prj_1");
    await expect(service.start(input)).rejects.toThrow("SENSITIVE, OTHER_SENSITIVE");

    const blocked = await setup({ accountId: "acc", plan: { ...plan, blockers: ["No repo"] } });
    await blocked.service.plan("prj_1");
    await expect(blocked.service.start(input)).rejects.toThrow("No repo");
  });

  it("rejects invalid Worker names", async () => {
    const { service } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    await expect(service.start({ ...input, workerName: "Bad Name", skip: ["s", "t"] })).rejects.toBeInstanceOf(UserInputError);
  });

  it("creates and queues a job with typed values and skips, and only accepts values that were missing", async () => {
    const { service, store, queue } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    const job = await service.start({
      ...input,
      workerName: "my-shop",
      nextCache: "none",
      values: { s: "typed", a: "attempted-override" },
      skip: ["t"],
    });
    expect(job.plan.workerName).toBe("my-shop");
    expect(job.plan.nextCache).toBe("none");
    expect(job.plan.env.entries.find((e) => e.id === "t")?.skipReason).toBe("Skipped by you");
    expect(await store.readValues(job.id)).toEqual({ a: "fetched", s: "typed" });
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
    await expect(service.start(input)).rejects.toThrow("Build the plan");
  });

  it("lets only one of two overlapping approvals create a job", async () => {
    const { service, queue } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    const approve = { ...input, skip: ["s", "t"] };
    const results = await Promise.allSettled([service.start(approve), service.start(approve)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(UserInputError);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("restores the approved plan when a start fails, so a corrected start can succeed", async () => {
    const { service, queue } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    await expect(service.start(input)).rejects.toThrow("SENSITIVE, OTHER_SENSITIVE");
    const job = await service.start({ ...input, values: { s: "typed", t: "typed" } });
    expect(job.plan.workerName).toBe("shop");
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it("retries only failed or paused jobs", async () => {
    const { service, store, queue } = await setup({ accountId: "acc" });
    const job = await store.create(plan, "acc", {});
    await expect(service.retry(job.id)).rejects.toThrow("Only failed or paused");
    job.status = "failed";
    job.steps[0]!.status = "failed";
    await store.save(job);
    const retried = await service.retry(job.id);
    expect(retried.status).toBe("queued");
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
    await expect(service.retry("00000000-0000-4000-8000-00000000ffff")).rejects.toMatchObject({ status: 404 });
  });
});
