import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "../../src/auth/store.ts";
import type { CloudflareClient } from "../../src/clients/cloudflare.ts";
import type { ClientFactory } from "../../src/clients/factory.ts";
import { UserInputError } from "../../src/errors.ts";
import { ApiError } from "../../src/http.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import type { MigrationPlan, PlanDeps } from "../../src/pipeline/plan.ts";
import { createJobService } from "../../src/pipeline/service.ts";
import { buildEnvPlan } from "../../src/translate/env-plan.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const { plan: env, values } = buildEnvPlan(
  [
    { id: "a", key: "API_KEY", value: "fetched", type: "encrypted", decrypted: true, target: ["production"] },
    { id: "s", key: "SENSITIVE", type: "sensitive", target: ["production"] },
    { id: "t", key: "OTHER_SENSITIVE", type: "sensitive", target: ["production"] },
  ],
  [],
);
const plan: MigrationPlan = { ...samplePlan, env };

async function setup(
  opts: { accountId?: string; plan?: MigrationPlan; existingWorkers?: string[]; pasted?: Partial<CloudflareClient> } = {},
) {
  const dir = await makeTempDir();
  const credentials = createCredentialStore(join(dir, "c.json"));
  if (opts.accountId) {
    await credentials.update(() => ({ cloudflare: { accessToken: "x", expiresAt: 0, accountId: opts.accountId } }));
  }
  const store = createJobStore(join(dir, "jobs"));
  const queue = { enqueue: vi.fn(), idle: async () => {} };
  const buildPlan = vi.fn(async (_d: PlanDeps, _projectId: string) => ({ plan: opts.plan ?? plan, values }));
  const getWorkerTag = vi.fn(async (_account: string, name: string) =>
    opts.existingWorkers?.includes(name) ? "tag-1" : null,
  );
  const cloudflareWith = vi.fn((_token: string) => opts.pasted as CloudflareClient);
  const clients = {
    vercel: async () => ({}),
    github: async () => ({}),
    cloudflare: { getWorkerTag, getUser: async () => ({ id: "u-1", email: "me@example.com" }) },
    cloudflareWith,
  } as unknown as ClientFactory;
  const service = createJobService({ store, events: createJobEvents(), queue, clients, credentials, buildPlan });
  return { service, store, queue, buildPlan, getWorkerTag, cloudflareWith, credentials };
}

const input = { projectId: "prj_1", workerName: "shop", nextCache: "kv" as const, values: {}, skip: [] };

describe("createJobService", () => {
  it("asks for a Cloudflare account before planning", async () => {
    const { service } = await setup();
    await expect(service.plan("prj_1")).rejects.toThrow("Choose a Cloudflare account");
  });

  it("builds a plan for the chosen account", async () => {
    const { service, buildPlan } = await setup({ accountId: "acc" });
    expect(await service.plan("prj_1")).toEqual({ ...plan, aiModel: null });
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

  it("rejects a changed Worker name that already exists on the account, and keeps the plan for another try", async () => {
    const { service, getWorkerTag } = await setup({ accountId: "acc", existingWorkers: ["taken"] });
    await service.plan("prj_1");
    const approve = { ...input, skip: ["s", "t"] };
    await expect(service.start({ ...approve, workerName: "taken" })).rejects.toBeInstanceOf(UserInputError);
    await expect(service.start({ ...approve, workerName: "taken" })).rejects.toThrow("taken");
    expect(getWorkerTag).toHaveBeenCalledWith("acc", "taken");
    const job = await service.start({ ...approve, workerName: "free" });
    expect(job.plan.workerName).toBe("free");
  });

  it("allows the plan's own Worker name even when it exists, since the plan already warned about it", async () => {
    const { service, getWorkerTag } = await setup({ accountId: "acc", existingWorkers: ["shop"] });
    await service.plan("prj_1");
    const job = await service.start({ ...input, skip: ["s", "t"] });
    expect(job.plan.workerName).toBe("shop");
    expect(getWorkerTag).not.toHaveBeenCalled();
  });

  it("applies the options the user chose, and switching to pnpm changes the plan's package manager", async () => {
    const offered: MigrationPlan = {
      ...plan,
      packageManager: "yarn",
      upgrade: { from: "13.4.0", to: "16.4.1" },
      pnpmSwitch: { available: true, hint: null, reresolves: false },
    };
    const { service } = await setup({ accountId: "acc", plan: offered });
    await service.plan("prj_1");
    const job = await service.start({ ...input, skip: ["s", "t"], options: { eslintMigration: true, switchToPnpm: true } });
    expect(job.plan).toMatchObject({
      packageManager: "pnpm",
      switchedFrom: "yarn",
      options: { adoptionCodemods: false, eslintMigration: true, updateFlaggedPackages: false, switchToPnpm: true },
    });
  });

  it("offers OpenAI fixes only when OpenAI is connected", async () => {
    const { service, credentials } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    await expect(service.start({ ...input, skip: ["s", "t"], options: { aiRepair: true } })).rejects.toThrow("Connect OpenAI");

    await credentials.update((c) => ({ ...c, openai: { kind: "apikey", apiKey: "sk-test", model: "gpt-5.5" } }));
    expect((await service.plan("prj_1")).aiModel).toBe("gpt-5.5");
    const job = await service.start({ ...input, skip: ["s", "t"], options: { aiRepair: true } });
    expect(job.plan.options?.aiRepair).toBe(true);
  });

  it("turns on OpenAI fixes for a failed build and retries it, keeping a failed Cloudflare build for its log", async () => {
    const { service, store, queue, credentials } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    const job = await service.start({ ...input, skip: ["s", "t"] });
    const fail = async (id: "convert" | "start-build", outputs: Record<string, string> = {}) =>
      store.save({
        ...job,
        status: "failed",
        steps: job.steps.map((s) => (s.id === id ? { ...s, status: "failed", error: "boom", outputs } : s)),
      });

    await fail("start-build", { buildUuid: "b-1", buildUrl: "https://dash" });
    await expect(service.fixWithAI(job.id)).rejects.toThrow("Sign in with ChatGPT");

    await credentials.update((c) => ({ ...c, openai: { kind: "apikey", apiKey: "sk", model: "gpt-5.5" } }));
    const fixed = await service.fixWithAI(job.id);
    expect(fixed.plan.options?.aiRepair).toBe(true);
    expect(fixed.status).toBe("queued");
    expect(fixed.steps.find((s) => s.id === "start-build")).toEqual({ id: "start-build", status: "pending", outputs: { failedBuild: "b-1" } });
    expect(queue.enqueue).toHaveBeenLastCalledWith(job.id);

    await fail("convert");
    await expect(service.fixWithAI(job.id)).rejects.toThrow("but not this step");
    await store.save({ ...job, status: "done" });
    await expect(service.fixWithAI(job.id)).rejects.toThrow("Only a failed job");
  });

  it("refuses options the plan didn't offer", async () => {
    const unavailable: MigrationPlan = { ...plan, upgrade: null, pnpmSwitch: { available: false, reason: "Workspaces." } };
    const { service } = await setup({ accountId: "acc", plan: unavailable });
    await service.plan("prj_1");
    await expect(service.start({ ...input, skip: ["s", "t"], options: { adoptionCodemods: true } })).rejects.toThrow(
      "Upgrade options only apply",
    );
    await expect(service.start({ ...input, skip: ["s", "t"], options: { switchToPnpm: true } })).rejects.toThrow("Workspaces.");
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

  it("starts failed, paused or finished jobs over from the first step, but not queued or running ones", async () => {
    const { service, store, queue } = await setup({ accountId: "acc" });
    const job = await store.create(plan, "acc", {});
    await store.appendLog(job.id, "[build] failed");
    await expect(service.restart(job.id)).rejects.toThrow("Only failed, paused or finished jobs can be started over.");
    expect(await store.readLog(job.id)).toBe("[build] failed\n");

    // A finished job can start over; retry stays limited to jobs that stopped.
    const finished = await store.create(plan, "acc", {});
    finished.status = "done";
    for (const s of finished.steps) s.status = "done";
    await store.save(finished);
    await expect(service.retry(finished.id)).rejects.toThrow("Only failed or paused jobs can be retried.");
    const again = await service.restart(finished.id);
    expect(again.status).toBe("queued");
    expect(again.steps.every((s) => s.status === "pending")).toBe(true);

    job.status = "failed";
    job.steps[0]!.status = "done";
    job.steps[2]!.status = "failed";
    await store.save(job);
    const restarted = await service.restart(job.id);
    expect(await store.readLog(job.id)).toBe("");
    expect(restarted.status).toBe("queued");
    expect(restarted.steps.every((s) => s.status === "pending")).toBe(true);
    expect((await store.get(job.id))?.steps[0]?.status).toBe("pending");
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
    await expect(service.restart("00000000-0000-4000-8000-00000000ffff")).rejects.toMatchObject({ status: 404 });
  });

  // A job paused at the builds step, waiting for a pasted token.
  async function waitingForToken(store: Awaited<ReturnType<typeof setup>>["store"]) {
    const job = await store.create(plan, "acc", {});
    job.status = "paused";
    const builds = job.steps.find((s) => s.id === "builds")!;
    builds.status = "paused";
    builds.pause = { reason: "Paste a token", input: "cloudflare-build-token" };
    await store.save(job);
    return job;
  }

  it("registers a pasted token as a build token with that token, then checks the job again", async () => {
    const pasted = {
      verifyToken: vi.fn(async () => ({ id: "tok-1", status: "active" })),
      getUser: async () => ({ id: "u-1", email: "me@example.com" }),
      listBuildTokens: vi.fn(async () => []),
      createBuildToken: vi.fn(async () => ({ build_token_uuid: "bt-1", build_token_name: "Switchyard" })),
    };
    const { service, store, queue, cloudflareWith } = await setup({ accountId: "acc", pasted });
    const idle = await store.create(plan, "acc", {});
    await expect(service.submitBuildToken(idle.id, "secret")).rejects.toThrow("isn't waiting for a Workers Builds token");

    const job = await waitingForToken(store);
    const next = await service.submitBuildToken(job.id, "  secret\n");
    expect(cloudflareWith).toHaveBeenCalledWith("secret");
    expect(pasted.createBuildToken).toHaveBeenCalledWith("acc", {
      build_token_name: "Switchyard",
      build_token_secret: "secret",
      cloudflare_token_id: "tok-1",
    });
    expect(next.status).toBe("queued");
    expect(next.steps.find((s) => s.id === "builds")?.status).toBe("pending");
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it("refuses an inactive or rejected token and another user's, and reuses an earlier registration", async () => {
    const base = {
      verifyToken: async () => ({ id: "tok-1", status: "active" }),
      getUser: async () => ({ id: "u-1", email: "me@example.com" }),
      listBuildTokens: async () => [],
      createBuildToken: vi.fn(async () => ({ build_token_uuid: "bt-1", build_token_name: "Switchyard" })),
    };
    for (const [pasted, message] of [
      [{ ...base, verifyToken: async () => ({ id: "tok-1", status: "disabled" }) }, "isn't active"],
      [
        {
          ...base,
          verifyToken: async () => {
            throw new ApiError("cloudflare", 401, "Invalid API Token (1000)", true);
          },
        },
        "Cloudflare didn't accept that token: cloudflare API error 401: Invalid API Token (1000)",
      ],
      [{ ...base, getUser: async () => ({ id: "u-2", email: "other@example.com" }) }, "belongs to other@example.com"],
    ] as const) {
      const { service, store } = await setup({ accountId: "acc", pasted });
      const job = await waitingForToken(store);
      await expect(service.submitBuildToken(job.id, "secret")).rejects.toThrow(message);
      expect((await store.get(job.id))?.status).toBe("paused");
    }

    const reuse = { ...base, listBuildTokens: async () => [{ build_token_uuid: "bt-0", build_token_name: "Mine", cloudflare_token_id: "tok-1" }] };
    const { service, store } = await setup({ accountId: "acc", pasted: reuse });
    await service.submitBuildToken((await waitingForToken(store)).id, "secret");
    expect(reuse.createBuildToken).not.toHaveBeenCalled();
  });
});
