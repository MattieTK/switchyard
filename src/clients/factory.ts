import { resolveGitHubAuth, type GitHubAuth } from "../auth/github.ts";
import type { ChatGPTTokens } from "../auth/openai-oauth.ts";
import type { CredentialStore } from "../auth/store.ts";
import { VERSION } from "../config.ts";
import type { CommandRunner } from "../exec.ts";
import { ApiError, type FetchFn } from "../http.ts";
import { createCloudflareClient, type CloudflareClient } from "./cloudflare.ts";
import { createGitHubClient, type GitHubClient } from "./github.ts";
import { createChatGPTClient, createOpenAIClient, type OpenAIClient } from "./openai.ts";
import { createVercelClient, type VercelClient } from "./vercel.ts";

export interface ClientFactory {
  vercel(): Promise<VercelClient>;
  cloudflare: CloudflareClient;
  // A client that calls with a given API token instead of the OAuth session, such as one the user pastes.
  cloudflareWith(token: string): CloudflareClient;
  github(): Promise<GitHubClient>;
  githubAuth(): Promise<GitHubAuth>;
  // OpenAI is optional, so this is null when it isn't connected.
  openai(): Promise<{ client: OpenAIClient; model: string } | null>;
  openaiWith(apiKey: string): OpenAIClient;
  // A client for a ChatGPT sign-in that isn't saved yet.
  chatgptWith(tokens: ChatGPTTokens): OpenAIClient;
}

// Clients are built per call from the stored credentials, so reconnecting an
// account takes effect immediately, including for paused jobs.
export function createClientFactory(o: {
  store: CredentialStore;
  fetch: FetchFn;
  run: CommandRunner;
  cloudflareToken: () => Promise<string>;
  chatgptTokens: () => Promise<ChatGPTTokens>;
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
    cloudflareWith: (token) => createCloudflareClient({ fetch: o.fetch, token: async () => token }),
    async github() {
      const auth = await githubAuth();
      return createGitHubClient({ fetch: o.fetch, token: async () => auth.token });
    },
    githubAuth,
    async openai() {
      const { openai } = await o.store.read();
      if (!openai) return null;
      const client =
        openai.kind === "chatgpt"
          ? createChatGPTClient({ fetch: o.fetch, tokens: o.chatgptTokens, version: VERSION })
          : createOpenAIClient({ fetch: o.fetch, apiKey: openai.apiKey });
      return { client, model: openai.model };
    },
    openaiWith: (apiKey) => createOpenAIClient({ fetch: o.fetch, apiKey }),
    chatgptWith: (tokens) => createChatGPTClient({ fetch: o.fetch, tokens: async () => tokens, version: VERSION }),
  };
}
