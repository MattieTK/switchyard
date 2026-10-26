import { describe, expect, it } from "vitest";
import { cronEntrySource } from "../../src/codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../src/codegen/gitignore.ts";
import { prBody } from "../../src/codegen/pr-body.ts";
import type { AgentRun } from "../../src/pipeline/types.ts";

describe("cronEntrySource", () => {
  const src = cronEntrySource("vinext/server/fetch-handler", [
    { path: "/api/a", schedule: "0 * * * *" },
    { path: "/api/b", schedule: "0 * * * *" },
    { path: "/api/c", schedule: "30 2 * * *" },
  ]);

  it("wraps the base entry and keeps its named exports", () => {
    expect(src).toContain('import app from "vinext/server/fetch-handler";');
    expect(src).toContain('export * from "vinext/server/fetch-handler";');
    expect(src).toContain("app.fetch(request, env, ctx)");
    // It type-checks without the Workers types in the app's tsconfig.
    expect(src).not.toMatch(/ExecutionContext|ScheduledController/);
  });

  it("groups paths by schedule", () => {
    expect(src).toContain('"0 * * * *": ["/api/a","/api/b"]');
    expect(src).toContain('"30 2 * * *": ["/api/c"]');
  });

  it("sends CRON_SECRET the way Vercel Cron does", () => {
    expect(src).toContain("Bearer ${env.CRON_SECRET}");
    expect(src).toContain('"user-agent": "vercel-cron/1.0"');
  });
});

describe("addGitignoreEntries", () => {
  it("appends only missing entries under a comment", () => {
    expect(addGitignoreEntries("node_modules\n.env\n", ["node_modules/", ".dev.vars"])).toBe(
      "node_modules\n.env\n\n# Added by Switchyard\n.dev.vars\n",
    );
  });

  it("returns the input unchanged when nothing is missing", () => {
    expect(addGitignoreEntries("/.dev.vars\n", [".dev.vars"])).toBe("/.dev.vars\n");
  });

  it("handles an empty file and a file without a trailing newline", () => {
    expect(addGitignoreEntries("", [".dev.vars"])).toBe("\n# Added by Switchyard\n.dev.vars\n");
    expect(addGitignoreEntries("dist", [".dev.vars"])).toBe("dist\n\n# Added by Switchyard\n.dev.vars\n");
  });
});

describe("prBody", () => {
  const body = prBody({
    projectName: "shop",
    productionBranch: "main",
    workersDevUrl: "https://shop.acme.workers.dev",
    hasCrons: true,
    skippedEnv: [{ key: "VERCEL_URL", reason: "Vercel system variable" }],
    manual: ["1 redirect in vercel.json – add it to `redirects()` in next.config.js."],
    features: [{ package: "@vercel/analytics", note: "Won't record visits." }],
    storage: [{ kind: "vercel-blob", label: "Vercel Blob", evidence: ["@vercel/blob"], suggestion: "Keeps working." }],
    warnings: ["pnpm blocked some build scripts."],
  });

  it("links the deploy and lists every manual item as a checkbox", () => {
    expect(body).toContain("**shop**");
    expect(body).toContain("https://shop.acme.workers.dev");
    expect(body).toContain("- [ ] 1 redirect in vercel.json");
    expect(body).toContain("- [ ] `VERCEL_URL` was not copied: Vercel system variable");
    expect(body).toContain("- [ ] `@vercel/analytics`: Won't record visits.");
    expect(body).toContain("- [ ] pnpm blocked some build scripts.");
    expect(body).toContain("Vercel Blob: Keeps working.");
    expect(body).toContain("Cron Triggers");
  });

  it("omits empty sections and never prints undefined", () => {
    const minimal = prBody({
      projectName: "x",
      productionBranch: "main",
      hasCrons: false,
      skippedEnv: [],
      manual: [],
      features: [],
      storage: [],
      warnings: [],
    });
    expect(minimal).not.toContain("undefined");
    expect(minimal).not.toContain("## Storage");
    expect(minimal).not.toContain("Cron Triggers");
    expect(minimal).not.toContain("Changes made by");
  });

  it("lists what an agent changed and asks for a review, leaving out runs that kept nothing", () => {
    const run = (over: Partial<AgentRun>): AgentRun => ({
      step: "build",
      agent: "codex",
      attempt: 1,
      startedAt: "2026-10-26T00:00:00.000Z",
      verdict: "fixed",
      summary: "aliased node-fetch to its CommonJS build",
      changedFiles: ["vite.config.ts"],
      ...over,
    });
    const body = prBody({
      projectName: "x",
      productionBranch: "main",
      hasCrons: false,
      skippedEnv: [],
      manual: [],
      features: [],
      storage: [],
      warnings: [],
      agentRuns: [
        run({ step: "convert", summary: "pinned sharp", changedFiles: ["package.json"], fixCommit: "abc1234def" }),
        run({ attempt: 1, verdict: "cannot-fix", changedFiles: [], error: "Codex couldn't fix it" }),
        run({ attempt: 2 }),
      ],
    });
    expect(body).toContain("## Changes made by Codex");
    expect(body).toContain("- Convert the project, in commit abc1234: pinned sharp (`package.json`)");
    expect(body).toContain("- Build locally with cf: aliased node-fetch to its CommonJS build (`vite.config.ts`)");
    expect(body).not.toContain("Codex couldn't fix it");
    expect(body).toContain("- [ ] Review the changes Codex made.");
  });
});
