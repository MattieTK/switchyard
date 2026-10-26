# Agent recovery – design

Date: 2026-10-26
Status: agreed in conversation, prototype on `feat/agent-recovery`

## Purpose

Switchyard's deterministic steps do most of the work of a migration, and its rule-based repairs (adding undeclared packages, Yarn's release-age retry, shims for missing exports) handle the failures we have seen often enough to write rules for. Some projects still fail in convert, build, deploy or the first Cloudflare build for reasons no rule covers yet: CommonJS interop, a codemod that chokes on one file, a type error the upgrade exposed.

This adds a recovery path the user opts into. When a covered step still fails after Switchyard's own repairs, Switchyard hands the failure to the user's own coding agent, Claude Code or OpenAI's Codex, with everything it has done so far. The agent changes the project, and Switchyard runs the step again. Switchyard, not the agent, decides whether the recovery worked.

### Success criteria

- With recovery off (the default), nothing about a migration changes.
- With recovery on, a project that fails convert or build today for a reason no rule covers gets past that step after one or two agent attempts, with Claude and with Codex.
- Claude runs on the user's Claude subscription and Codex on their ChatGPT sign-in. Switchyard never asks for, reads or stores an API key or session token for either.
- Every change an agent made is listed in the pull request, and the convert fixes are a separate commit.
- No production value, `.dev.vars` content or Switchyard token reaches an agent.

## Decisions

| Topic | Decision |
| --- | --- |
| How agents are driven | The user's own installed CLIs as subprocesses: `claude -p` and `codex exec`. No SDK dependencies. |
| Why not the Agent SDK | Anthropic's terms send developers on the Agent SDK to API keys; signing in to the unmodified Claude Code binary with one's own subscription is permitted. |
| When it runs | Opt-in per job, then automatic when a covered step fails with a command error, after deterministic repairs |
| Covered steps | convert, build, deploy, start-build |
| Attempts | 2 per step per run; Retry starts the count again |
| Success | The step's own re-run passes. The agent's verdict only decides whether a re-run is worth trying. |
| Convert | Fix layer: agent works on a clean checkout, its changes are committed locally, and convert resets to that commit |
| Preference | A machine-level preferred agent and a model per agent, set on the Connect page |
| Claude's commands | Claude Code's sandbox when its prerequisites are present; otherwise unsandboxed, and the plan screen says so |

## Terms this relies on

- Anthropic, [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): developers using the Agent SDK "should use API key authentication", may not "collect, store, or intermediate Claude.ai credentials or session tokens", and this "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Switchyard runs the user's installed `claude` as published and never touches its credentials.
- OpenAI, [app-server authentication](https://learn.chatgpt.com/docs/app-server): local or open-source applications using the user's Codex sign-in "can continue using it", with Sign in with ChatGPT recommended, and it "has never been permitted for commercial or hosted services".

This is our reading of the terms, and it should be checked before this ships beyond a prototype.

## Preferences

`preferences.json` in the config folder (next to `credentials.json`) holds:

```json
{ "agent": { "preferred": "claude", "models": { "claude": "opus", "codex": "" } } }
```

An empty or missing model means the CLI's own default. The Connect page gets an Agents card that shows each agent's status and lets the user choose the preferred agent and each model.

- Claude's model is free text with the documented aliases `opus`, `sonnet` and `haiku` suggested.
- Codex's model is free text, with suggestions read from `~/.codex/models_cache.json` (models with `visibility: "list"`) when the file exists. That file is a cache, not an interface, so a missing or changed file only removes the suggestions.

`GET /api/agents` returns the statuses, preferences and suggestions. `PUT /api/agents/preferences` saves preferences, validated with zod.

## Detecting agents

Each driver has `status()`, which spends no tokens:

- Claude: `claude auth status` (JSON). `authMethod: "claude.ai"` reads "Signed in with your Claude subscription (Max)" from `subscriptionType`; `api_key` and similar read "Signed in with an API key, so usage is billed to that key"; exit 1 is "Not signed in: run claude, then /login".
- Codex: `codex login status` (exit code and stderr). "Logged in using ChatGPT" reads "Signed in with ChatGPT"; "API key configured" reads as an API key; exit 1 is "Not signed in: run codex login".
- A command that can't start is "Not installed".
- Claude's sandbox: available on macOS, and on Linux when `bwrap` and `socat` are on PATH. The status says which is missing.

## Plan screen

A Recovery card offers "If a step still fails, ask an agent to fix it", off by default, with the available agents as choices and the preferred one selected. An agent that isn't installed or signed in can't be chosen. The Claude choice says whether its commands run in the sandbox.

The approve request gains `options.agent: "claude" | "codex" | null`. The service refuses an agent that isn't available, and stores `plan.agent = { id, model }` with the model from preferences at that moment, so retries use the same agent and model.

## The recovery loop

The runner owns it. For a step in `RECOVERABLE` (convert, build, deploy, start-build) that throws a `CommandError` (or, for start-build, a `BuildFailedError` carrying the Workers Builds log), when `plan.agent` is set and the step has attempts left:

1. Build the prompt (below).
2. Prepare the working copy: for convert, reset to the current base and clean it; for the others, use the tree as it is.
3. Hold `.dev.vars`: move it to `<workDir>/<jobId>.dev.vars.held` (mode 0600) and restore it in a `finally`. A held file left by a crash is restored before the next run.
4. Snapshot `git status --porcelain` and run the agent with a 15-minute limit.
5. Work out `changedFiles` from git, not from agent events.
6. Record an `AgentRun` on `job.agentRuns`.
7. If the verdict is `cannot-fix`, or nothing changed, the step fails with the agent's message.
8. Otherwise, for convert, commit the changes and set `job.fixBase`. Then re-run from the step's re-run point.

Pauses, auth errors and Switchyard's own consistency errors never reach the agent.

| Step | Agent works on | Re-runs from |
| --- | --- | --- |
| convert | a clean checkout of the base, committed as the fix layer | convert |
| build | the converted tree, in place | build |
| deploy | the converted tree, in place | deploy |
| start-build | the converted tree, in place | build, then the steps after it |

Re-running from an earlier step sets that step and the ones after it back to pending, as Retry does. Their outputs are cleared; `job.agentRuns` and `job.fixBase` are kept. The attempt count is per step and per runner invocation.

### Convert's fix layer

Convert resets to `job.fixBase ?? origin/<branch>` instead of `origin/<branch>`. After a convert recovery, Switchyard commits the agent's changes with the user's git identity (or as Switchyard when there is none, as the push step does) and the message `fix: changes by <Agent> so the Cloudflare conversion succeeds`. A second attempt adds a commit on top. Lockfile lookups for the pre-migration version keep reading `origin/<branch>`.

## The prompt

`agentPrompt(context)` in `src/agent/prompt.ts` is a pure function. It contains:

1. **The target**: the project, the step and what passing means (the build command and folder, `cf deploy`, the Workers Builds build of `cloudflare-migration`, or for convert the conversion commands Switchyard runs).
2. **What Switchyard has done**: framework and upgrade, package manager and any pnpm switch, cache preset, ticked options, crons, the steps that passed with their non-secret outputs, the changes recorded as warnings, the files Switchyard generated, and the names (not values) of the variables Switchyard sets when it builds.
3. **The failure**: the command, its exit code and the end of its output (about 60 KB), redacted; for start-build, the end of the Workers Builds log from the API, redacted; and the step's earlier log lines, which the job log already holds redacted.
4. **Earlier attempts in this run**: what each changed, what the agent said, and the error from the re-run.
5. **Rules**: change files only inside the project folder; don't commit, push or deploy; don't add environment variables; don't remove or weaken what Switchyard generated; make the smallest change that fixes the cause; stop if the cause is outside the code. End with `SWITCHYARD: fixed` or `SWITCHYARD: cannot fix – <reason>` on its own line.

The prompt goes to the agent on stdin.

## Drivers

`src/agent/` holds an `AgentDriver` per CLI:

```ts
interface AgentDriver {
  id: "claude" | "codex";
  label: string;
  status(): Promise<AgentStatus>;
  run(req: AgentRequest): Promise<AgentResult>; // verdict, message, raw events
}
```

Both use the existing `CommandRunner`, which gains `input` (written to stdin) and `killGroup` (spawn in a new process group and signal the whole group on timeout).

**Claude**, in the project folder:

```
claude -p --output-format stream-json --verbose
  --permission-mode dontAsk
  --allowedTools Read Edit Write Glob Grep Bash WebFetch
  --strict-mcp-config --no-session-persistence --max-turns 80
  [--model <model>] [--settings <sandbox JSON>]
```

`--bare` is never used: it limits Anthropic auth to `ANTHROPIC_API_KEY`. When the sandbox is available, `--settings` turns it on with `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false` and `failIfUnavailable: true`, the package manager's cache as an extra writable folder, and network limited to the npm and Yarn registries and GitHub.

**Codex**:

```
codex exec --json -s workspace-write -C <dir> --skip-git-repo-check --ephemeral
  -c sandbox_workspace_write.network_access=true
  -c forced_login_method="chatgpt"
  [--add-dir <package manager cache>] [-m <model>] -
```

`forced_login_method` stops an API key in the environment from replacing the ChatGPT sign-in.

Each driver maps its events to `Agent:` log lines: edits as `Agent: edited <path>`, commands as `Agent: ran <command> (exit N)`, and the agent's messages as text. Unknown events are ignored. The raw stream is redacted and saved as `<jobId>.agent-<step>-<n>.jsonl` beside the job log.

## Secrets

- `.dev.vars` is held outside the project for the length of each run.
- `productionBuildEnv` values are never passed; the prompt lists the names only.
- Switchyard's Cloudflare and GitHub tokens are passed per command and are never in `process.env`, so an agent can't deploy or push.
- Every piece of output in the prompt goes through the job's `Redactor`.

## Pull request and job page

- The pull request gets a "Changes made by <Agent>" section, one entry per run that changed files: the step, the agent's summary and the files. "Before merging" gets "Review the changes <Agent> made. They let the build pass, but Switchyard can't tell whether the app still behaves the same."
- When the PR already exists and agent runs changed files, the pr step updates its body.
- The job page shows "<Agent> is working on this (attempt N of 2)" on the running step, lists finished runs under each step, and styles `Agent:` log lines.

## Errors

- The CLI isn't installed or signed in when the run starts: the step fails with the original error and a note on the agent.
- The agent times out: "Claude didn't finish within 15 minutes", and the run counts as an attempt.
- The agent exits non-zero (a usage limit, a network error): the step fails with the original error and the agent's last message.
- No verdict line: treated as `fixed` if files changed, since the re-run decides.

## Testing

- A spike first: one run of each CLI on a throwaway project with a deliberate build error, recorded as JSONL fixtures, and a check of the sandbox flags on WSL2.
- Unit tests with fakes: the prompt builder, both stream parsers against the fixtures, verdict parsing, status parsing, the runner loop (attempt limit, `cannot-fix`, no changes, start-build re-running from build), the fix layer in a temporary git repository, holding `.dev.vars`, `CommandRunner` `input` and `killGroup`, preferences, and service validation of `options.agent`.
- Real projects: two or three from the real-world ledger that fail convert or build today, with each agent. Results go in `docs/spikes.md`.

## Not covered

- The Agent SDKs, Codex app-server and Sign in with ChatGPT.
- Showing rate limits or usage.
- Asking the agent from a button on a failed step.
- Changing the agent from the job page.
- Recovery for clone, push, pr and builds.
- A runtime check that the home page serves, as a step the agent could recover.
- Using both agents in one job, or falling back from one to the other.

## Risks

- An agent's change can make the build pass and change behaviour. The PR checklist asks for review; Switchyard can't judge it.
- CLI event formats change. Parsers ignore unknown events and `changedFiles` comes from git, so drift degrades the log, not the outcome.
- The user's hooks and CLAUDE.md load into the Claude run and can steer or block it.
- Hitting a usage limit mid-run fails the attempt with the CLI's message.
- The terms reading above is ours.
