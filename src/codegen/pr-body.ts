import { AGENT_LABELS } from "../agent/types.ts";
import { type AgentRun, STEP_TITLES } from "../pipeline/types.ts";
import type { FeatureFinding } from "../translate/features.ts";
import type { StorageFinding } from "../translate/storage.ts";

export interface PrBodyInput {
  projectName: string;
  productionBranch: string;
  workersDevUrl?: string;
  hasCrons: boolean;
  skippedEnv: { key: string; reason: string }[];
  manual: string[];
  features: FeatureFinding[];
  storage: StorageFinding[];
  warnings: string[];
  agentRuns?: AgentRun[];
}

const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);

// Agent runs whose changes are in the branch: those that changed files and weren't turned down.
export function keptAgentRuns(runs: readonly AgentRun[] = []): AgentRun[] {
  return runs.filter((r) => r.changedFiles.length > 0 && !r.error);
}

function agentLines(runs: AgentRun[]): string[] {
  return runs.map((r) => {
    const where = r.fixCommit ? `${STEP_TITLES[r.step]}, in commit ${r.fixCommit.slice(0, 7)}` : STEP_TITLES[r.step];
    const files = r.changedFiles.map((f) => `\`${f}\``).join(", ");
    return `- ${where}: ${r.summary || "no summary given"} (${files})`;
  });
}

export function prBody(i: PrBodyInput): string {
  const changed = [
    "- Converted the app to run on Cloudflare Workers with vinext (`vite.config.ts`, `cloudflare.config.ts` and new scripts in `package.json`).",
    "- Declared the production environment variables as Worker secrets in `cloudflare.config.ts`. Their values were uploaded to Cloudflare and are not in this PR.",
    ...(i.hasCrons ? ["- Moved Vercel Cron Jobs to Cron Triggers, run by `switchyard-entry.ts`."] : []),
  ];
  const checks = [
    i.workersDevUrl
      ? `- [ ] Check the Cloudflare deploy at ${i.workersDevUrl}`
      : "- [ ] Check the Cloudflare deploy (its workers.dev URL is in the Cloudflare dashboard)",
    ...i.manual.map((m) => `- [ ] ${m}`),
    ...i.skippedEnv.map((e) => `- [ ] \`${e.key}\` was not copied: ${e.reason}`),
    ...i.features.map((f) => `- [ ] \`${f.package}\`: ${f.note}`),
    ...i.warnings.map((w) => `- [ ] ${w}`),
  ];
  const kept = keptAgentRuns(i.agentRuns);
  // A job uses one agent, so the first run names it.
  const agent = kept[0] ? AGENT_LABELS[kept[0].agent] : null;
  if (agent) {
    checks.push(
      `- [ ] Review the changes ${agent} made. They let the build pass, but Switchyard can't tell whether the app still behaves the same.`,
    );
  }
  return [
    `This PR moves **${i.projectName}** from Vercel to Cloudflare Workers. It was prepared by Switchyard.`,
    "",
    ...section("What changed", changed),
    ...(agent
      ? section(`Changes made by ${agent}`, [
          `Switchyard asked ${agent} to recover steps that still failed after its own fixes. It changed:`,
          "",
          ...agentLines(kept),
        ])
      : []),
    ...section("Before merging", checks),
    ...section(
      "Storage",
      i.storage.map((s) => `- ${s.label}: ${s.suggestion}`),
    ),
    ...section("After merging", [
      `Workers Builds deploys \`${i.productionBranch}\` to Cloudflare on every push. Vercel keeps serving your domains until you run the cut-over in Switchyard.`,
      "",
      "Other branches are built on Cloudflare to check they compile, but are not deployed at this point.",
    ]),
  ].join("\n");
}
