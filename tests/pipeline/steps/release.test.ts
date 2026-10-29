import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import { ApiError } from "../../../src/http.ts";
import { deployStep, prStep, pushStep } from "../../../src/pipeline/steps/release.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

describe("deployStep", () => {
  const { plan: env, values } = buildEnvPlan(
    [{ id: "p", key: "API_KEY", value: "prod-secret", type: "encrypted", decrypted: true, target: ["production"] }],
    [],
  );

  it("lets OpenAI fix a failed deploy, keeps the passing deploy's URL and lists the fix for the pull request", async () => {
    const repoDir = await makeTempDir();
    await writeFile(join(repoDir, "cloudflare.config.ts"), 'compatibilityDate: "2099-01-01"\n');
    let deploys = 0;
    const { run } = fakeRunner(() =>
      ++deploys === 1
        ? { code: 1, output: "Error: compatibility date 2099-01-01 is in the future" }
        : { code: 0, output: "Deployed shop\n  https://shop.acme.workers.dev\n" },
    );
    const turns = [
      [{ name: "replace_in_file", args: { path: "cloudflare.config.ts", old_text: "2099-01-01", new_text: "2026-10-14" } }],
      [{ name: "run_check", args: {} }],
      [{ name: "finish", args: { fixed: true, summary: "The compatibility date was in the future." } }],
    ];
    const respond = vi.fn(async () => ({
      id: "r",
      output: (turns.shift() ?? []).map((c, i) => ({ type: "function_call", call_id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
    }));
    const cloudflare = { getWorkerTag: async () => "tag-1", screenshot: async () => new Uint8Array() } as unknown as CloudflareClient;
    const { ctx } = makeContext({
      plan: { options: { adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false, switchToPnpm: false, aiRepair: true } },
      deps: { run, cloudflare, workDir: repoDir, openai: async () => ({ model: "gpt-5.5", client: { listModels: async () => [], respond } }) },
      outputs: { clone: { dir: repoDir }, convert: { projectDir: repoDir } },
    });
    await deployStep.run(ctx);
    expect(deploys).toBe(2);
    expect(ctx.outputs.workersDevUrl).toBe("https://shop.acme.workers.dev");
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")[0]).toMatch(/^The first deploy failed, and OpenAI \(gpt-5.5\) fixed it/);
  });

  it("deploys with the OAuth token and a temporary secrets file, then records the Worker", async () => {
    const workDir = await makeTempDir();
    let secretsPath = "";
    let secretsContent = "";
    const { run, calls } = fakeRunner(async (_cmd, args) => {
      secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
      secretsContent = await readFile(secretsPath, "utf8");
      return { code: 0, output: "Deployed shop\n  https://shop.acme.workers.dev\n" };
    });
    const cloudflare = { getWorkerTag: vi.fn(async () => "tag-1") } as unknown as CloudflareClient;
    const { ctx, secrets } = makeContext({
      plan: { env },
      values,
      deps: { run, workDir, cloudflare },
      outputs: { convert: { projectDir: "/w/app" } },
    });

    await deployStep.run(ctx);

    expect(calls[0]).toMatchObject({
      cmd: "pnpm",
      opts: { cwd: "/w/app", env: { CI: "1", CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc" } },
    });
    expect(calls[0]?.args.slice(0, 3)).toEqual(["exec", "cf", "deploy"]);
    expect(JSON.parse(secretsContent)).toEqual({ API_KEY: "prod-secret" });
    expect(existsSync(secretsPath)).toBe(false);
    expect(secrets).toContain("cf-token");
    expect(ctx.outputs).toEqual({ workersDevUrl: "https://shop.acme.workers.dev", workerTag: "tag-1" });
    expect(cloudflare.getWorkerTag).toHaveBeenCalledWith("acc", "shop");
  });

  it("saves a screenshot of the deployed site", async () => {
    const image = new Uint8Array([1, 2, 3]);
    const screenshot = vi.fn(async () => image);
    const saveScreenshot = vi.fn(async () => {});
    const { run } = fakeRunner(() => ({ code: 0, output: "  https://shop.acme.workers.dev\n" }));
    const cloudflare = { getWorkerTag: async () => "tag-1", screenshot } as unknown as CloudflareClient;
    const { ctx, job } = makeContext({
      deps: { run, workDir: await makeTempDir(), cloudflare, saveScreenshot, now: () => 1234 },
      outputs: { convert: { projectDir: "/w/app" } },
    });
    await deployStep.run(ctx);
    expect(screenshot).toHaveBeenCalledWith("acc", "https://shop.acme.workers.dev");
    expect(saveScreenshot).toHaveBeenCalledWith(job.id, image);
    expect(ctx.outputs.screenshot).toBe("1234");
  });

  it("goes on without a screenshot when Browser Run refuses, after one more try", async () => {
    // Without the browser-rendering.write scope, or over the free plan's limits, Cloudflare refuses.
    const screenshot = vi.fn(async () => {
      throw new ApiError("cloudflare", 403, "Authentication error (10000)");
    });
    const saveScreenshot = vi.fn(async () => {});
    const sleeps: number[] = [];
    const { run } = fakeRunner(() => ({ code: 0, output: "  https://shop.acme.workers.dev\n" }));
    const cloudflare = { getWorkerTag: async () => "tag-1", screenshot } as unknown as CloudflareClient;
    const { ctx, job } = makeContext({
      deps: { run, workDir: await makeTempDir(), cloudflare, saveScreenshot, sleep: async (ms) => void sleeps.push(ms) },
      outputs: { convert: { projectDir: "/w/app" } },
    });
    await deployStep.run(ctx);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([15_000]);
    expect(saveScreenshot).toHaveBeenCalledWith(job.id, null);
    expect(ctx.outputs).toEqual({ workersDevUrl: "https://shop.acme.workers.dev", workerTag: "tag-1" });
  });

  it("passes the production build variables to the deploy, with CI and the Cloudflare credentials still winning", async () => {
    const { plan: vars, values: varValues } = buildEnvPlan(
      [
        { id: "a", key: "NEXT_PUBLIC_API", value: "https://api.example.com", type: "plain", target: ["production"] },
        { id: "b", key: "CLOUDFLARE_API_TOKEN", value: "from-vercel", type: "plain", target: ["production"] },
      ],
      [],
    );
    const { run, calls } = fakeRunner();
    const cloudflare = { getWorkerTag: async () => "tag-1" } as unknown as CloudflareClient;
    const { ctx } = makeContext({
      plan: { env: vars },
      values: varValues,
      deps: { run, cloudflare },
      outputs: { convert: { projectDir: "/w" } },
    });
    await deployStep.run(ctx);
    expect(calls[0]?.opts?.env).toEqual({
      NEXT_PUBLIC_API: "https://api.example.com",
      CI: "1",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acc",
    });
  });

  it("removes the secrets file even when the deploy fails", async () => {
    const workDir = await makeTempDir();
    let secretsPath = "";
    const { run } = fakeRunner((_cmd, args) => {
      secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
      return { code: 1, output: "Authentication error" };
    });
    const { ctx } = makeContext({ plan: { env }, values, deps: { run, workDir }, outputs: { convert: { projectDir: "/w" } } });
    await expect(deployStep.run(ctx)).rejects.toThrow();
    expect(existsSync(secretsPath)).toBe(false);
  });

  it("skips the secrets file when there are no runtime secrets", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "" }));
    const cloudflare = { getWorkerTag: async () => "tag-1" } as unknown as CloudflareClient;
    const { ctx } = makeContext({ deps: { run, cloudflare }, outputs: { convert: { projectDir: "/w" } } });
    await deployStep.run(ctx);
    expect(calls[0]?.args).not.toContain("--secrets-file");
  });

  it("fails when the Worker can't be found after deploying", async () => {
    const { run } = fakeRunner(() => ({ code: 0, output: "" }));
    const cloudflare = { getWorkerTag: async () => null } as unknown as CloudflareClient;
    const { ctx } = makeContext({ deps: { run, cloudflare }, outputs: { convert: { projectDir: "/w" } } });
    await expect(deployStep.run(ctx)).rejects.toThrow("wasn't found");
  });
});

describe("pushStep", () => {
  it("commits changes and force-pushes only the migration branch", async () => {
    const { run, calls } = fakeRunner((_cmd, args) => ({
      code: 0,
      output: args[0] === "status" ? " M package.json\n" : "",
    }));
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(["add", "status", "config", "-c", "push"]);
    expect(calls[3]?.args).toContain("commit");
    expect(calls[4]?.args).toEqual(["push", "--force", "origin", "HEAD:refs/heads/cloudflare-migration"]);
    expect(calls[4]?.opts?.env?.GIT_CONFIG_KEY_0).toBeDefined();
    expect(ctx.outputs.branch).toBe("cloudflare-migration");
  });

  it("commits with --no-verify and no identity override when git already has an identity", async () => {
    const { run, calls } = fakeRunner((_cmd, args) => {
      if (args[0] === "status") return { code: 0, output: " M package.json\n" };
      if (args[0] === "config") return { code: 0, output: "dev@example.com\n" };
      return { code: 0, output: "" };
    });
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    const commit = calls.find((c) => c.args.includes("commit"));
    expect(calls.find((c) => c.args[0] === "config")).toMatchObject({
      args: ["config", "user.email"],
      opts: { cwd: "/w" },
    });
    expect(commit?.args[0]).toBe("commit");
    expect(commit?.args).toContain("--no-verify");
    expect(commit?.args).not.toContain("-c");
  });

  it("supplies a Switchyard identity only when the repository has none", async () => {
    const { run, calls } = fakeRunner((_cmd, args) => {
      if (args[0] === "status") return { code: 0, output: " M package.json\n" };
      if (args[0] === "config") return { code: 1, output: "" };
      return { code: 0, output: "" };
    });
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    const commit = calls.find((c) => c.args.includes("commit"));
    expect(commit?.args.slice(0, 5)).toEqual([
      "-c",
      "user.name=Switchyard",
      "-c",
      "user.email=switchyard@localhost",
      "commit",
    ]);
    expect(commit?.args).toContain("--no-verify");
  });

  it("treats a blank git identity as missing", async () => {
    const { run, calls } = fakeRunner((_cmd, args) =>
      args[0] === "status" ? { code: 0, output: " M a\n" } : { code: 0, output: "\n" },
    );
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    expect(calls.find((c) => c.args.includes("commit"))?.args).toContain("user.email=switchyard@localhost");
  });

  it("doesn't create an empty commit on a retry", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "" }));
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(["add", "status", "push"]);
  });
});

describe("prStep", () => {
  it("reuses an open PR", async () => {
    const gh = {
      findOpenPr: vi.fn(async () => ({ url: "https://github.com/acme/shop/pull/3", number: 3 })),
      createPr: vi.fn(),
    } as unknown as GitHubClient;
    const { ctx } = makeContext({ deps: { github: async () => gh } });
    await prStep.run(ctx);
    expect(ctx.outputs.prUrl).toBe("https://github.com/acme/shop/pull/3");
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  it("opens a PR against the production branch with the deploy link in the body", async () => {
    const createPr = vi.fn(async () => ({ url: "https://github.com/acme/shop/pull/4", number: 4 }));
    const gh = { findOpenPr: async () => null, createPr } as unknown as GitHubClient;
    const { ctx } = makeContext({
      deps: { github: async () => gh },
      outputs: {
        deploy: { workersDevUrl: "https://shop.acme.workers.dev" },
        convert: { warnings: '["w1"]' },
        build: { warnings: '["w2"]' },
      },
    });
    await prStep.run(ctx);
    const [owner, repo, input] = createPr.mock.calls[0] as unknown as [string, string, { head: string; base: string; title: string; body: string }];
    expect([owner, repo, input.head, input.base]).toEqual(["acme", "shop", "cloudflare-migration", "main"]);
    expect(input.title).toBe("Move shop from Vercel to Cloudflare Workers");
    expect(input.body).toContain("https://shop.acme.workers.dev");
    expect(input.body).toContain("- [ ] w1");
    expect(input.body).toContain("- [ ] w2");
  });
});
