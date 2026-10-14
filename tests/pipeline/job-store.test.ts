import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("createJobStore", () => {
  it("creates a queued job with every step pending and keeps values in a private file", async () => {
    const dir = await makeTempDir();
    const store = createJobStore(dir);
    const job = await store.create(samplePlan, "acc", { e1: "secret-1" });
    expect(job.status).toBe("queued");
    expect(job.steps.map((s) => [s.id, s.status])).toEqual([
      ["clone", "pending"],
      ["convert", "pending"],
      ["build", "pending"],
      ["deploy", "pending"],
      ["push", "pending"],
      ["pr", "pending"],
      ["builds", "pending"],
      ["start-build", "pending"],
    ]);
    expect(await readFile(join(dir, `${job.id}.json`), "utf8")).not.toContain("secret-1");
    expect((await stat(join(dir, `${job.id}.values.json`))).mode & 0o777).toBe(0o600);
    expect(await store.readValues(job.id)).toEqual({ e1: "secret-1" });
    await store.deleteValues(job.id);
    expect(await store.readValues(job.id)).toEqual({});
  });

  it("rejects ids that aren't UUIDs, so API input can't reach other paths", async () => {
    const store = createJobStore(await makeTempDir());
    expect(await store.get("../credentials")).toBeNull();
  });

  it("skips a corrupt job file with a warning instead of failing", async () => {
    const dir = await makeTempDir();
    const store = createJobStore(dir);
    const good = await store.create(samplePlan, "acc", {});
    const badId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(dir, `${badId}.json`), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await store.list()).map((j) => j.id)).toEqual([good.id]);
      expect(await store.recoverInterrupted()).toEqual({ failed: [], queued: [good.id] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${badId}.json`));
    } finally {
      warn.mockRestore();
    }
  });

  it("lists jobs newest first", async () => {
    let t = 0;
    const store = createJobStore(await makeTempDir(), { now: () => new Date(++t * 1000) });
    const a = await store.create(samplePlan, "acc", {});
    const b = await store.create(samplePlan, "acc", {});
    expect((await store.list()).map((j) => j.id)).toEqual([b.id, a.id]);
  });

  it("appends log lines in order", async () => {
    const store = createJobStore(await makeTempDir());
    const job = await store.create(samplePlan, "acc", {});
    await Promise.all(["one", "two", "three"].map((l) => store.appendLog(job.id, l)));
    expect(await store.readLog(job.id)).toBe("one\ntwo\nthree\n");
  });

  it("marks steps that were running when Switchyard stopped as failed, and reports queued jobs", async () => {
    const store = createJobStore(await makeTempDir());
    const running = await store.create(samplePlan, "acc", {});
    running.status = "running";
    running.steps[1]!.status = "running";
    await store.save(running);
    const queued = await store.create(samplePlan, "acc", {});
    expect(await store.recoverInterrupted()).toEqual({ failed: [running.id], queued: [queued.id] });
    const after = await store.get(running.id);
    expect(after?.status).toBe("failed");
    expect(after?.steps[1]).toMatchObject({ status: "failed", error: expect.stringContaining("stopped") });
  });
});
