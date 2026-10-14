import { createJsonClient, type FetchFn } from "../http.ts";

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface BuildToken {
  build_token_uuid: string;
  build_token_name: string;
}

export interface RepoConnectionInput {
  provider_type: "github";
  provider_account_id: string;
  provider_account_name: string;
  repo_id: string;
  repo_name: string;
}

export interface TriggerInput {
  external_script_id: string;
  repo_connection_uuid: string;
  build_token_uuid: string;
  trigger_name: string;
  build_command: string;
  deploy_command: string;
  root_directory: string;
  branch_includes: string[];
  branch_excludes: string[];
  path_includes: string[];
  path_excludes: string[];
  build_caching_enabled: boolean;
}

export interface BuildTrigger {
  trigger_uuid: string;
  trigger_name: string;
}

export interface BuildInfo {
  build_uuid: string;
  status: string;
  build_outcome?: string | null;
}

export type TriggerVariables = Record<string, { value: string; is_secret: boolean }>;

export interface CloudflareClient {
  getUser(): Promise<{ id: string; email: string }>;
  listAccounts(): Promise<CloudflareAccount[]>;
  listZones(accountId: string): Promise<CloudflareZone[]>;
  getWorkerTag(accountId: string, scriptName: string): Promise<string | null>;
  listBuildTokens(accountId: string): Promise<BuildToken[]>;
  putRepoConnection(accountId: string, input: RepoConnectionInput): Promise<string>;
  listTriggers(accountId: string, workerTag: string): Promise<BuildTrigger[]>;
  createTrigger(accountId: string, input: TriggerInput): Promise<BuildTrigger>;
  setTriggerEnv(accountId: string, triggerUuid: string, vars: TriggerVariables): Promise<void>;
  startBuild(accountId: string, triggerUuid: string, branch: string): Promise<string>;
  getBuild(accountId: string, buildUuid: string): Promise<BuildInfo>;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page: number; total_pages: number };
}

export function createCloudflareClient(o: { fetch: FetchFn; token: () => Promise<string> }): CloudflareClient {
  const http = createJsonClient({
    service: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    fetch: o.fetch,
    token: o.token,
    errorMessage: (b) => {
      const errors = (b as Envelope<unknown> | null)?.errors;
      return errors?.length ? errors.map((e) => `${e.message} (${e.code})`).join("; ") : undefined;
    },
  });

  const call = async <T>(
    path: string,
    req: Parameters<typeof http.request>[1] = {},
  ): Promise<T> => (await http.request<Envelope<T>>(path, req)).result;

  async function paged<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const env = await http.request<Envelope<T[]>>(path, { query: { ...query, page, per_page: 50 } });
      out.push(...env.result);
      if (page >= (env.result_info?.total_pages ?? 1)) return out;
    }
  }

  const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;

  return {
    getUser: () => call<{ id: string; email: string }>("/user"),
    listAccounts: () => paged<CloudflareAccount>("/accounts"),
    listZones: (accountId) => paged<CloudflareZone>("/zones", { "account.id": accountId }),
    async getWorkerTag(accountId, scriptName) {
      const scripts = await call<{ id: string; tag?: string }[]>(`${acct(accountId)}/workers/scripts`);
      return scripts.find((s) => s.id === scriptName)?.tag ?? null;
    },
    listBuildTokens: (accountId) => call<BuildToken[]>(`${acct(accountId)}/builds/tokens`),
    async putRepoConnection(accountId, input) {
      const r = await call<{ repo_connection_uuid: string }>(`${acct(accountId)}/builds/repos/connections`, {
        method: "PUT",
        body: input,
      });
      return r.repo_connection_uuid;
    },
    listTriggers: (accountId, tag) =>
      call<BuildTrigger[]>(`${acct(accountId)}/builds/workers/${encodeURIComponent(tag)}/triggers`),
    createTrigger: (accountId, input) =>
      call<BuildTrigger>(`${acct(accountId)}/builds/triggers`, { method: "POST", body: input }),
    async setTriggerEnv(accountId, triggerUuid, vars) {
      await call(`${acct(accountId)}/builds/triggers/${triggerUuid}/environment_variables`, {
        method: "PATCH",
        body: vars,
      });
    },
    async startBuild(accountId, triggerUuid, branch) {
      const r = await call<{ build_uuid: string }>(`${acct(accountId)}/builds/triggers/${triggerUuid}/builds`, {
        method: "POST",
        body: { branch },
      });
      return r.build_uuid;
    },
    getBuild: (accountId, buildUuid) => call<BuildInfo>(`${acct(accountId)}/builds/builds/${buildUuid}`),
  };
}
