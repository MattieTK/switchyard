import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  responseText,
  type FunctionCallOutput,
  type FunctionTool,
  type InputItem,
  type OpenAIClient,
  type ResponseItem,
} from "../clients/openai.ts";
import type { RunResult } from "../exec.ts";
import { addCommand, installEnv } from "../translate/package-manager.ts";
import { STEP_INFO } from "./step-info.ts";
import { requireOutput } from "./steps/shared.ts";
import type { StepContext } from "./types.ts";

// A failed command for OpenAI to fix.
export interface RepairTask {
  // What failed, for the model and the pull request, such as "the local build".
  what: string;
  // The command's output, or the Workers Builds log.
  output: string;
  // The project's folder, where packages are added. The model can read and change files
  // anywhere in the working copy, and nowhere else.
  projectDir: string;
  // Runs the failed command again.
  verify(): Promise<RunResult>;
  // Facts about where the command failed that help find the cause.
  notes?: string[];
}

export interface RepairResult {
  fixed: boolean;
  model: string;
  // The model's account of what was wrong and what it changed, or why it stopped.
  summary: string;
  // Files the model changed, relative to the working copy.
  changed: string[];
  // The passing run, when fixed.
  passed?: RunResult;
}

// Each turn is one request to OpenAI. Checks run the failed command again, which can be a
// long build or a deploy, so they're limited separately.
const MAX_TURNS = 40;
const MAX_CHECKS = 6;
// How much of a command's output the model sees: the end, where errors are.
const OUTPUT_TAIL = 16_000;
const MAX_FILE = 120_000;
const MAX_LISTED = 400;

class ToolError extends Error {}

const tail = (text: string, max = OUTPUT_TAIL) =>
  text.length > max ? `[${text.length - max} earlier characters left out]\n${text.slice(-max)}` : text;

function describeRun(r: RunResult): string {
  return `Exit code ${r.code}.${r.code === 0 ? " It succeeded." : ""}\n\n${tail(r.output)}`;
}

// Files that hold secret values the model must not see.
const isSecretFile = (name: string) => name === ".dev.vars" || (/^\.env(\..+)?$/.test(name) && !name.endsWith(".example"));

// A package to add, optionally with a version or range. Nothing that could pass as an option.
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*|-]+)?$/i;

const string = (description: string) => ({ type: "string", description });
const tool = (name: string, description: string, properties: Record<string, unknown>): FunctionTool => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  strict: true,
});

function tools(task: RepairTask): FunctionTool[] {
  return [
    tool("list_files", "Lists the files in a folder of the repository and its subfolders, except ignored ones.", {
      path: string('A folder relative to the repository root; "" for the root.'),
    }),
    tool("search", "Searches the repository's files for a regular expression (git grep -E) and returns matching lines.", {
      pattern: string("An extended regular expression."),
      path: string('A folder or file to search in, relative to the repository root; "" for everything.'),
    }),
    tool("read_file", "Returns a file's contents. Files in node_modules can be read too.", {
      path: string("Relative to the repository root."),
    }),
    tool(
      "replace_in_file",
      "Replaces text in a file. old_text must appear exactly once; include enough surrounding lines to make it unique.",
      { path: string("Relative to the repository root."), old_text: string("The exact text to replace."), new_text: string("The text to put in its place.") },
    ),
    tool("write_file", "Creates a file, or replaces all of an existing file's contents.", {
      path: string("Relative to the repository root."),
      content: string("The whole file."),
    }),
    tool("add_packages", "Adds npm packages to the project's package.json and installs them with its package manager.", {
      packages: { type: "array", items: { type: "string" }, description: "Package names, each optionally with @version." },
      dev: { type: "boolean", description: "Add them as development dependencies." },
    }),
    tool("run_check", `Runs ${task.what} again and returns its exit code and the end of its output.`, {}),
    tool("finish", "Ends the repair. Call it once, last.", {
      fixed: { type: "boolean", description: "Whether run_check passes with your changes." },
      summary: string(
        "For the pull request's reviewer, one to three sentences: what caused the failure and what you changed, or why it can't be fixed in the code and what the user should do.",
      ),
    }),
  ];
}

function instructions(ctx: StepContext, task: RepairTask, repoDir: string): string {
  const { plan } = ctx.job;
  const where = relative(repoDir, task.projectDir);
  return [
    `You fix a failed step of a migration from Vercel to Cloudflare Workers. Switchyard converted ${plan.projectName}, a ${plan.adapterLabel ?? "web"} project, to run on Workers with cf, the Cloudflare CLI, in this git working copy, and ${task.what} failed. Find the cause and change the project so it succeeds.`,
    "",
    `- The project uses ${plan.packageManager}${where ? ` and lives in ${where}/` : ""}. Paths you pass to tools are relative to the repository root.`,
    "- Make the smallest change that fixes the cause. Keep the app's behaviour: don't remove pages, routes or features, and don't turn off type checking or linting to get past an error.",
    "- Read a file before changing it, and prefer replace_in_file for small edits.",
    "- After changing anything, call run_check. Once it passes, call finish with fixed set to true. If it still fails, keep going from its output.",
    "- If the cause isn't in the code, such as missing credentials, an account limit, a network error or an outage, change nothing and call finish with fixed set to false, saying what the user should do.",
    "- *** stands for a secret value Switchyard hid. Never write *** into a file.",
    ...(task.notes ?? []).map((n) => `- ${n}`),
    "",
    migrationContext(ctx, repoDir),
  ].join("\n");
}

// Outputs of earlier steps worth telling the model about, by what they mean.
const CONTEXT_OUTPUTS: Record<string, string> = {
  branch: "branch",
  prUrl: "pull request",
  workersDevUrl: "deployed at",
  buildUrl: "build",
};

// Where the migration is: the steps done and what they produced, the one that failed, those still
// to run, and so where the model's changes end up.
export function migrationContext(ctx: StepContext, repoDir: string): string {
  const { plan, steps } = ctx.job;
  const current = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "failed");
  const at = current ? steps.indexOf(current) : steps.length;
  const line = (i: number) => {
    const s = steps[i]!;
    const outputs = Object.entries(s.outputs).flatMap(([k, v]) => (CONTEXT_OUTPUTS[k] ? [`${CONTEXT_OUTPUTS[k]}: ${v}`] : []));
    return `${i + 1}. ${STEP_INFO[s.id].title}. ${STEP_INFO[s.id].does}${outputs.length ? ` (${outputs.join("; ")})` : ""}`;
  };
  const repo = plan.repo;
  const pushed = steps.find((s) => s.id === "push")?.status === "done";
  const prUrl = steps.find((s) => s.id === "pr")?.outputs.prUrl;
  const destination = pushed
    ? `The branch is already on GitHub${prUrl ? ` and the pull request is open at ${prUrl}` : ""}. Once your fix passes, Switchyard commits your changes as a new commit on cloudflare-migration, pushes it${prUrl ? ", comments on the pull request" : ""} and runs this step again.`
    : `Your changes stay in this working copy until the push step commits them to cloudflare-migration with the rest of the conversion, and the pull request lists them for review.${repo ? ` Nothing reaches ${repo.productionBranch} until someone merges that pull request.` : ""}`;
  return [
    "Where the migration is:",
    `Switchyard is moving the Vercel project ${plan.projectName}${repo ? ` (github.com/${repo.owner}/${repo.name}, production branch ${repo.productionBranch})` : ""} to the Cloudflare Worker ${plan.workerName}. The working copy is ${repoDir}, on the cloudflare-migration branch.`,
    "",
    "Steps done:",
    ...(at > 0 ? steps.slice(0, at).map((_, i) => line(i)) : ["None."]),
    "",
    "The step that failed, which you're fixing:",
    current ? line(at) : "Unknown.",
    "",
    "Steps still to run after your fix:",
    ...(at + 1 < steps.length ? steps.slice(at + 1).map((_, i) => line(at + 1 + i)) : ["None. This is the last step."]),
    "",
    `Where your changes go: ${destination}`,
  ].join("\n");
}

// Says in the log how the user can have OpenAI fix a failure, for a plan that didn't opt in.
export async function logFixWithAIHint(ctx: StepContext): Promise<void> {
  const signedIn = (await ctx.deps.openai().catch(() => null)) !== null;
  ctx.log(
    signedIn
      ? "Select Fix with AI on this page to have OpenAI try to fix this."
      : "Sign in with ChatGPT on the Connect page to have OpenAI try to fix this, then select Fix with AI.",
  );
}

// Asks OpenAI to fix a failed command when the plan opted in, by letting the model read and
// change the working copy and run the command again. Returns null when it doesn't apply.
export async function repairWithAI(ctx: StepContext, task: RepairTask): Promise<RepairResult | null> {
  if (!ctx.job.plan.options?.aiRepair) {
    await logFixWithAIHint(ctx);
    return null;
  }
  const openai = await ctx.deps.openai();
  if (!openai) {
    ctx.log("OpenAI isn't connected any more, so it can't fix this. Sign in with ChatGPT on the Connect page, then select Fix with AI.");
    return null;
  }
  const repoDir = requireOutput(ctx, "clone", "dir");
  ctx.log(`Asking OpenAI (${openai.model}) to fix ${task.what}`);
  try {
    const result = await converse(ctx, task, repoDir, openai.client, openai.model);
    ctx.log(`${result.fixed ? "OpenAI fixed it" : "OpenAI didn't fix it"}: ${result.summary}`);
    return result;
  } catch (e) {
    // The original failure is what the user needs to see, so OpenAI's own errors only go in the log.
    const message = e instanceof Error ? e.message : String(e);
    ctx.log(`OpenAI couldn't help: ${message}`);
    return { fixed: false, model: openai.model, summary: message, changed: [] };
  }
}

async function converse(
  ctx: StepContext,
  task: RepairTask,
  repoDir: string,
  client: OpenAIClient,
  model: string,
): Promise<RepairResult> {
  const workspace = await createWorkspace(ctx, task, repoDir);
  const result = (fixed: boolean, summary: string): RepairResult => ({
    fixed,
    model,
    summary,
    changed: [...workspace.changed],
    ...(fixed && workspace.lastRun?.code === 0 ? { passed: workspace.lastRun } : {}),
  });

  // Nothing is stored at OpenAI between requests, so each one sends the whole conversation.
  const input: InputItem[] = [{ role: "user", content: ctx.redact(`${task.what} failed. Its output:\n\n${tail(task.output)}`) }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.respond({
      model,
      instructions: ctx.redact(instructions(ctx, task, repoDir)),
      input: [...input],
      tools: tools(task),
    });
    // Item ids refer to stored items, so they're left out when the output is sent back.
    input.push(...response.output.map(({ id: _id, ...item }) => item as ResponseItem));
    const text = responseText(response);
    // One log line each, since the job page shows the log line by line.
    for (const line of text.split("\n")) if (line.trim()) ctx.log(`OpenAI says: ${line}`);

    const calls = response.output.filter(isCall);
    if (!calls.length) {
      const reason = response.incomplete_details?.reason;
      return result(false, text || (reason ? `The response stopped early (${reason}).` : "It stopped without finishing."));
    }
    // Finish is handled after the other calls of the same turn, so their changes count.
    const finish = calls.find((c) => c.name === "finish");
    const outputs: FunctionCallOutput[] = [];
    for (const call of calls.filter((c) => c !== finish)) {
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: ctx.redact(await workspace.call(call)) });
    }
    if (finish) {
      const args = parseArgs(finish.arguments) as { fixed?: boolean; summary?: string };
      const summary = String(args.summary ?? "").replace(/\s+/g, " ").trim() || "No summary given.";
      if (!args.fixed) return result(false, summary);
      // Take the model's word only for a check that ran after its last change.
      if (workspace.dirty || workspace.lastRun?.code !== 0) {
        if (workspace.checksLeft === 0) return result(false, `${summary} (Not confirmed: run_check had no runs left.)`);
        const run = await workspace.check();
        if (run.code === 0) return result(true, summary);
        outputs.push({
          type: "function_call_output",
          call_id: finish.call_id,
          output: ctx.redact(`Not finished: ${task.what} still fails. ${describeRun(run)}`),
        });
      } else {
        return result(true, summary);
      }
    }
    input.push(...outputs);
  }
  return result(false, `It hadn't fixed ${task.what} after ${MAX_TURNS} turns.`);
}

const isCall = (item: ResponseItem): item is Extract<ResponseItem, { type: "function_call" }> => item.type === "function_call";

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    throw new ToolError("The arguments weren't valid JSON.");
  }
}

// The tools' side: what the model can see and change in the working copy.
async function createWorkspace(ctx: StepContext, task: RepairTask, repoDir: string) {
  const root = await realpath(repoDir);
  const changed = new Set<string>();
  let checks = 0;
  const state = { dirty: false, lastRun: null as RunResult | null };

  // A path inside the working copy, outside .git, and for writes outside node_modules too.
  // Symbolic links are followed, so a link can't lead out of the working copy.
  async function resolvePath(path: string, o: { write?: boolean } = {}): Promise<{ abs: string; rel: string }> {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError(`${path} is outside the repository.`);
    const parts = rel.split(sep);
    if (parts.includes(".git")) throw new ToolError("The .git folder is off limits.");
    if (o.write && parts.includes("node_modules")) throw new ToolError("Files in node_modules can't be changed.");
    if (isSecretFile(parts.at(-1) ?? "")) throw new ToolError(`${rel} holds secret values, which you can't read or change.`);
    let existing = abs;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = relative(root, await realpath(existing));
    if (real.startsWith("..") || isAbsolute(real)) throw new ToolError(`${path} leads outside the repository.`);
    return { abs, rel };
  }

  async function git(args: string[]): Promise<RunResult> {
    return ctx.deps.run("git", args, { cwd: root });
  }

  async function check(): Promise<RunResult> {
    checks++;
    ctx.log(`OpenAI: running ${task.what} again`);
    const run = await task.verify();
    state.lastRun = run;
    state.dirty = false;
    ctx.log(`${task.what} exited with code ${run.code}`);
    return run;
  }

  async function edit(rel: string, abs: string, text: string): Promise<void> {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
    changed.add(rel);
    state.dirty = true;
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    async list_files({ path }) {
      const { rel } = await resolvePath(String(path ?? ""));
      ctx.log(`OpenAI: listing ${rel || "the repository"}`);
      const listed = await git(["ls-files", "--cached", "--others", "--exclude-standard", "--", rel || "."]);
      const files = [...new Set(listed.stdout.split("\n").filter(Boolean))];
      const shown = files.slice(0, MAX_LISTED).join("\n");
      return files.length > MAX_LISTED ? `${shown}\n[${files.length - MAX_LISTED} more files]` : shown || "No files.";
    },
    async search({ pattern, path }) {
      const { rel } = await resolvePath(String(path ?? ""));
      ctx.log(`OpenAI: searching for ${String(pattern)}`);
      const found = await git(["grep", "--untracked", "-n", "-I", "-E", "-e", String(pattern), "--", rel || "."]);
      if (found.code === 1) return "No matches.";
      if (found.code !== 0) throw new ToolError(found.output.trim() || "git grep failed.");
      const lines = found.stdout.split("\n").filter((l) => l && !isSecretFile(l.split(":")[0]?.split("/").at(-1) ?? ""));
      return lines.length > 200 ? `${lines.slice(0, 200).join("\n")}\n[${lines.length - 200} more matches]` : lines.join("\n");
    },
    async read_file({ path }) {
      const { abs, rel } = await resolvePath(String(path));
      ctx.log(`OpenAI: reading ${rel}`);
      const text = await readFile(abs, "utf8").catch(() => {
        throw new ToolError(`${rel} doesn't exist or isn't a file.`);
      });
      return text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n[the remaining ${text.length - MAX_FILE} characters left out]` : text;
    },
    async replace_in_file({ path, old_text, new_text }) {
      const { abs, rel } = await resolvePath(String(path), { write: true });
      const text = await readFile(abs, "utf8").catch(() => {
        throw new ToolError(`${rel} doesn't exist. Use write_file to create it.`);
      });
      const old = String(old_text);
      const count = old ? text.split(old).length - 1 : 0;
      if (count !== 1) {
        throw new ToolError(count ? `old_text appears ${count} times in ${rel}. Include more of the surrounding text.` : `old_text isn't in ${rel}. Read the file again.`);
      }
      ctx.log(`OpenAI: editing ${rel}`);
      await edit(rel, abs, text.replace(old, () => String(new_text)));
      return `Changed ${rel}.`;
    },
    async write_file({ path, content }) {
      const { abs, rel } = await resolvePath(String(path), { write: true });
      const current = await readFile(abs, "utf8").catch(() => null);
      // The model saw this file with its secret values hidden, so writing it whole would lose them.
      if (current !== null && ctx.redact(current) !== current) {
        throw new ToolError(`${rel} contains secret values. Change it with replace_in_file instead.`);
      }
      ctx.log(`OpenAI: ${current === null ? "creating" : "rewriting"} ${rel}`);
      await edit(rel, abs, String(content));
      return `Wrote ${rel}.`;
    },
    async add_packages({ packages, dev }) {
      const specs = Array.isArray(packages) ? packages.map(String) : [];
      const invalid = specs.filter((p) => !PACKAGE_SPEC.test(p));
      if (!specs.length || invalid.length) throw new ToolError(`Not package names: ${invalid.join(", ") || "none given"}.`);
      const pm = ctx.job.plan.packageManager;
      const add = addCommand(pm, specs, { dev: dev === true });
      ctx.log(`OpenAI: adding ${specs.join(", ")}`);
      const run = await ctx.deps.run(add.cmd, add.args, { cwd: task.projectDir, onLine: ctx.log, env: installEnv(pm) });
      if (run.code === 0) {
        const files = await git(["status", "--porcelain", "--", task.projectDir]);
        for (const line of files.stdout.split("\n")) {
          const file = line.slice(3).trim();
          if (/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(file)) changed.add(file);
        }
        state.dirty = true;
      }
      return describeRun(run);
    },
    async run_check() {
      if (checks >= MAX_CHECKS) throw new ToolError(`run_check has run ${MAX_CHECKS} times, the most allowed. Call finish.`);
      return describeRun(await check());
    },
  };

  return {
    changed,
    get dirty() {
      return state.dirty;
    },
    get lastRun() {
      return state.lastRun;
    },
    get checksLeft() {
      return MAX_CHECKS - checks;
    },
    check,
    async call(c: { name: string; arguments: string }): Promise<string> {
      const handler = handlers[c.name];
      if (!handler) return `Error: there is no tool called ${c.name}.`;
      try {
        return await handler(parseArgs(c.arguments));
      } catch (e) {
        if (e instanceof ToolError) return `Error: ${e.message}`;
        throw e;
      }
    },
  };
}

// A line for the pull request about what OpenAI changed, for the reviewer to check.
export function repairWarning(r: RepairResult, what: string): string {
  const files = r.changed.length ? ` It changed ${r.changed.join(", ")}.` : "";
  return `${what[0]?.toUpperCase()}${what.slice(1)} failed, and OpenAI (${r.model}) fixed it: ${r.summary}${files} Review these changes before merging.`;
}
