import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../../src/adapters/nextjs.ts";
import { adapterById, pickAdapter, supportForFramework } from "../../src/adapters/registry.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";

describe("nextjsAdapter", () => {
  it("matches Vercel's framework or a next dependency", () => {
    expect(nextjsAdapter.matches({ vercelFramework: "nextjs", packageJson: null })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: null, packageJson: { dependencies: { next: "16" } } })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: "vite", packageJson: { dependencies: {} } })).toBe(false);
  });

  it("runs a pinned vinext init with every choice passed as a flag", async () => {
    const { run, calls } = fakeRunner();
    const result = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls[0]).toMatchObject({
      cmd: "pnpm",
      args: [
        "dlx",
        "vinext@1.1.0",
        "init",
        "--platform=cloudflare",
        "--cdn-cache=data-cache",
        "--data-cache=kv",
        "--image-optimization=cloudflare-images",
      ],
      opts: { cwd: "/w" },
    });
    expect(result).toEqual({ baseEntrypoint: "vinext/server/fetch-handler", warnings: [] });
  });

  it("uses the no-cache preset when asked", async () => {
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir: "/w", pm: "npm", run, log: () => {}, options: { nextCache: "none" } });
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toContain("--cdn-cache=none");
    expect(calls[0]?.args).toContain("--data-cache=none");
  });

  it("warns when pnpm blocked build scripts", async () => {
    const { run } = fakeRunner(() => ({ code: 0, output: "Run pnpm approve-builds to review" }));
    const r = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(r.warnings[0]).toContain("pnpm approve-builds");
  });

  it("fails when vinext init fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "incompatible" }));
    await expect(
      nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } }),
    ).rejects.toThrow("exited with code 1");
  });
});

describe("registry", () => {
  it("picks the Next.js adapter and reports others as unsupported for now", () => {
    expect(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter?.id).toBe("nextjs");
    expect(pickAdapter({ vercelFramework: "sveltekit", packageJson: {} })).toEqual({
      adapter: null,
      support: { level: "unsupported", reason: "sveltekit projects aren't supported yet" },
    });
    expect(supportForFramework(null)).toEqual({ level: "unsupported", reason: "Vercel didn't detect a framework" });
    expect(adapterById("nextjs")).toBe(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter);
    expect(adapterById("nope")).toBeNull();
  });
});
