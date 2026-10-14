import { pickAdapter } from "../adapters/registry.ts";
import type { NextCachePreset, Support } from "../adapters/types.ts";
import type { CloudflareClient, CloudflareZone } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { VercelClient, VercelDomain } from "../clients/vercel.ts";
import { MIGRATION_BRANCH } from "../config.ts";
import { ApiError } from "../http.ts";
import { buildEnvPlan, type EnvPlan, type EnvValues } from "../translate/env-plan.ts";
import { detectVercelFeatures, type FeatureFinding } from "../translate/features.ts";
import { allDependencies, parsePackageJson, type PackageJson } from "../translate/package-json.ts";
import { detectPackageManager, type PackageManager } from "../translate/package-manager.ts";
import { detectStorage, type StorageFinding } from "../translate/storage.ts";
import { translateVercelJson, type VercelJsonTranslation } from "../translate/vercel-json.ts";

export interface DomainPlan {
  name: string;
  zone: string | null;
}

export interface MigrationPlan {
  projectId: string;
  projectName: string;
  workerName: string;
  repo: { owner: string; name: string; productionBranch: string; rootDirectory: string } | null;
  packageManager: PackageManager;
  adapterId: string | null;
  support: Support;
  nextCache: NextCachePreset;
  env: EnvPlan;
  vercelJson: VercelJsonTranslation;
  storage: StorageFinding[];
  features: FeatureFinding[];
  domains: DomainPlan[];
  blockers: string[];
  warnings: string[];
}

export interface PlanDeps {
  vercel: VercelClient;
  github: GitHubClient;
  cloudflare: CloudflareClient;
  accountId: string;
}

export function sanitizeWorkerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "app";
}

export function planDomains(domains: VercelDomain[], zones: CloudflareZone[]): DomainPlan[] {
  const byLength = [...zones].sort((a, b) => b.name.length - a.name.length);
  return domains
    .filter((d) => !d.name.endsWith(".vercel.app"))
    .map((d) => ({
      name: d.name,
      zone: byLength.find((z) => d.name === z.name || d.name.endsWith(`.${z.name}`))?.name ?? null,
    }));
}

// Phase 1: read everything needed to show the plan. Nothing is written anywhere.
export async function buildPlan(d: PlanDeps, projectId: string): Promise<{ plan: MigrationPlan; values: EnvValues }> {
  const project = await d.vercel.getProject(projectId);
  const [envVars, domains, zones] = await Promise.all([
    d.vercel.listEnv(project.id),
    d.vercel.listDomains(project.id),
    d.cloudflare.listZones(d.accountId),
  ]);
  const rootDirectory = (project.rootDirectory ?? "").replace(/^\/+|\/+$/g, "");
  const blockers: string[] = [];
  let repo: MigrationPlan["repo"] = null;
  let pkg: PackageJson | null = null;
  let files: string[] = [];
  let vercelJsonRaw: string | null = null;

  const link = project.link;
  if (!link?.org || !link.repo) {
    blockers.push("This project isn't linked to a Git repository on Vercel, so there is no code to convert.");
  } else if (link.type !== "github") {
    blockers.push(`Only GitHub repositories are supported at this point (this project uses ${link.type}).`);
  } else {
    try {
      const info = await d.github.getRepo(link.org, link.repo);
      const productionBranch = link.productionBranch ?? info.defaultBranch;
      repo = { owner: info.ownerLogin, name: info.name, productionBranch, rootDirectory };
      if (productionBranch === MIGRATION_BRANCH) {
        blockers.push(
          `The production branch is called ${MIGRATION_BRANCH}, which Switchyard uses for its own changes. Rename the production branch first.`,
        );
      }
      const at = (file: string) => (rootDirectory ? `${rootDirectory}/${file}` : file);
      const [pkgText, vercelJson, rootFiles, dirFiles] = await Promise.all([
        d.github.getFile(info.ownerLogin, info.name, at("package.json"), productionBranch),
        d.github.getFile(info.ownerLogin, info.name, at("vercel.json"), productionBranch),
        d.github.listDir(info.ownerLogin, info.name, "", productionBranch),
        rootDirectory ? d.github.listDir(info.ownerLogin, info.name, rootDirectory, productionBranch) : null,
      ]);
      pkg = parsePackageJson(pkgText);
      vercelJsonRaw = vercelJson;
      files = [...(rootFiles ?? []), ...(dirFiles ?? [])];
      if (!pkg) blockers.push(`No readable package.json at ${rootDirectory || "the repository root"} on ${productionBranch}.`);
    } catch (e) {
      if (e instanceof ApiError && !e.auth) blockers.push(e.message);
      else throw e;
    }
  }

  const { adapter, support } = pickAdapter({ vercelFramework: project.framework, packageJson: pkg });
  if (!adapter) blockers.push(support.reason ?? "This framework isn't supported yet.");
  const env = buildEnvPlan(envVars, adapter?.reservedBindings ?? []);
  const dependencies = allDependencies(pkg);

  const workerName = sanitizeWorkerName(project.name);
  const warnings: string[] = [...(adapter?.planWarnings?.(pkg) ?? [])];
  if (await d.cloudflare.getWorkerTag(d.accountId, workerName)) {
    warnings.push(
      `A Worker called ${workerName} already exists on this Cloudflare account. Deploying will replace its code and secrets. Choose another name to keep it.`,
    );
  }

  return {
    plan: {
      projectId: project.id,
      projectName: project.name,
      workerName,
      repo,
      packageManager: detectPackageManager(files, pkg),
      adapterId: adapter?.id ?? null,
      support,
      nextCache: "kv",
      env: env.plan,
      vercelJson: translateVercelJson(vercelJsonRaw),
      storage: detectStorage({ envKeys: envVars.map((v) => v.key), dependencies }),
      features: detectVercelFeatures(dependencies),
      domains: planDomains(domains, zones),
      blockers,
      warnings,
    },
    values: env.values,
  };
}
