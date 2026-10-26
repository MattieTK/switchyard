import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileSecure } from "../fs-secure.ts";
import type { EnvValues } from "../translate/env-plan.ts";
import type { MigrationPlan } from "./plan.ts";
import { STEP_IDS, type Job } from "./types.ts";

export interface JobStore {
  create(plan: MigrationPlan, accountId: string, values: EnvValues): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(): Promise<Job[]>;
  save(job: Job): Promise<void>;
  readValues(id: string): Promise<EnvValues>;
  deleteValues(id: string): Promise<void>;
  appendLog(id: string, line: string): Promise<void>;
  flush(id: string): Promise<void>;
  readLog(id: string): Promise<string>;
  // A JPEG of the deployed site, or null to remove it.
  writeScreenshot(id: string, image: Uint8Array | null): Promise<void>;
  readScreenshot(id: string): Promise<Uint8Array | null>;
  clearLog(id: string): Promise<void>;
  recoverInterrupted(): Promise<{ failed: string[]; queued: string[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createJobStore(dir: string, opts: { now?: () => Date; newId?: () => string } = {}): JobStore {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  const logChains = new Map<string, Promise<void>>();
  const jobFile = (id: string) => join(dir, `${id}.json`);
  const valuesFile = (id: string) => join(dir, `${id}.values.json`);
  const logFile = (id: string) => join(dir, `${id}.log`);
  const screenshotFile = (id: string) => join(dir, `${id}.screenshot.jpg`);

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  const store: JobStore = {
    async create(plan, accountId, values) {
      const job: Job = {
        id: newId(),
        createdAt: now().toISOString(),
        accountId,
        plan,
        status: "queued",
        steps: STEP_IDS.map((id) => ({ id, status: "pending", outputs: {} })),
      };
      await writeFileSecure(valuesFile(job.id), JSON.stringify(values));
      await store.save(job);
      return job;
    },
    async get(id) {
      return UUID.test(id) ? readJson<Job>(jobFile(id)) : null;
    },
    async list() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ids = (await readdir(dir))
        .filter((f) => f.endsWith(".json") && !f.endsWith(".values.json"))
        .map((f) => f.slice(0, -".json".length));
      // One unreadable file shouldn't hide every other job, or stop Switchyard from starting.
      const read = await Promise.all(
        ids.map((id) =>
          store.get(id).catch((e: unknown) => {
            console.warn(`Skipping the job file ${id}.json: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }),
        ),
      );
      const jobs = read.filter((j): j is Job => j !== null);
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async save(job) {
      await writeFileSecure(jobFile(job.id), JSON.stringify(job, null, 2));
    },
    async readValues(id) {
      return (await readJson<EnvValues>(valuesFile(id))) ?? {};
    },
    async deleteValues(id) {
      await rm(valuesFile(id), { force: true });
    },
    appendLog(id, line) {
      // Chain appends per job so lines land in the order they were logged.
      const next = (logChains.get(id) ?? Promise.resolve()).then(() =>
        appendFile(logFile(id), `${line}\n`, { mode: 0o600 }),
      );
      logChains.set(id, next.catch(() => undefined));
      return next;
    },
    flush(id) {
      // The chain tail never rejects, so this resolves once every append issued so far has settled.
      return logChains.get(id) ?? Promise.resolve();
    },
    async writeScreenshot(id, image) {
      if (image === null) await rm(screenshotFile(id), { force: true });
      else await writeFile(screenshotFile(id), image, { mode: 0o600 });
    },
    async readScreenshot(id) {
      if (!UUID.test(id)) return null;
      const data = await readFile(screenshotFile(id)).catch(() => null);
      return data ? new Uint8Array(data) : null;
    },
    async readLog(id) {
      if (!UUID.test(id)) return "";
      return readFile(logFile(id), "utf8").catch(() => "");
    },
    clearLog(id) {
      // Joins the append chain, so lines logged before the clear don't land after it.
      const next = (logChains.get(id) ?? Promise.resolve()).then(() => rm(logFile(id), { force: true }));
      logChains.set(id, next.catch(() => undefined));
      return next;
    },
    async recoverInterrupted() {
      const failed: string[] = [];
      const queued: string[] = [];
      for (const job of await store.list()) {
        if (job.status === "queued") queued.push(job.id);
        if (job.status !== "running") continue;
        for (const s of job.steps) {
          if (s.status === "running") {
            s.status = "failed";
            s.error = "Switchyard stopped while this step was running. Retry to run it again.";
          }
        }
        job.status = "failed";
        await store.save(job);
        failed.push(job.id);
      }
      return { failed, queued };
    },
  };
  return store;
}
