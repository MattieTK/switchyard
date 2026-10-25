import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { supportForFramework } from "../../adapters/registry.ts";
import type { Support } from "../../adapters/types.ts";
import type { JobEvent } from "../../pipeline/types.ts";
import type { AppDeps } from "../app.ts";

export interface ProjectSummary {
  id: string;
  name: string;
  framework: string | null;
  repo: string | null;
  productionBranch: string | null;
  support: Support;
}

const startSchema = z.object({
  projectId: z.string().min(1),
  workerName: z.string().min(1),
  nextCache: z.enum(["kv", "none"]),
  values: z.record(z.string(), z.string()),
  skip: z.array(z.string()),
  options: z
    .object({
      adoptionCodemods: z.boolean(),
      eslintMigration: z.boolean(),
      updateFlaggedPackages: z.boolean(),
      switchToPnpm: z.boolean(),
    })
    .partial()
    .optional(),
});

export function jobRoutes(d: AppDeps): Hono {
  const r = new Hono();

  r.get("/projects", async (c) => {
    const projects = await (await d.clients.vercel()).listProjects();
    return c.json(
      projects.map(
        (p): ProjectSummary => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          repo: p.link?.org && p.link.repo ? `${p.link.org}/${p.link.repo}` : null,
          productionBranch: p.link?.productionBranch ?? null,
          support: supportForFramework(p.framework),
        }),
      ),
    );
  });

  r.post("/projects/:id/plan", async (c) => c.json(await d.jobs.plan(c.req.param("id"))));

  r.post("/jobs", async (c) => c.json(await d.jobs.start(startSchema.parse(await c.req.json())), 201));
  r.get("/jobs", async (c) => c.json(await d.jobs.list()));
  r.get("/jobs/:id", async (c) => {
    const job = await d.jobs.get(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "That job doesn't exist." }, 404);
  });
  r.post("/jobs/:id/retry", async (c) => c.json(await d.jobs.retry(c.req.param("id"))));
  r.post("/jobs/:id/restart", async (c) => c.json(await d.jobs.restart(c.req.param("id"))));
  r.get("/jobs/:id/log", async (c) => c.text(await d.jobs.log(c.req.param("id"))));

  r.get("/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const toSSE = (e: JobEvent) =>
        e.type === "job"
          ? { event: "job", data: JSON.stringify(e.job) }
          : { event: "log", data: JSON.stringify({ step: e.step, line: e.line }) };

      // Subscribe before reading the snapshot so no event falls in the gap.
      // Events that arrive until the snapshot is written are held in order.
      let pending: JobEvent[] | null = [];
      const release = d.jobs.subscribe(id, (e) => {
        if (pending) pending.push(e);
        else void stream.writeSSE(toSSE(e));
      });
      // Abort and the finally block can both run; release only once, because
      // a second call to the event bus's unsubscribe can drop a newer listener set.
      let released = false;
      const unsubscribe = () => {
        if (released) return;
        released = true;
        release();
      };
      stream.onAbort(unsubscribe);
      try {
        const job = await d.jobs.get(id);
        if (!job) {
          await stream.writeSSE({ event: "error", data: "That job doesn't exist." });
          return;
        }
        await stream.writeSSE({ event: "job", data: JSON.stringify(job) });
        while (pending.length > 0) await stream.writeSSE(toSSE(pending.shift()!));
        pending = null;
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(15_000);
          await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return r;
}
