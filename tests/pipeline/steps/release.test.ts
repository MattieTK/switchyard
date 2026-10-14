import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import { deployStep, prStep, pushStep } from "../../../src/pipeline/steps/release.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

describe("deployStep", () => {
  const { plan: env, values } = buildEnvPlan(
    [{ id: "p", key: "API_KEY", value: "prod-secret", type: "encrypted", target: ["production"] }],
    [],
  );

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
      outputs: { deploy: { workersDevUrl: "https://shop.acme.workers.dev" }, convert: { warnings: '["w1"]' } },
    });
    await prStep.run(ctx);
    const [owner, repo, input] = createPr.mock.calls[0] as unknown as [string, string, { head: string; base: string; title: string; body: string }];
    expect([owner, repo, input.head, input.base]).toEqual(["acme", "shop", "cloudflare-migration", "main"]);
    expect(input.title).toBe("Move shop from Vercel to Cloudflare Workers");
    expect(input.body).toContain("https://shop.acme.workers.dev");
    expect(input.body).toContain("- [ ] w1");
  });
});
