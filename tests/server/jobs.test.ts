import { describe, expect, it, vi } from "vitest";
import type { ClientFactory } from "../../src/clients/factory.ts";
import type { VercelClient } from "../../src/clients/vercel.ts";
import { UserInputError } from "../../src/errors.ts";
import { ApiError } from "../../src/http.ts";
import type { JobService } from "../../src/pipeline/service.ts";
import type { Job, JobEvent } from "../../src/pipeline/types.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeApp } from "./helpers.ts";

const job = { id: "00000000-0000-4000-8000-000000000001", status: "queued", plan: samplePlan, steps: [] } as unknown as Job;

describe("project routes", () => {
  it("lists Vercel projects with repo and support level", async () => {
    const vercel = {
      listProjects: async () => [
        { id: "p1", name: "shop", framework: "nextjs", rootDirectory: null, link: { type: "github", org: "acme", repo: "shop", productionBranch: "main" } },
        { id: "p2", name: "blog", framework: "astro", rootDirectory: null },
      ],
    } as unknown as VercelClient;
    const { req } = await makeApp({ clients: { vercel: async () => vercel } as unknown as ClientFactory });
    expect(await (await req("/api/projects")).json()).toEqual([
      { id: "p1", name: "shop", framework: "nextjs", repo: "acme/shop", productionBranch: "main", support: { level: "supported" } },
      { id: "p2", name: "blog", framework: "astro", repo: null, productionBranch: null, support: { level: "unsupported", reason: "astro projects aren't supported yet" } },
    ]);
  });

  it("asks the client to reconnect on auth errors", async () => {
    const clients = {
      vercel: async () => {
        throw new ApiError("vercel", 401, "Vercel is not connected", true);
      },
    } as unknown as ClientFactory;
    const { req } = await makeApp({ clients });
    const res = await req("/api/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "vercel API error 401: Vercel is not connected", reconnect: "vercel" });
  });

  it("builds a plan", async () => {
    const jobs = { plan: vi.fn(async () => samplePlan) } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req("/api/projects/p1/plan", { method: "POST" });
    expect(await res.json()).toEqual(samplePlan);
    expect(jobs.plan).toHaveBeenCalledWith("p1");
  });
});

describe("job routes", () => {
  it("validates and starts a job", async () => {
    const start = vi.fn(async () => job);
    const { req } = await makeApp({ jobs: { start } as unknown as JobService });
    expect((await req("/api/jobs", { method: "POST", json: { projectId: "p1" } })).status).toBe(400);
    const res = await req("/api/jobs", {
      method: "POST",
      json: { projectId: "p1", workerName: "shop", nextCache: "kv", values: { s: "v" }, skip: [] },
    });
    expect(res.status).toBe(201);
    expect(start).toHaveBeenCalledWith({ projectId: "p1", workerName: "shop", nextCache: "kv", values: { s: "v" }, skip: [] });
  });

  it("returns user input errors with their status", async () => {
    const jobs = {
      start: async () => {
        throw new UserInputError("Enter a value for: X.");
      },
      get: async () => null,
    } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req("/api/jobs", {
      method: "POST",
      json: { projectId: "p1", workerName: "shop", nextCache: "kv", values: {}, skip: [] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter a value for: X." });
    expect((await req(`/api/jobs/${job.id}`)).status).toBe(404);
  });

  it("retries and returns the log", async () => {
    const jobs = { retry: vi.fn(async () => job), log: async () => "[clone] ok\n" } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    expect((await req(`/api/jobs/${job.id}/retry`, { method: "POST" })).status).toBe(200);
    expect(await (await req(`/api/jobs/${job.id}/log`)).text()).toBe("[clone] ok\n");
  });

  it("streams the current job, then events, over SSE", async () => {
    let listener: ((e: JobEvent) => void) | undefined;
    const jobs = {
      get: async () => job,
      subscribe: (_id: string, fn: (e: JobEvent) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req(`/api/jobs/${job.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: job");
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "log", jobId: job.id, step: "clone", line: "hello" });
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("event: log");
    expect(second).toContain('"line":"hello"');
    await reader.cancel();
  });
});
