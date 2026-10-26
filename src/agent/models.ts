import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, str } from "./events.ts";
import type { AgentId } from "./types.ts";

// Claude Code's documented aliases, which always point at the latest model of each kind.
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];

// Suggestions for the model fields. Codex keeps the models its account can use in a cache file,
// which isn't a documented interface, so a missing or different file only removes the suggestions.
export async function modelSuggestions(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<Record<AgentId, string[]>> {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  let codex: string[] = [];
  try {
    const cache = JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8")) as unknown;
    const models = isRecord(cache) && Array.isArray(cache.models) ? cache.models : [];
    codex = models.filter((m) => isRecord(m) && m.visibility === "list").map((m) => str((m as Record<string, unknown>).slug)).filter(Boolean);
  } catch {
    // No cache yet.
  }
  return { claude: CLAUDE_ALIASES, codex };
}
