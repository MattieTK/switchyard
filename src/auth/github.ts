import type { CommandRunner } from "../exec.ts";
import type { CredentialStore } from "./store.ts";

export interface GitHubAuth {
  token: string;
  source: "gh" | "pat";
}

export async function resolveGitHubAuth(run: CommandRunner, store: CredentialStore): Promise<GitHubAuth | null> {
  try {
    const r = await run("gh", ["auth", "token"]);
    const token = r.output.trim();
    if (r.code === 0 && token) return { token, source: "gh" };
  } catch {
    // gh is not installed; fall through to the stored PAT.
  }
  const { githubPat } = await store.read();
  return githubPat ? { token: githubPat, source: "pat" } : null;
}

// Supplies the token to git as an HTTP header through environment-only config,
// so it never lands in .git/config, the remote URL or the process arguments.
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}
