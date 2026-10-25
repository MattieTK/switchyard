import { createJsonClient, type FetchFn } from "../http.ts";

export interface CloudflareAccount {
  id: string;
  name: string;
  // False when the user's role on the account only lets them read Workers.
  canDeployWorkers: boolean;
}

interface Membership {
  status: string;
  account: { id: string; name: string };
  permissions?: { worker?: { edit?: boolean } };
}

// Shown wherever a read-only account would stop a migration.
export function readOnlyAccountMessage(accountName: string): string {
  return `Your Cloudflare user can only read Workers on ${accountName}, so Switchyard can't deploy there. Ask an administrator of that account for a role that can edit Workers, or choose another account`;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface BuildToken {
  build_token_uuid: string;
  build_token_name: string;
}

export interface BuildTokenInput {
  build_token_name: string;
  build_token_secret: string;
  cloudflare_token_id: string;
}

export interface PermissionGroup {
  id: string;
  name: string;
  // Which resources the permission applies to, such as com.cloudflare.api.account or ….account.zone.
  scopes: string[];
}

export interface TokenPolicy {
  effect: "allow";
  permission_groups: { id: string }[];
  resources: Record<string, unknown>;
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
  createBuildToken(accountId: string, input: BuildTokenInput): Promise<BuildToken>;
  listTokenPermissionGroups(accountId: string): Promise<PermissionGroup[]>;
  // Account API tokens; the value is only ever returned here, on creation.
  createAccountToken(accountId: string, input: { name: string; policies: TokenPolicy[] }): Promise<{ id: string; value: string }>;
  deleteAccountToken(accountId: string, tokenId: string): Promise<void>;
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
    // Memberships rather than /accounts, because they carry the user's permissions on each account.
    async listAccounts() {
      const memberships = await paged<Membership>("/memberships");
      return memberships
        .filter((m) => m.status === "accepted")
        .map((m) => ({
          id: m.account.id,
          name: m.account.name,
          canDeployWorkers: m.permissions?.worker?.edit !== false,
        }));
    },
    listZones: (accountId) => paged<CloudflareZone>("/zones", { "account.id": accountId }),
    async getWorkerTag(accountId, scriptName) {
      const scripts = await call<{ id: string; tag?: string }[]>(`${acct(accountId)}/workers/scripts`);
      return scripts.find((s) => s.id === scriptName)?.tag ?? null;
    },
    listBuildTokens: (accountId) => call<BuildToken[]>(`${acct(accountId)}/builds/tokens`),
    createBuildToken: (accountId, input) =>
      call<BuildToken>(`${acct(accountId)}/builds/tokens`, { method: "POST", body: input }),
    listTokenPermissionGroups: (accountId) => call<PermissionGroup[]>(`${acct(accountId)}/tokens/permission_groups`),
    async createAccountToken(accountId, input) {
      const r = await call<{ id: string; value: string }>(`${acct(accountId)}/tokens`, { method: "POST", body: input });
      return { id: r.id, value: r.value };
    },
    async deleteAccountToken(accountId, tokenId) {
      await call(`${acct(accountId)}/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
    },
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
