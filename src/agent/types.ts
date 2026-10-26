export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_LABELS: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };

export interface AgentStatus {
  id: AgentId;
  installed: boolean;
  signedIn: boolean;
  // A sentence for the UI, such as "Signed in with your Claude subscription (Max)".
  detail: string;
  // Claude only: whether its Bash sandbox can start here, and why not.
  sandbox?: { available: boolean; detail: string };
}

export interface AgentRequest {
  cwd: string;
  prompt: string;
  // Empty or missing means the CLI's own default.
  model?: string;
  // Folders outside cwd the agent may write to, such as the package manager's cache.
  writableDirs: string[];
  // Folders and files the agent must not read: Switchyard's own data, such as saved values.
  // Claude Code enforces this; Codex can't be told to.
  protectedPaths: string[];
  timeoutMs: number;
  log(line: string): void;
}

export type Verdict = "fixed" | "cannot-fix" | "no-verdict";

export interface AgentResult {
  verdict: Verdict;
  // The sentence after the verdict: what was changed, or why it can't be fixed.
  summary: string;
  // The agent's last message, without the verdict line.
  message: string;
  // The raw JSONL the CLI printed, kept for debugging.
  events: string;
  exitCode: number;
  timedOut: boolean;
}

export interface AgentDriver {
  id: AgentId;
  status(): Promise<AgentStatus>;
  run(req: AgentRequest): Promise<AgentResult>;
}
