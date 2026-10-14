import { describe, expect, it } from "vitest";
import type { CloudflareClient } from "../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../src/clients/github.ts";
import type { VercelClient, VercelProject } from "../../src/clients/vercel.ts";
import { ApiError } from "../../src/http.ts";
import { buildPlan, planDomains, sanitizeWorkerName } from "../../src/pipeline/plan.ts";

const project: VercelProject = {
  id: "prj_1",
  name: "My Shop!",
  framework: "nextjs",
  rootDirectory: "apps/web/",
  link: { type: "github", org: "acme", repo: "shop", repoId: 2, productionBranch: "main" },
};

function deps(over: { project?: VercelProject; github?: Partial<GitHubClient>; existingWorkers?: string[] } = {}) {
  const files: Record<string, string> = {
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "16", "@vercel/blob": "1" } }),
    "apps/web/vercel.json": JSON.stringify({ crons: [{ path: "/api/cron", schedule: "0 * * * *" }] }),
  };
  const vercel = {
    getProject: async () => over.project ?? project,
    listEnv: async () => [
      { id: "e1", key: "API_KEY", value: "secret-1", type: "encrypted", decrypted: true, target: ["production"] },
      { id: "e2", key: "TOKEN", type: "sensitive", target: ["production"] },
      { id: "e3", key: "BLOB_READ_WRITE_TOKEN", value: "b", type: "encrypted", decrypted: true, target: ["production"] },
    ],
    listDomains: async () => [{ name: "shop.example.com" }, { name: "my-shop.vercel.app" }, { name: "other.io" }],
  } as unknown as VercelClient;
  const github = {
    getRepo: async () => ({ id: 2, name: "shop", ownerId: 1, ownerLogin: "acme", defaultBranch: "main", private: true }),
    getFile: async (_o: string, _r: string, path: string) => files[path] ?? null,
    listDir: async (_o: string, _r: string, path: string) => (path === "" ? ["pnpm-lock.yaml", "apps"] : ["package.json"]),
    ...over.github,
  } as unknown as GitHubClient;
  const cloudflare = {
    listZones: async () => [{ id: "z", name: "example.com" }],
    getWorkerTag: async (_account: string, name: string) => (over.existingWorkers?.includes(name) ? "tag-1" : null),
  } as unknown as CloudflareClient;
  return { vercel, github, cloudflare, accountId: "acc" };
}

describe("buildPlan", () => {
  it("builds a complete plan for a Next.js project in a monorepo folder", async () => {
    const { plan, values } = await buildPlan(deps(), "prj_1");
    expect(plan).toMatchObject({
      projectId: "prj_1",
      workerName: "my-shop",
      repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" },
      packageManager: "pnpm",
      adapterId: "nextjs",
      support: { level: "supported" },
      nextCache: "kv",
      blockers: [],
    });
    expect(plan.vercelJson.crons).toEqual([{ path: "/api/cron", schedule: "0 * * * *" }]);
    expect(plan.storage.map((s) => s.kind)).toEqual(["vercel-blob"]);
    expect(plan.env.entries.find((e) => e.key === "TOKEN")?.needsInput).toBe(true);
    expect(plan.domains).toEqual([
      { name: "shop.example.com", zone: "example.com" },
      { name: "other.io", zone: null },
    ]);
    expect(values.e1).toBe("secret-1");
    expect(JSON.stringify(plan)).not.toContain("secret-1");
  });

  it("adds no warning when no Worker has the planned name", async () => {
    const { plan } = await buildPlan(deps(), "prj_1");
    expect(plan.warnings).toEqual([]);
  });

  it("warns when a Worker with the planned name already exists on the account", async () => {
    const { plan } = await buildPlan(deps({ existingWorkers: ["my-shop"] }), "prj_1");
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("my-shop");
    expect(plan.warnings[0]).toContain("replace its code and secrets");
    expect(plan.warnings[0]).toContain("Choose another name");
  });

  it("passes on the adapter's warnings, such as a Next.js upgrade", async () => {
    const { plan } = await buildPlan(
      deps({ github: { getFile: async (_o: string, _r: string, path: string) => (path.endsWith("package.json") ? '{"dependencies":{"next":"13.4.0"}}' : null) } }),
      "prj_1",
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([expect.stringContaining("This app uses Next.js 13.")]);
  });

  it("blocks projects without a Git link or on another provider", async () => {
    const noLink = await buildPlan(deps({ project: { ...project, link: undefined } }), "p");
    expect(noLink.plan.blockers[0]).toContain("isn't linked to a Git repository");
    const gitlab = await buildPlan(
      deps({ project: { ...project, link: { type: "gitlab", org: "a", repo: "b" } } }),
      "p",
    );
    expect(gitlab.plan.blockers[0]).toContain("gitlab");
  });

  it("blocks when the repo can't be reached, naming it", async () => {
    const { plan } = await buildPlan(
      deps({
        github: {
          getRepo: async () => {
            throw new ApiError("github", 404, "Repository acme/shop was not found, or the GitHub token can't access it. … SSO …");
          },
        },
      }),
      "p",
    );
    expect(plan.blockers[0]).toContain("acme/shop");
    expect(plan.blockers[0]).toContain("SSO");
  });

  it("blocks when package.json is missing at the root directory", async () => {
    const { plan } = await buildPlan(deps({ github: { getFile: async () => null } }), "p");
    expect(plan.blockers).toContain("No readable package.json at apps/web on main.");
  });

  it("blocks when the production branch is the migration branch", async () => {
    const { plan } = await buildPlan(
      deps({ project: { ...project, link: { ...project.link!, productionBranch: "cloudflare-migration" } } }),
      "p",
    );
    expect(plan.blockers.some((b) => b.includes("cloudflare-migration"))).toBe(true);
  });

  it("rethrows auth errors so the UI can ask to reconnect", async () => {
    const err = await buildPlan(
      deps({
        github: {
          getRepo: async () => {
            throw new ApiError("github", 401, "Bad credentials", true);
          },
        },
      }),
      "p",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});

describe("helpers", () => {
  it("sanitises Worker names", () => {
    expect(sanitizeWorkerName("My Shop!")).toBe("my-shop");
    expect(sanitizeWorkerName("---")).toBe("app");
    expect(sanitizeWorkerName("a".repeat(80))).toHaveLength(63);
  });

  it("matches domains to the longest zone", () => {
    expect(
      planDomains([{ name: "a.b.example.com" }], [
        { id: "1", name: "example.com" },
        { id: "2", name: "b.example.com" },
      ]),
    ).toEqual([{ name: "a.b.example.com", zone: "b.example.com" }]);
  });
});
