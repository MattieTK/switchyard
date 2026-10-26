import { type Job, STEP_TITLES, type StepId } from "../pipeline/types.ts";

// How much of a failure's output goes into the prompt. The end is kept: errors are usually last.
export const MAX_FAILURE_OUTPUT = 60_000;
const MAX_STEP_LOG_LINES = 200;

export interface FailureInfo {
  // The command that failed, or "Workers Builds" for a failed Cloudflare build.
  command: string;
  exitCode: number | null;
  // Already redacted.
  output: string;
  // The end of the Workers Builds log, already redacted.
  cloudflareLog?: string;
}

export interface PreviousAttempt {
  attempt: number;
  changedFiles: string[];
  summary: string;
  // What went wrong when the step ran again after this attempt.
  error: string;
}

export interface PromptContext {
  job: Job;
  step: StepId;
  projectDir: string;
  // The repository root, which differs from projectDir in a monorepo.
  repoDir: string;
  failure: FailureInfo;
  // This step's earlier log lines from the job log, already redacted.
  stepLog: string[];
  previous: PreviousAttempt[];
  // Names of the variables Switchyard sets when it builds. Their values are never included.
  buildVariableNames: string[];
}

// Step outputs that help the agent and hold nothing secret.
const USEFUL_OUTPUTS = ["dir", "projectDir", "buildScript", "workersDevUrl", "branch", "prUrl", "buildUrl"];

// Files Switchyard writes during conversion, which the agent must keep.
const GENERATED_FILES = ["cloudflare.config.ts", "vite.config.ts", "switchyard-entry.ts (when the project has crons)", ".dev.vars"];

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

const fence = (text: string) => {
  // A fence longer than any run of backticks in the text, so the text can't close it.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
};

function target(c: PromptContext): string {
  const { job, step, failure, projectDir } = c;
  switch (step) {
    case "convert":
      return [
        `The project folder \`${projectDir}\` holds the project as it is on \`${job.plan.repo?.productionBranch ?? "the production branch"}\`, before conversion. Switchyard's conversion failed on it.`,
        `The conversion installs dependencies with ${job.plan.packageManager}, ${job.plan.upgrade ? `upgrades Next.js from ${job.plan.upgrade.from} to ${job.plan.upgrade.to} with the official @next/codemod upgrade, ` : ""}runs \`vinext init\` and then writes the Cloudflare configuration.`,
        "Change the project so that the conversion succeeds when Switchyard runs it again. Switchyard commits your changes and runs the whole conversion again from them, so don't try to do the conversion yourself.",
      ].join(" ");
    case "deploy":
      return `The converted project in \`${projectDir}\` built, but deploying it with \`cf deploy\` failed. Change the project so the deploy succeeds. Switchyard runs the deploy again itself; you can't deploy.`;
    case "start-build":
      return `The converted project in \`${projectDir}\` builds locally, but the first Workers Builds build of the \`cloudflare-migration\` branch on Cloudflare failed. Change the project so it builds there too. Switchyard builds locally, pushes and starts the Cloudflare build again itself.`;
    default:
      return `The converted project in \`${projectDir}\` must build: \`${failure.command}\` must exit 0 in that folder. Change the project so it does. Switchyard runs the build again itself.`;
  }
}

function done(job: Job): string[] {
  const { plan } = job;
  const lines = [
    `- Project: ${plan.projectName}${plan.repo ? `, from ${plan.repo.owner}/${plan.repo.name}${plan.repo.rootDirectory ? ` (folder ${plan.repo.rootDirectory})` : ""}` : ""}, to the Cloudflare Worker \`${plan.workerName}\`.`,
    `- Framework: ${plan.adapterId ?? "unknown"}, converted with vinext to run on Cloudflare Workers.`,
  ];
  if (plan.upgrade) lines.push(`- Next.js was upgraded from ${plan.upgrade.from} to ${plan.upgrade.to}, because vinext needs Next.js 16.`);
  lines.push(
    plan.switchedFrom
      ? `- Package manager: the project was moved from ${plan.switchedFrom} to pnpm, as the user chose.`
      : `- Package manager: ${plan.packageManager}.`,
  );
  lines.push(`- Next.js caching: ${plan.nextCache === "kv" ? "vinext's KV data cache" : "none"}.`);
  const options = plan.options;
  const ticked = [
    options?.adoptionCodemods && "adoption codemods",
    options?.eslintMigration && "ESLint migration",
    options?.updateFlaggedPackages && "updates for packages the upgrade flagged",
  ].filter(Boolean);
  if (ticked.length) lines.push(`- Upgrade options the user ticked: ${ticked.join(", ")}.`);
  if (plan.vercelJson.crons.length) lines.push(`- ${plan.vercelJson.crons.length} Vercel cron job(s), run as Cron Triggers by switchyard-entry.ts.`);

  lines.push("", "Steps so far:");
  for (const s of job.steps) {
    const outputs = USEFUL_OUTPUTS.flatMap((k) => (s.outputs[k] ? [`${k}: ${s.outputs[k]}`] : []));
    lines.push(`- ${STEP_TITLES[s.id]}: ${s.status}${outputs.length ? ` (${outputs.join(", ")})` : ""}`);
  }

  const changes = job.steps.flatMap((s) => {
    try {
      return JSON.parse(s.outputs.warnings ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  if (changes.length) lines.push("", "Changes and warnings Switchyard recorded:", ...changes.map((w) => `- ${w}`));
  return lines;
}

export function agentPrompt(c: PromptContext): string {
  const { failure } = c;
  const sections = [
    `You are helping Switchyard move a Vercel project to Cloudflare Workers. Switchyard did most of the work and its own fixes have run out, so it is asking you to recover one step: "${STEP_TITLES[c.step]}".`,
    "",
    "## What has to pass",
    "",
    target(c),
    "",
    "## What Switchyard has done",
    "",
    ...done(c.job),
    "",
    `Switchyard generated ${GENERATED_FILES.join(", ")}. Keep them; fix the project around them.`,
  ];
  if (c.buildVariableNames.length) {
    sections.push(
      "",
      `When Switchyard builds, it sets these environment variables: ${c.buildVariableNames.join(", ")}. You don't have their values, so a build you run yourself may fail on them. That isn't the failure to fix.`,
    );
  }
  sections.push(
    "",
    "## The failure",
    "",
    failure.exitCode === null ? `\`${failure.command}\` failed.` : `\`${failure.command}\` exited with code ${failure.exitCode}. Its output ends with:`,
    "",
    fence(tail(failure.output, MAX_FAILURE_OUTPUT)),
  );
  if (failure.cloudflareLog) sections.push("", "The Workers Builds log ends with:", "", fence(tail(failure.cloudflareLog, MAX_FAILURE_OUTPUT)));
  if (c.stepLog.length) {
    sections.push("", "Earlier lines from this step's log:", "", fence(c.stepLog.slice(-MAX_STEP_LOG_LINES).join("\n")));
  }
  if (c.previous.length) {
    sections.push("", "## Earlier attempts", "");
    for (const p of c.previous) {
      sections.push(
        `- Attempt ${p.attempt} changed ${p.changedFiles.length ? p.changedFiles.join(", ") : "nothing"}${p.summary ? ` (${p.summary})` : ""}. The step then failed again: ${p.error}`,
      );
    }
  }
  sections.push(
    "",
    "## Rules",
    "",
    c.repoDir === c.projectDir
      ? `- Change files only inside \`${c.projectDir}\`.`
      : `- Change files only inside the repository \`${c.repoDir}\`, and outside the project folder \`${c.projectDir}\` only for workspace files such as the root package.json, lockfile or pnpm-workspace.yaml.`,
    "- Don't read Switchyard's own folder (~/.config/switchyard or SWITCHYARD_HOME): it holds credentials and saved values.",
    "- Don't commit, push or deploy, and don't run `cf deploy`.",
    "- Don't add environment variables or secrets, and don't remove or weaken what Switchyard generated.",
    "- Make the smallest change that fixes the cause, and keep the app behaving as it did on Vercel.",
    "- If the cause is outside the code, such as missing credentials, account permissions or a value only the user has, stop and say so.",
    "",
    "End your reply with exactly one of these lines, on its own:",
    "",
    "SWITCHYARD: fixed – <one sentence on what you changed>",
    "SWITCHYARD: cannot fix – <reason>",
  );
  return sections.join("\n");
}
