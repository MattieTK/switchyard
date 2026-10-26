import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type CommandRunner, runOrThrow } from "../exec.ts";
import { commitIdentityArgs } from "../pipeline/steps/shared.ts";
import { AGENT_LABELS, type AgentDriver, type Verdict } from "./types.ts";

export interface RecoverInput {
  driver: AgentDriver;
  run: CommandRunner;
  repoDir: string;
  projectDir: string;
  prompt: string;
  model?: string;
  writableDirs: string[];
  protectedPaths: string[];
  // Where .dev.vars waits, outside the project, while the agent runs.
  heldDevVarsPath: string;
  // A private folder for the temporary git index used to compare the tree before and after.
  scratchDir: string;
  // Where the redacted event stream is saved.
  eventsPath: string;
  redact(text: string): string;
  log(line: string): void;
  timeoutMs: number;
  // Convert only: commit the agent's changes, so the conversion can start from them.
  commitAs?: { agentLabel: string };
}

export interface RecoverOutcome {
  verdict: Verdict;
  summary: string;
  message: string;
  changedFiles: string[];
  fixCommit?: string;
  // Set when the step shouldn't run again: why the agent's work can't be used.
  error?: string;
}

// Moves a file, copying when the two paths are on different filesystems.
async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(from, to);
    await rm(from);
  }
}

// A .dev.vars left outside the project by an interrupted run goes back, unless the project has
// a newer one, which the conversion wrote since.
export async function restoreHeldDevVars(projectDir: string, heldPath: string): Promise<void> {
  if (!existsSync(heldPath)) return;
  if (existsSync(join(projectDir, ".dev.vars"))) await rm(heldPath, { force: true });
  else await move(heldPath, join(projectDir, ".dev.vars"));
}

// Never part of a snapshot or a commit, whatever the project's .gitignore says: before
// conversion, a project may not ignore either yet. info/exclude belongs to Switchyard's working
// copy, so the project's files don't change.
const ALWAYS_EXCLUDED = [".dev.vars", "node_modules/"];

async function excludeFromSnapshots(run: CommandRunner, repoDir: string): Promise<void> {
  const path = (await runOrThrow(run, "git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoDir })).stdout.trim();
  const file = isAbsolute(path) ? path : join(repoDir, path);
  const current = await readFile(file, "utf8").catch(() => "");
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = ALWAYS_EXCLUDED.filter((p) => !lines.has(p));
  if (!missing.length) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

// The whole working tree as a git tree object, built in a temporary index so the repository's
// own index, HEAD and files are left alone. Ignored files aren't included, as they wouldn't be
// committed either.
async function snapshot(run: CommandRunner, repoDir: string, indexFile: string): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await rm(indexFile, { force: true });
  await runOrThrow(run, "git", ["read-tree", "HEAD"], { cwd: repoDir, env });
  await runOrThrow(run, "git", ["add", "-A"], { cwd: repoDir, env });
  return (await runOrThrow(run, "git", ["write-tree"], { cwd: repoDir, env })).stdout.trim();
}

// Paths that differ between two trees. Without rename detection a move shows as a deletion and
// an addition, so both paths are reported and undone; -z with quotePath off gives raw names.
async function diffPaths(run: CommandRunner, repoDir: string, from: string, to: string, filter?: string): Promise<string[]> {
  const args = ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", ...(filter ? [`--diff-filter=${filter}`] : []), from, to];
  return (await runOrThrow(run, "git", args, { cwd: repoDir })).stdout.split("\0").filter(Boolean);
}

// Puts the working tree back to a snapshot: files added since are removed and every other file
// is written as it was. The repository's own index is left alone.
async function restoreSnapshot(run: CommandRunner, repoDir: string, indexFile: string, before: string, after: string): Promise<void> {
  for (const file of await diffPaths(run, repoDir, before, after, "A")) await rm(join(repoDir, file), { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  await runOrThrow(run, "git", ["read-tree", before], { cwd: repoDir, env });
  await runOrThrow(run, "git", ["checkout-index", "--all", "--force"], { cwd: repoDir, env });
}

function minutes(ms: number): string {
  const n = Math.round(ms / 60_000);
  return `${n} minute${n === 1 ? "" : "s"}`;
}

// Runs the agent on the working copy and works out, from git rather than from the agent's own
// account, what it changed.
export async function recoverWithAgent(i: RecoverInput): Promise<RecoverOutcome> {
  const label = AGENT_LABELS[i.driver.id];
  const devVars = join(i.projectDir, ".dev.vars");
  const indexFile = join(i.scratchDir, `agent-index-${process.pid}`);

  // Before conversion the project has no .dev.vars of Switchyard's, and convert writes it again,
  // so one an interrupted run left behind is dropped rather than put into the clean checkout.
  if (i.commitAs) await rm(i.heldDevVarsPath, { force: true });
  else await restoreHeldDevVars(i.projectDir, i.heldDevVarsPath);
  await excludeFromSnapshots(i.run, i.repoDir);
  const held = existsSync(devVars);
  if (held) await move(devVars, i.heldDevVarsPath);

  let before: string;
  let after: string;
  let result;
  try {
    await mkdir(i.scratchDir, { recursive: true, mode: 0o700 });
    before = await snapshot(i.run, i.repoDir, indexFile);
    result = await i.driver.run({
      cwd: i.projectDir,
      prompt: i.prompt,
      model: i.model,
      writableDirs: i.writableDirs,
      protectedPaths: i.protectedPaths,
      timeoutMs: i.timeoutMs,
      log: i.log,
    });
    after = await snapshot(i.run, i.repoDir, indexFile);
  } finally {
    if (held) await move(i.heldDevVarsPath, devVars);
    await rm(indexFile, { force: true });
  }

  await mkdir(dirname(i.eventsPath), { recursive: true, mode: 0o700 });
  await writeFile(i.eventsPath, i.redact(result.events), { mode: 0o600 });

  const changedFiles = (await diffPaths(i.run, i.repoDir, before, after)).sort();
  const outcome: RecoverOutcome = {
    verdict: result.verdict,
    summary: i.redact(result.summary),
    message: i.redact(result.message),
    changedFiles,
  };
  const said = outcome.summary || outcome.message;

  const error = result.timedOut
    ? `${label} didn't finish within ${minutes(i.timeoutMs)}.`
    : result.verdict === "cannot-fix"
      ? `${label} couldn't fix it: ${said || "it gave no reason"}`
      : result.exitCode !== 0 && result.verdict === "no-verdict"
        ? `${label} stopped with exit code ${result.exitCode}: ${said || "it gave no reason"}`
        : !changedFiles.length
          ? `${label} made no changes Switchyard can keep.${said ? ` It said: ${said}` : ""}`
          : null;
  if (error) {
    // Work Switchyard won't use mustn't stay in the tree, where a retry would build and push it.
    if (changedFiles.length) {
      try {
        await restoreSnapshot(i.run, i.repoDir, indexFile, before, after);
      } finally {
        await rm(indexFile, { force: true });
      }
    }
    return { ...outcome, error };
  }

  // The commit holds exactly the tree Switchyard compared, so nothing outside the snapshot, such
  // as .dev.vars put back after the run, can slip in. The index then follows HEAD.
  if (i.commitAs) {
    const commit = await runOrThrow(
      i.run,
      "git",
      [
        ...(await commitIdentityArgs(i.run, i.repoDir)),
        "commit-tree",
        after,
        "-p",
        "HEAD",
        "-m",
        `fix: changes by ${i.commitAs.agentLabel} so the Cloudflare conversion succeeds`,
        "-m",
        `Made by ${i.commitAs.agentLabel} at Switchyard's request after the conversion failed.${outcome.summary ? ` ${outcome.summary}` : ""}`,
      ],
      { cwd: i.repoDir },
    );
    outcome.fixCommit = commit.stdout.trim();
    await runOrThrow(i.run, "git", ["reset", "-q", outcome.fixCommit], { cwd: i.repoDir });
  }
  return outcome;
}
