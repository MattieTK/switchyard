import type { CommandRunner } from "../exec.ts";
import { displayPath, isRecord, messageLines, parseJsonLine, shorten, str } from "./events.ts";
import type { AgentDriver, AgentRequest, AgentStatus } from "./types.ts";
import { parseVerdict } from "./verdict.ts";

// codex login status prints to stderr. It reads only the stored sign-in, so it spends nothing.
function statusFromOutput(code: number, output: string): AgentStatus {
  const base = { id: "codex" as const, installed: true };
  if (code !== 0 || /not logged in/i.test(output)) {
    return { ...base, signedIn: false, detail: "Not signed in: run codex login" };
  }
  if (/logged in using chatgpt/i.test(output)) return { ...base, signedIn: true, detail: "Signed in with ChatGPT" };
  // forced_login_method="chatgpt" makes codex refuse any other sign-in, so they can't be used.
  if (/api key/i.test(output)) {
    return {
      ...base,
      signedIn: false,
      detail: "Signed in with an API key. Switchyard uses Codex with a ChatGPT sign-in only: run codex login",
    };
  }
  return { ...base, signedIn: false, detail: `${shorten(output, 120)}. Switchyard uses Codex with a ChatGPT sign-in only: run codex login` };
}

// workspace-write lets Codex change the project folder (and the extra folders) and nothing
// else; .git stays read-only inside it. Network is on so it can install packages.
export function codexArgs(req: Pick<AgentRequest, "cwd" | "model" | "writableDirs">): string[] {
  return [
    "exec",
    "--json",
    "-s",
    "workspace-write",
    "-C",
    req.cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "-c",
    "sandbox_workspace_write.network_access=true",
    // Stops an API key in the environment from replacing the user's ChatGPT sign-in.
    "-c",
    'forced_login_method="chatgpt"',
    ...req.writableDirs.flatMap((dir) => ["--add-dir", dir]),
    ...(req.model ? ["-m", req.model] : []),
    "-",
  ];
}

// Codex runs each command through the user's login shell, as in `/usr/bin/zsh -lc 'npm run build'`.
export function unwrapShell(command: string): string {
  const match = command.match(/^\S*\/(?:ba|z|da|k)?sh\s+-lc\s+(.*)$/s);
  if (!match?.[1]) return command;
  const inner = match[1].trim();
  if (inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1).replace(/'\\''/g, "'");
  if (inner.startsWith('"') && inner.endsWith('"')) return inner.slice(1, -1).replace(/"'(.*?)'"/g, "$1").replace(/\\"/g, '"');
  return inner;
}

const CHANGE_VERBS: Record<string, string> = { add: "added", delete: "deleted", update: "edited" };

// One exec --json event as log lines. Only completed items are logged, so nothing appears twice.
export function codexLogLines(event: unknown, cwd: string): string[] {
  if (!isRecord(event)) return [];
  if (event.type === "turn.failed" || event.type === "error") {
    const message = isRecord(event.error) ? str(event.error.message) : str(event.message);
    return [`Agent: Codex stopped: ${shorten(message)}`];
  }
  if (event.type !== "item.completed" || !isRecord(event.item)) return [];
  const item = event.item;
  switch (item.type) {
    case "agent_message":
      return messageLines(str(item.text));
    case "command_execution": {
      const exit = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
      return [`Agent: ran ${shorten(unwrapShell(str(item.command)))}${exit}`];
    }
    case "file_change":
      return (Array.isArray(item.changes) ? item.changes : []).filter(isRecord).map(
        (c) => `Agent: ${CHANGE_VERBS[str(c.kind)] ?? "changed"} ${displayPath(str(c.path), cwd)}`,
      );
    default:
      return [];
  }
}

// The last agent message, or the reason the turn failed.
function finalText(stdout: string): string {
  let text = "";
  for (const line of stdout.trim().split("\n")) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;
    if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message") {
      text = str(event.item.text);
    } else if (event.type === "turn.failed" && isRecord(event.error)) {
      text = str(event.error.message);
    }
  }
  return text;
}

export function codexDriver(run: CommandRunner, opts: { now?: () => number } = {}): AgentDriver {
  const now = opts.now ?? Date.now;
  return {
    id: "codex",

    async status() {
      try {
        const result = await run("codex", ["login", "status"], { timeoutMs: 30_000 });
        return statusFromOutput(result.code, result.output.trim());
      } catch {
        return { id: "codex", installed: false, signedIn: false, detail: "Not installed" };
      }
    },

    async run(req) {
      const started = now();
      const result = await run("codex", codexArgs(req), {
        cwd: req.cwd,
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        killGroup: true,
        onLine: (line) => {
          for (const l of codexLogLines(parseJsonLine(line), req.cwd)) req.log(l);
        },
      });
      const { verdict, summary, message } = parseVerdict(finalText(result.stdout));
      return {
        verdict,
        summary,
        message,
        events: result.stdout,
        exitCode: result.code,
        timedOut: result.code !== 0 && now() - started >= req.timeoutMs,
      };
    },
  };
}
