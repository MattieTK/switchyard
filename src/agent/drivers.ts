import type { CommandRunner } from "../exec.ts";
import { claudeDriver } from "./claude.ts";
import { codexDriver } from "./codex.ts";
import type { AgentDriver, AgentId } from "./types.ts";

export type AgentDrivers = Record<AgentId, AgentDriver>;

export function createAgentDrivers(run: CommandRunner): AgentDrivers {
  return { claude: claudeDriver(run), codex: codexDriver(run) };
}
