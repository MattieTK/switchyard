# Agent recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When convert, build, deploy or the first Cloudflare build still fails after Switchyard's own repairs, optionally hand the failure to the user's own Claude Code or Codex CLI, then re-run the step.

**Architecture:** A new `src/agent/` module holds two CLI drivers behind one `AgentDriver` interface, a pure prompt builder, a preferences store and the recovery routine (hold `.dev.vars`, run, diff with git, commit the convert fix layer). The runner gains a recovery branch in its catch block and an index-based loop so it can re-run from an earlier step. The plan, service, PR body and web UI carry the choice and the record of agent runs.

**Tech Stack:** Node 22.18+ (TypeScript run directly), Hono, zod, React 19, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-agent-recovery-design.md`

## Global Constraints

- No API keys: never read, pass or store `ANTHROPIC_API_KEY`, `CODEX_API_KEY` or session tokens; never use `claude --bare`.
- Codex always gets `-c forced_login_method="chatgpt"`.
- Recovery is off unless `plan.agent` is set; with it unset, behaviour is unchanged.
- Covered steps: `convert`, `build`, `deploy`, `start-build`. Attempts: `MAX_AGENT_ATTEMPTS = 2` per step per runner invocation. Agent time limit: `AGENT_TIMEOUT_MS = 15 * 60_000`.
- Verdict line: `SWITCHYARD: fixed` or `SWITCHYARD: cannot fix – <reason>` (accept `-` or `–`).
- Output in prompts is capped at `MAX_FAILURE_OUTPUT = 60_000` characters, taken from the end.
- Copy uses British English, sentence case, and en dashes with spaces.
- Match existing code style: small pure functions, comments only where the why isn't obvious.

## Review Focus

- An agent CLI that waits for input or hangs: stdin is closed after the prompt and the whole process group is killed at the time limit.
- An agent that changes only ignored files (for example inside `node_modules`): git sees no change, so the step fails with "made no changes Switchyard can keep" instead of re-running.
- Switchyard stopped during an agent run: the held `.dev.vars` is restored before the next agent run, and the job is recovered as failed as today.
- Secrets in failure output: the prompt builder only ever receives redacted text, and a test passes a known secret through the recovery path to check it never reaches the driver.
- A retry after a convert recovery: convert resets to `job.fixBase`, so the agent's commit survives `git reset --hard` and `git clean -fdx`.

---

### Task 1: Spike – record real agent event streams

**Files:**
- Create: `tests/fixtures/agent/claude-stream.jsonl`, `tests/fixtures/agent/codex-stream.jsonl`
- Modify: `docs/spikes.md` (new "Spike 8" section)

- [ ] Make a throwaway Node project in `$CLAUDE_JOB_DIR/tmp/agent-spike` with a `build` script that fails (`node -e "require('./missing')"`), `git init` it.
- [ ] Run `claude -p --output-format stream-json --verbose --permission-mode dontAsk --allowedTools Read Edit Write Glob Grep Bash --strict-mcp-config --no-session-persistence --max-turns 20 --model haiku` with a short prompt on stdin asking it to fix the build and end with the verdict line. Save stdout.
- [ ] Run `codex exec --json -s workspace-write -C <dir> --skip-git-repo-check --ephemeral -c sandbox_workspace_write.network_access=true -c forced_login_method="chatgpt" -` with the same prompt. Save stdout.
- [ ] Check Claude with `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` on this machine (no socat) to confirm how it fails.
- [ ] Trim each stream to the event types that matter, replace the email, org id and session ids with placeholders, save as fixtures.
- [ ] Record findings (event shapes, verdict, sandbox behaviour) in `docs/spikes.md`. Commit `docs: record the agent CLI spike`.

### Task 2: CommandRunner `input` and `killGroup`

**Files:** Modify `src/exec.ts`; Test `tests/exec.test.ts`

**Produces:** `RunOptions.input?: string` (written to stdin, then closed; stdin stays `"ignore"` without it) and `RunOptions.killGroup?: boolean` (spawn `detached`, and on timeout `process.kill(-child.pid, "SIGTERM")`, then SIGKILL after 5 s).

- [ ] Test: `run("node", ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" })` returns stdout `hello`.
- [ ] Test: with `killGroup` and `timeoutMs: 300`, a `sh -c "sleep 30 & sleep 30"` returns within 3 s and its background child is gone (`process.kill(pid, 0)` throws).
- [ ] Implement, run `pnpm vitest run tests/exec.test.ts`, commit `feat: let commands take stdin and stop with their child processes`.

### Task 3: Agent types, verdicts, status and drivers

**Files:**
- Create: `src/agent/types.ts`, `src/agent/verdict.ts`, `src/agent/claude.ts`, `src/agent/codex.ts`, `src/agent/drivers.ts`
- Test: `tests/agent/verdict.test.ts`, `tests/agent/claude.test.ts`, `tests/agent/codex.test.ts`

**Produces:**

```ts
// src/agent/types.ts
export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const AGENT_LABELS: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };
export interface AgentStatus {
  id: AgentId;
  installed: boolean;
  signedIn: boolean;
  // Plain sentence for the UI, e.g. "Signed in with your Claude subscription (Max)".
  detail: string;
  // Claude only: whether its Bash sandbox can start, and why not.
  sandbox?: { available: boolean; detail: string };
}
export interface AgentRequest {
  cwd: string;
  prompt: string;
  model?: string;
  // Extra writable folders, such as the package manager's cache.
  writableDirs: string[];
  timeoutMs: number;
  log(line: string): void;
}
export type Verdict = "fixed" | "cannot-fix" | "no-verdict";
export interface AgentResult {
  verdict: Verdict;
  // The agent's last message, without the verdict line.
  message: string;
  // The raw JSONL the CLI printed, for the debug file.
  events: string;
  exitCode: number;
  timedOut: boolean;
}
export interface AgentDriver {
  id: AgentId;
  status(): Promise<AgentStatus>;
  run(req: AgentRequest): Promise<AgentResult>;
}
```

- `parseVerdict(text: string): { verdict: Verdict; message: string; reason?: string }` in `verdict.ts` – last matching line wins; `cannot fix` reason after the dash.
- `claudeDriver(run: CommandRunner, opts?: { platform?: NodeJS.Platform; which?: (cmd: string) => Promise<boolean> }): AgentDriver`
- `codexDriver(run: CommandRunner): AgentDriver`
- `claudeArgs(req, sandbox: boolean): string[]`, `codexArgs(req): string[]` exported for tests.
- `claudeLogLines(event: unknown): string[]`, `codexLogLines(event: unknown): string[]` – map one parsed JSON event to `Agent:` lines.
- `createAgentDrivers(run): Record<AgentId, AgentDriver>` in `drivers.ts`.

- [ ] Tests for `parseVerdict`: fixed; cannot fix with en dash and hyphen; no verdict; verdict not on last line still found; message excludes the verdict line.
- [ ] Tests for Claude status: `claude auth status` JSON `{loggedIn:true, authMethod:"claude.ai", subscriptionType:"max"}` → signed in, detail "Signed in with your Claude subscription (Max)"; `authMethod:"api_key"` → detail mentions the key is billed; exit 1 → not signed in, "run claude, then /login"; runner rejecting "Couldn't start" → not installed. Sandbox: linux without socat → unavailable, detail "install socat"; darwin → available.
- [ ] Tests for `claudeArgs`: contains `-p`, `stream-json`, `--verbose`, `dontAsk`, `--strict-mcp-config`, `--no-session-persistence`, never `--bare`; `--model` only when set; `--settings` JSON with `sandbox.enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, writable dirs, only when sandbox true.
- [ ] Tests for Claude `run` with the fake runner returning the fixture: log lines include `Agent: edited <path>` and `Agent: ran <command>`; verdict parsed from the `result` event; prompt passed as `input`; `killGroup: true`; `timeoutMs` passed through.
- [ ] The same for Codex: status from `codex login status` stderr ("Logged in using ChatGPT", "API key configured", exit 1, not installed); args include `--json`, `workspace-write`, `forced_login_method="chatgpt"`, `network_access=true`, `-C <cwd>`, `--add-dir` per writable dir, `-m` only when set, last arg `-`; run maps `file_change`, `command_execution`, `agent_message`, and takes the verdict from the last `agent_message`.
- [ ] Implement, run `pnpm vitest run tests/agent`, commit `feat: drive Claude Code and Codex from their own CLIs`.

### Task 4: Preferences and the agents API

**Files:**
- Create: `src/agent/preferences.ts`, `src/agent/models.ts`, `src/server/routes/agents.ts`
- Modify: `src/paths.ts` (`preferencesFile`), `src/server/app.ts`, `src/server/main.ts`
- Test: `tests/agent/preferences.test.ts`, `tests/agent/models.test.ts`, `tests/server/agents.test.ts`, `tests/paths.test.ts`

**Produces:**

```ts
export interface AgentPreferences { preferred: AgentId | null; models: Partial<Record<AgentId, string>> }
export interface PreferencesStore { read(): Promise<AgentPreferences>; write(p: AgentPreferences): Promise<AgentPreferences> }
export function createPreferencesStore(file: string): PreferencesStore; // missing or invalid file → defaults
export function modelSuggestions(home?: string): Promise<Record<AgentId, string[]>>; // claude: ["opus","sonnet","haiku"]; codex: models_cache.json visibility "list"
```

Routes (behind the same token guard as other `/api` routes): `GET /api/agents` → `{ agents: AgentStatus[], preferences, suggestions }`; `PUT /api/agents/preferences` with zod `{ preferred: enum|null, models: { claude?: string(max 100, /^[\w.:\-\[\]]*$/), codex?: same } }`.

- [ ] Tests: store defaults, round trip, invalid JSON → defaults; suggestions with a temp HOME holding a models cache (only `visibility: "list"`), and with none; route returns statuses from fake drivers; PUT rejects an unknown agent and a model with spaces.
- [ ] Implement, run the tests, commit `feat: keep a preferred agent and model per agent`.

### Task 5: The prompt builder

**Files:** Create `src/agent/prompt.ts`; Test `tests/agent/prompt.test.ts`

**Produces:**

```ts
export interface FailureInfo { command: string; exitCode: number | null; output: string; cloudflareLog?: string }
export interface PreviousAttempt { attempt: number; changedFiles: string[]; message: string; error: string }
export interface PromptContext {
  job: Job; step: StepId; projectDir: string; target: string;
  failure: FailureInfo; stepLog: string[]; previous: PreviousAttempt[]; buildVariableNames: string[];
}
export function agentPrompt(c: PromptContext): string;
export function stepTarget(job: Job, step: StepId, buildCommand: string): string;
export const AGENT_RULES: string;
```

- [ ] Tests: includes project name, step and target; lists upgrade, package manager, switch, cache, ticked options, passed steps' non-secret outputs (`workersDevUrl`, `projectDir`) and warnings from convert/build outputs; includes variable names but no values (pass a plan whose env has a value and check it's absent); output trimmed from the end to `MAX_FAILURE_OUTPUT`; includes the Cloudflare log when given; previous attempts listed; convert target says the folder is the project before conversion; rules and verdict format present.
- [ ] Implement, run, commit `feat: tell the agent what Switchyard did and what failed`.

### Task 6: Running a recovery

**Files:** Create `src/agent/recover.ts`; Test `tests/agent/recover.test.ts`

**Produces:**

```ts
export interface AgentRun {
  step: StepId; agent: AgentId; model?: string; attempt: number; verdict: Verdict;
  message: string; changedFiles: string[]; startedAt: string; fixCommit?: string; rerunPassed?: boolean;
}
export interface RecoverInput {
  driver: AgentDriver; run: CommandRunner; repoDir: string; projectDir: string; prompt: string;
  model?: string; writableDirs: string[]; heldDevVarsPath: string; eventsPath: string;
  redact(text: string): string; log(line: string): void; timeoutMs: number;
  // Convert only: commit the changes on top of the current HEAD.
  commitAs?: { agentLabel: string };
}
export interface RecoverOutcome { verdict: Verdict; message: string; changedFiles: string[]; fixCommit?: string; error?: string }
export async function recoverWithAgent(i: RecoverInput): Promise<RecoverOutcome>;
export async function restoreHeldDevVars(projectDir: string, heldPath: string): Promise<void>;
export function changedPaths(before: string, after: string): string[]; // from two `git status --porcelain` outputs
```

- [ ] Tests in a temp git repo with a fake driver that writes a file: `.dev.vars` is absent while the driver runs and restored after (also when the driver throws); a held file from a crash is restored first; `changedFiles` lists the new and modified files, and a file the driver didn't touch but was already dirty isn't listed; no changes → outcome with `error` "made no changes Switchyard can keep"; with `commitAs`, a commit exists with message `fix: changes by Claude so the Cloudflare conversion succeeds` and `fixCommit` is its SHA; raw events are redacted before being written to `eventsPath` (driver returns a secret in `events`); a timed-out run returns `error` "Claude didn't finish within 15 minutes".
- [ ] Implement, run, commit `feat: run an agent on a working copy and keep what it changed`.

### Task 7: Recovery in the runner

**Files:**
- Modify: `src/pipeline/types.ts` (`Job.agentRuns?`, `Job.fixBase?`, `PipelineDeps.agents?`, `PipelineDeps.jobsDir?`), `src/pipeline/runner.ts`, `src/pipeline/steps/repo.ts` (convert reset base), `src/pipeline/steps/builds.ts` (`BuildFailedError` with the log), `src/clients/cloudflare.ts` (`getBuildLogs`), `src/server/main.ts`
- Create: `src/pipeline/recovery.ts` (step table and eligibility)
- Test: `tests/pipeline/runner.test.ts`, `tests/pipeline/recovery.test.ts`, `tests/pipeline/steps/repo.test.ts`, `tests/pipeline/steps/builds.test.ts`, `tests/clients/cloudflare.test.ts`

**Produces:**

```ts
// src/pipeline/recovery.ts
export const RECOVERABLE: Partial<Record<StepId, { rerunFrom: StepId; mode: "in-place" | "fix-layer" }>> = {
  convert: { rerunFrom: "convert", mode: "fix-layer" },
  build: { rerunFrom: "build", mode: "in-place" },
  deploy: { rerunFrom: "deploy", mode: "in-place" },
  "start-build": { rerunFrom: "build", mode: "in-place" },
};
export function failureInfo(e: unknown): FailureInfo | null; // CommandError or BuildFailedError, else null
export const MAX_AGENT_ATTEMPTS = 2;
export const AGENT_TIMEOUT_MS = 15 * 60_000;
// PipelineDeps.agents: Record<AgentId, AgentDriver>
```

Runner changes: loop by index; in the generic-error branch, when `job.plan.agent` is set, `RECOVERABLE[step.id]` exists, `failureInfo(e)` isn't null and attempts for the step are below the limit, call a `recover` helper that builds the prompt (redacted output, the step's log lines from this run, previous attempts for this step), runs `recoverWithAgent`, pushes an `AgentRun`, publishes, and on success sets `job.fixBase` (fix layer), resets the steps from `rerunFrom` to the current one to pending with empty outputs, and moves the index back. When the step after a recovery passes, mark the last run `rerunPassed: true`. When recovery declines, the step fails with the original error plus ` <Agent> couldn't fix it: <message>`.

Convert: `await local(["reset", "--hard", ctx.job.fixBase ?? `origin/${repo.productionBranch}`])`.

start-build: on failure, fetch `cf.getBuildLogs(accountId, buildUuid)` (best effort) and throw `BuildFailedError(message, logText)`.

- [ ] Tests (runner, with a fake step and a fake driver in `pipeline.agents`): no `plan.agent` → fails as today, driver never called; a build step failing with `CommandError` once then passing after the driver writes a file → job done, one `AgentRun` with `rerunPassed: true`; `cannot-fix` → step failed, error contains the agent's reason, one attempt; always failing → exactly 2 attempts then failed; a plain `Error` → no recovery; `PauseError` → paused, no recovery; start-build failing → build re-runs before start-build; prompt given to the driver contains `***` instead of the secret value from the job's values.
- [ ] Tests: convert resets to `fixBase` when set; start-build throws `BuildFailedError` with the log text; `getBuildLogs` joins the API's `lines` (`[[timestamp, text]]`) into text.
- [ ] Implement, run `pnpm test`, commit `feat: let an agent recover a failed step, then run it again`.

### Task 8: Choosing the agent for a job

**Files:** Modify `src/pipeline/plan.ts` (`MigrationPlan.agent?: { id: AgentId; model?: string } | null`), `src/pipeline/service.ts` (`StartInput.agent?`, validation through `agentStatus` dep and preferences), `src/server/routes/jobs.ts` (zod `agent`), `src/server/main.ts`; Test `tests/pipeline/service.test.ts`, `tests/server/jobs.test.ts`

- [ ] Tests: start with `agent: "claude"` when Claude is signed in → `plan.agent = { id: "claude", model: <preference> }`; with an unavailable agent → `UserInputError` "Claude isn't signed in"; with none → `plan.agent` null; route rejects `agent: "gpt"`.
- [ ] Implement, run, commit `feat: let the user choose an agent to recover failed steps`.

### Task 9: The pull request lists agent changes

**Files:** Modify `src/codegen/pr-body.ts`, `src/pipeline/steps/release.ts`, `src/clients/github.ts` (`updatePr`); Test `tests/codegen/codegen.test.ts`, `tests/pipeline/steps/release.test.ts`, `tests/clients/github.test.ts`

- [ ] Tests: `prBody` with `agentRuns` that changed files renders "## Changes made by Claude" with step, message and files, plus the review checklist item; runs with no files are left out; the pr step updates an existing PR's body when the job has agent runs that changed files, and leaves it alone otherwise.
- [ ] Implement, run, commit `feat: list the changes an agent made in the pull request`.

### Task 10: Web UI

**Files:** Modify `web/src/pages/Connect.tsx` (Agents card), `web/src/pages/PlanReview.tsx` (Recovery card), `web/src/pages/Job.tsx` (agent runs under steps, `Agent:` log style), `web/src/styles.css`, `web/src/api.ts` if needed

- [ ] Agents card: list each agent's status and sandbox detail, a preferred-agent radio (None, Claude, Codex; unavailable ones disabled), a model text input per agent with a `<datalist>` of suggestions, Save.
- [ ] Recovery card on the plan screen: a checkbox "If a step still fails, ask an agent to fix it" and a select of available agents defaulting to the preferred one; hidden note when no agent is available ("Set up Claude Code or Codex on the Connect page"). Sends `agent` with the approve request.
- [ ] Job page: under each step, its agent runs ("Claude, attempt 1: fixed – changed vite.config.ts"); `Agent:` lines get `log-agent`.
- [ ] Run `pnpm typecheck` and `pnpm build:web`, commit `feat: show agent recovery on the Connect, plan and job pages`.

### Task 11: Real projects and docs

**Files:** Modify `README.md`, `docs/spikes.md`

- [ ] Pick two or three projects from `~/.cache/switchyard-realworld/results.tsv` that fail convert or build today. Run Switchyard's `convertStep`/`buildStep` harness with `plan.agent` set to Claude, then Codex. Record what each did and whether the re-run passed.
- [ ] README: a "Recovery with your own agent" section (what it does, the two CLIs, sign-in, sandbox note, what goes to the agent) and the `preferences.json` row in "Where it keeps data".
- [ ] Commit `docs: describe agent recovery and record the real-project runs`.
