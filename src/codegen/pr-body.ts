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
}

const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);

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
  return [
    `This PR moves **${i.projectName}** from Vercel to Cloudflare Workers. It was prepared by Switchyard.`,
    "",
    ...section("What changed", changed),
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
