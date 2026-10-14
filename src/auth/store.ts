import { readFile } from "node:fs/promises";
import { writeFileSecure } from "../fs-secure.ts";

export interface VercelCredentials {
  token: string;
  scope: "account" | "team";
  teamId?: string;
  teamName?: string;
  username?: string;
}

export interface CloudflareCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  accountId?: string;
  accountName?: string;
}

export interface Credentials {
  vercel?: VercelCredentials;
  cloudflare?: CloudflareCredentials;
  githubPat?: string;
}

export interface CredentialStore {
  read(): Promise<Credentials>;
  update(fn: (c: Credentials) => Credentials): Promise<Credentials>;
}

export function createCredentialStore(file: string): CredentialStore {
  // Serialise writes so two requests updating different services can't race.
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Credentials> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    try {
      return JSON.parse(text) as Credentials;
    } catch {
      throw new Error(`Credentials file ${file} is not valid JSON. Delete it and reconnect your accounts.`);
    }
  }

  return {
    read,
    update(fn) {
      const next = chain.then(async () => {
        const updated = fn(await read());
        await writeFileSecure(file, JSON.stringify(updated, null, 2));
        return updated;
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
