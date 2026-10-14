import type { TriggerVariables } from "../clients/cloudflare.ts";
import type { VercelEnvVar, VercelTarget } from "../clients/vercel.ts";

export type EnvDestination = "production-build" | "preview-build" | "runtime-secret" | "dev-vars";

export interface EnvPlanEntry {
  id: string;
  key: string;
  targets: VercelTarget[];
  vercelType: VercelEnvVar["type"];
  hasValue: boolean;
  needsInput: boolean;
  isSecret: boolean;
  destinations: EnvDestination[];
  skipReason?: string;
}

export interface EnvPlan {
  entries: EnvPlanEntry[];
  warnings: string[];
}

// Values are kept apart from the plan so the plan can be persisted and sent
// to the browser without ever containing a secret.
export type EnvValues = Record<string, string>;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function destinationsFor(targets: readonly VercelTarget[]): EnvDestination[] {
  const out: EnvDestination[] = [];
  if (targets.includes("production")) out.push("production-build", "runtime-secret");
  if (targets.includes("preview")) out.push("preview-build");
  if (targets.includes("development")) out.push("dev-vars");
  return out;
}

function skipReasonFor(v: VercelEnvVar, reserved: readonly string[]): string | undefined {
  if (v.type === "system") return "Vercel system variable – Cloudflare doesn't provide an equivalent";
  if (v.gitBranch) {
    return `Preview value for the ${v.gitBranch} branch only – Workers Builds can't scope variables to one branch`;
  }
  if (!KEY_PATTERN.test(v.key)) return "Not a valid binding name on Cloudflare (letters, digits and _ only)";
  if (reserved.includes(v.key)) return "Name is already used by a binding the converter creates";
  return undefined;
}

export function buildEnvPlan(vars: VercelEnvVar[], reserved: readonly string[]): { plan: EnvPlan; values: EnvValues } {
  const values: EnvValues = {};
  const warnings: string[] = [];
  const entries = vars.map((v): EnvPlanEntry => {
    const skipReason = skipReasonFor(v, reserved);
    const hasValue = typeof v.value === "string";
    if (hasValue && !skipReason) values[v.id] = v.value as string;
    const needsInput = !skipReason && !hasValue;
    if (needsInput && v.type !== "sensitive") {
      warnings.push(
        `Vercel returned no value for ${v.key} (${v.type}). Enter it below, or check that the Vercel token can read this project's variables.`,
      );
    }
    return {
      id: v.id,
      key: v.key,
      targets: v.target,
      vercelType: v.type,
      hasValue,
      needsInput,
      isSecret: v.type !== "plain",
      destinations: skipReason ? [] : destinationsFor(v.target),
      ...(skipReason ? { skipReason } : {}),
    };
  });
  return { plan: { entries, warnings }, values };
}

export function skipEntries(plan: EnvPlan, ids: readonly string[]): EnvPlan {
  return {
    ...plan,
    entries: plan.entries.map((e) =>
      ids.includes(e.id) ? { ...e, destinations: [], needsInput: false, skipReason: "Skipped by you" } : e,
    ),
  };
}

export function missingInputs(plan: EnvPlan, values: EnvValues): EnvPlanEntry[] {
  return plan.entries.filter((e) => e.needsInput && !values[e.id]);
}

function withValues(plan: EnvPlan, values: EnvValues, destination: EnvDestination) {
  return plan.entries.flatMap((e) => {
    const value = values[e.id];
    return e.destinations.includes(destination) && value !== undefined ? [{ entry: e, value }] : [];
  });
}

export function triggerVariables(plan: EnvPlan, values: EnvValues, which: "production" | "preview"): TriggerVariables {
  const out: TriggerVariables = {};
  for (const { entry, value } of withValues(plan, values, `${which}-build`)) {
    out[entry.key] = { value, is_secret: entry.isSecret };
  }
  return out;
}

export function runtimeSecrets(plan: EnvPlan, values: EnvValues): Record<string, string> {
  return Object.fromEntries(withValues(plan, values, "runtime-secret").map(({ entry, value }) => [entry.key, value]));
}

export function devVarsFile(plan: EnvPlan, values: EnvValues): string {
  return withValues(plan, values, "dev-vars")
    .map(({ entry, value }) => `${entry.key}=${JSON.stringify(value)}\n`)
    .join("");
}

export function secretKeys(plan: EnvPlan): string[] {
  return [...new Set(plan.entries.filter((e) => e.destinations.includes("runtime-secret")).map((e) => e.key))];
}
