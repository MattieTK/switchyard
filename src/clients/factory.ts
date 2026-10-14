import { resolveGitHubAuth, type GitHubAuth } from "../auth/github.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { CommandRunner } from "../exec.ts";
import { ApiError, type FetchFn } from "../http.ts";
import { createCloudflareClient, type CloudflareClient } from "./cloudflare.ts";
import { createGitHubClient, type GitHubClient } from "./github.ts";
import { createVercelClient, type VercelClient } from "./vercel.ts";

export interface ClientFactory {
  vercel(): Promise<VercelClient>;
  cloudflare: CloudflareClient;
  github(): Promise<GitHubClient>;
  githubAuth(): Promise<GitHubAuth>;
}

// Clients are built per call from the stored credentials, so reconnecting an
// account takes effect immediately, including for paused jobs.
export function createClientFactory(o: {
  store: CredentialStore;
  fetch: FetchFn;
  run: CommandRunner;
  cloudflareToken: () => Promise<string>;
}): ClientFactory {
  const githubAuth = async () => {
    const auth = await resolveGitHubAuth(o.run, o.store);
    if (!auth) throw new ApiError("github", 401, "GitHub is not connected. Run gh auth login, or paste a token.", true);
    return auth;
  };
  return {
    async vercel() {
      const { vercel } = await o.store.read();
      if (!vercel) throw new ApiError("vercel", 401, "Vercel is not connected", true);
      return createVercelClient({ fetch: o.fetch, token: vercel.token, teamId: vercel.teamId });
    },
    cloudflare: createCloudflareClient({ fetch: o.fetch, token: o.cloudflareToken }),
    async github() {
      const auth = await githubAuth();
      return createGitHubClient({ fetch: o.fetch, token: async () => auth.token });
    },
    githubAuth,
  };
}
