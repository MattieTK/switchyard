import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileSecure } from "../fs-secure.ts";
import { AGENT_IDS, type AgentId } from "./types.ts";

// Model names as the CLIs take them: aliases such as opus, or IDs such as gpt-6-luna or
// claude-opus-5-5[1m]. Empty means the CLI's own default.
const MODEL = z
  .string()
  .max(100)
  .regex(/^[\w.:[\]-]*$/, "Use letters, digits and . : - _ [ ] only");

export const agentPreferencesSchema = z.object({
  preferred: z.enum(AGENT_IDS).nullable(),
  models: z.object({ claude: MODEL.optional(), codex: MODEL.optional() }),
});

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>;

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = { preferred: null, models: {} };

export interface PreferencesStore {
  read(): Promise<AgentPreferences>;
  write(p: AgentPreferences): Promise<AgentPreferences>;
}

const fileSchema = z.object({ agent: agentPreferencesSchema });

// A missing or unreadable file means no preferences yet, which is how every install starts.
export function createPreferencesStore(file: string): PreferencesStore {
  return {
    async read() {
      try {
        const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        return parsed.success ? parsed.data.agent : DEFAULT_AGENT_PREFERENCES;
      } catch {
        return DEFAULT_AGENT_PREFERENCES;
      }
    },
    async write(p) {
      const agent = agentPreferencesSchema.parse(p);
      await writeFileSecure(file, `${JSON.stringify({ agent }, null, 2)}\n`);
      return agent;
    },
  };
}

// The model a job uses for an agent: the saved preference, or the CLI's default when empty.
export function modelFor(p: AgentPreferences, id: AgentId): string | undefined {
  return p.models[id] || undefined;
}
