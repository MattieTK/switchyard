import { pickAdapter } from "../adapters/registry.ts";
import type { NextCachePreset, Support } from "../adapters/types.ts";
import type { AgentId } from "../agent/types.ts";
import { readOnlyAccountMessage, type CloudflareClient, type CloudflareZone } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { VercelClient, VercelDomain } from "../clients/vercel.ts";
import { MIGRATION_BRANCH } from "../config.ts";
import { ApiError } from "../http.ts";
import { buildEnvPlan, type EnvPlan, type EnvValues } from "../translate/env-plan.ts";
import { detectVercelFeatures, type FeatureFinding } from "../translate/features.ts";
import { allDependencies, parsePackageJson, type PackageJson } from "../translate/package-json.ts";
import {
  detectPackageManager,
  type PackageManager,
  type PnpmSwitchOffer,
  pnpmSwitchOffer,
} from "../translate/package-manager.ts";
import { detectStorage, type StorageFinding } from "../translate/storage.ts";
import { translateVercelJson, type VercelJsonTranslation } from "../translate/vercel-json.ts";

export interface DomainPlan {
  name: string;
  zone: string | null;
}

// Opt-ins the user can choose on the plan screen. All are off unless chosen.
export interface PlanOptions {
  // Also run the upgrade's optional feature-adoption codemods.
  adoptionCodemods: boolean;
  // Move from next lint to the ESLint CLI with the upgrade's codemod.
  eslintMigration: boolean;
  // Update packages the upgrade flags as incompatible to a release that supports it.
  updateFlaggedPackages: boolean;
  // Move the project to pnpm.
  switchToPnpm: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  adoptionCodemods: false,
  eslintMigration: false,
  updateFlaggedPackages: false,
  switchToPnpm: false,
};

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
  // Job files written before these existed lack them, so readers fall back to the defaults.
  // The framework upgrade conversion runs first, which the upgrade options apply to.
  upgrade?: { from: string; to: string } | null;
  pnpmSwitch?: PnpmSwitchOffer | null;
  options?: PlanOptions;
  // The project's package manager before the user chose to switch to pnpm.
  switchedFrom?: PackageManager;
  // The agent asked to recover a step that still fails, chosen when the plan was approved.
  agent?: { id: AgentId; model?: string } | null;
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
  const [envVars, domains, zones, accounts] = await Promise.all([
    d.vercel.listEnv(project.id),
    d.vercel.listDomains(project.id),
    d.cloudflare.listZones(d.accountId),
    d.cloudflare.listAccounts(),
  ]);
  const rootDirectory = (project.rootDirectory ?? "").replace(/^\/+|\/+$/g, "");
  const blockers: string[] = [];
  const account = accounts.find((a) => a.id === d.accountId);
  if (account && !account.canDeployWorkers) {
    blockers.push(`${readOnlyAccountMessage(account.name)} on the Connect page.`);
  }
  let repo: MigrationPlan["repo"] = null;
  let pkg: PackageJson | null = null;
  let files: string[] = [];
  let vercelJsonRaw: string | null = null;
  let rootListing: string[] = [];
  // Files in the project's own folder, which the adapter's planFiles are looked up in.
  let projectFiles: string[] = [];

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
      projectFiles = (rootDirectory ? dirFiles : rootFiles) ?? [];
      rootListing = rootFiles ?? [];
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
  const planFiles: Record<string, string> = {};
  if (repo && adapter?.planFiles) {
    const { owner, name, productionBranch } = repo;
    for (const file of adapter.planFiles.filter((f) => projectFiles.includes(f))) {
      const text = await d.github.getFile(owner, name, rootDirectory ? `${rootDirectory}/${file}` : file, productionBranch);
      if (text !== null) planFiles[file] = text;
    }
  }
  const warnings: string[] = [...(adapter?.planWarnings?.(pkg, planFiles) ?? [])];
  if (await d.cloudflare.getWorkerTag(d.accountId, workerName)) {
    warnings.push(
      `A Worker called ${workerName} already exists on this Cloudflare account. Deploying will replace its code and secrets. Choose another name to keep it.`,
    );
  }

  const packageManager = detectPackageManager(files, pkg);
  return {
    plan: {
      projectId: project.id,
      projectName: project.name,
      workerName,
      repo,
      packageManager,
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
      upgrade: adapter?.upgradeFor?.(pkg) ?? null,
      pnpmSwitch: repo ? pnpmSwitchOffer({ pm: packageManager, packageJson: pkg, projectFiles, rootFiles: rootListing }) : null,
      options: DEFAULT_PLAN_OPTIONS,
    },
    values: env.values,
  };
}
