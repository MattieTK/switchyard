import type { CommandRunner } from "../exec.ts";
import { displayPath, isRecord, messageLines, parseJsonLine, shorten, str } from "./events.ts";
import type { AgentDriver, AgentRequest, AgentStatus } from "./types.ts";
import { parseVerdict } from "./verdict.ts";
import { onPath as defaultOnPath } from "./which.ts";

// Hosts a sandboxed install or build needs: the npm and Yarn registries, and GitHub for
// git dependencies and tarballs.
const SANDBOX_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "nodejs.org",
];

const PLAN_NAMES: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

// What claude auth status says about how claude is signed in.
function signInDetail(status: Record<string, unknown>): string {
  switch (status.authMethod) {
    case "claude.ai": {
      const plan = PLAN_NAMES[str(status.subscriptionType)];
      return `Signed in with your Claude subscription${plan ? ` (${plan})` : ""}`;
    }
    case "oauth_token":
      return "Signed in with a token from claude setup-token";
    case "api_key":
    case "api_key_helper":
      return "Signed in with an API key, so its usage is billed to that key";
    case "third_party":
      return "Signed in through a cloud provider";
    default:
      return "Signed in";
  }
}

// Claude Code's sandbox uses Seatbelt on macOS, and bubblewrap and socat on Linux and WSL2.
async function sandboxStatus(
  platform: NodeJS.Platform,
  onPath: (cmd: string) => Promise<boolean>,
): Promise<{ available: boolean; detail: string }> {
  if (platform === "darwin") return { available: true, detail: "Commands run in Claude Code's sandbox." };
  if (platform !== "linux") return { available: false, detail: "Commands run without a sandbox, which Claude Code doesn't offer here." };
  const missing: string[] = [];
  for (const tool of ["bwrap", "socat"]) if (!(await onPath(tool))) missing.push(tool === "bwrap" ? "bubblewrap" : tool);
  return missing.length
    ? { available: false, detail: `Commands run without a sandbox. Install ${missing.join(" and ")} to turn on Claude Code's sandbox.` }
    : { available: true, detail: "Commands run in Claude Code's sandbox." };
}

// --bare is never passed: it limits Anthropic sign-in to ANTHROPIC_API_KEY, and Claude must use
// the user's own sign-in. dontAsk refuses anything not allowed instead of waiting for an answer.
export function claudeArgs(req: Pick<AgentRequest, "model" | "writableDirs">, sandbox: boolean): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns",
    "80",
  ];
  if (req.model) args.push("--model", req.model);
  if (sandbox) {
    // failIfUnavailable makes claude stop instead of quietly running commands unsandboxed.
    const settings = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        filesystem: { allowWrite: req.writableDirs },
        network: { allowedDomains: SANDBOX_DOMAINS },
      },
    };
    args.push("--settings", JSON.stringify(settings));
  }
  return args;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// One stream-json event as log lines. Events Switchyard doesn't know are skipped.
export function claudeLogLines(event: unknown, cwd: string): string[] {
  if (!isRecord(event)) return [];
  if (event.type === "system" && event.subtype === "permission_denied") {
    return [`Agent: wasn't allowed to use ${str(event.tool_name) || "a tool"}`];
  }
  if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return [];
  return event.message.content.flatMap((block): string[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text") return messageLines(str(block.text));
    if (block.type !== "tool_use") return [];
    const input = isRecord(block.input) ? block.input : {};
    const name = str(block.name);
    if (EDIT_TOOLS.has(name)) return [`Agent: edited ${displayPath(str(input.file_path ?? input.notebook_path), cwd)}`];
    if (name === "Bash") return [`Agent: ran ${shorten(str(input.command))}`];
    if (name === "Read") return [`Agent: read ${displayPath(str(input.file_path), cwd)}`];
    if (name === "WebFetch") return [`Agent: fetched ${str(input.url)}`];
    return [];
  });
}

// The text of the final result event: the last message, or why the run stopped.
function resultText(stdout: string): string {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseJsonLine(lines[i] ?? "");
    if (!isRecord(event) || event.type !== "result") continue;
    if (typeof event.result === "string" && event.result) return event.result;
    if (Array.isArray(event.errors)) return event.errors.map(str).join("\n");
    return "";
  }
  return "";
}

export function claudeDriver(
  run: CommandRunner,
  opts: { platform?: NodeJS.Platform; onPath?: (cmd: string) => Promise<boolean>; now?: () => number } = {},
): AgentDriver {
  const platform = opts.platform ?? process.platform;
  const onPath = opts.onPath ?? ((cmd: string) => defaultOnPath(cmd));
  const now = opts.now ?? Date.now;

  return {
    id: "claude",

    async status(): Promise<AgentStatus> {
      const sandbox = await sandboxStatus(platform, onPath);
      let result;
      try {
        result = await run("claude", ["auth", "status"], { timeoutMs: 30_000 });
      } catch {
        return { id: "claude", installed: false, signedIn: false, detail: "Not installed", sandbox };
      }
      const parsed = parseJsonLine(result.stdout.trim());
      const status = isRecord(parsed) ? parsed : {};
      if (result.code !== 0 || status.loggedIn !== true) {
        return { id: "claude", installed: true, signedIn: false, detail: "Not signed in: run claude, then /login", sandbox };
      }
      return { id: "claude", installed: true, signedIn: true, detail: signInDetail(status), sandbox };
    },

    async run(req) {
      const { available } = await sandboxStatus(platform, onPath);
      const started = now();
      const result = await run("claude", claudeArgs(req, available), {
        cwd: req.cwd,
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        killGroup: true,
        onLine: (line) => {
          for (const l of claudeLogLines(parseJsonLine(line), req.cwd)) req.log(l);
        },
      });
      const { verdict, summary, message } = parseVerdict(resultText(result.stdout));
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
