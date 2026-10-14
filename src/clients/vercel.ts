import { createJsonClient, isAuthError, type FetchFn } from "../http.ts";

export type VercelTarget = "production" | "preview" | "development";

export interface VercelUser {
  id: string;
  username: string;
  email?: string;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  rootDirectory: string | null;
  link?: { type: string; org?: string; repo?: string; repoId?: number; productionBranch?: string };
}

export interface VercelEnvVar {
  id: string;
  key: string;
  value?: string;
  type: "plain" | "encrypted" | "sensitive" | "secret" | "system";
  target: VercelTarget[];
  gitBranch?: string | null;
}

export interface VercelDomain {
  name: string;
  redirect?: string | null;
  gitBranch?: string | null;
}

export interface VercelClient {
  getUser(): Promise<VercelUser>;
  listTeams(): Promise<VercelTeam[]>;
  listProjects(): Promise<VercelProject[]>;
  getProject(idOrName: string): Promise<VercelProject>;
  listEnv(projectId: string): Promise<VercelEnvVar[]>;
  listDomains(projectId: string): Promise<VercelDomain[]>;
}

type Query = Record<string, string | number | undefined>;

export function createVercelClient(o: { fetch: FetchFn; token: string; teamId?: string }): VercelClient {
  const http = createJsonClient({
    service: "vercel",
    baseUrl: "https://api.vercel.com",
    fetch: o.fetch,
    token: async () => o.token,
    errorMessage: (b) => (b as { error?: { message?: string } } | null)?.error?.message,
    isAuthFailure: (status, b) =>
      status === 403 && (b as { error?: { invalidToken?: boolean } } | null)?.error?.invalidToken === true,
  });
  const q = (extra: Query = {}): Query => ({ teamId: o.teamId, ...extra });
  const id = encodeURIComponent;

  return {
    getUser: async () => (await http.request<{ user: VercelUser }>("/v2/user")).user,
    listTeams: async () => (await http.request<{ teams: VercelTeam[] }>("/v2/teams", { query: { limit: 100 } })).teams,
    async listProjects() {
      const all: VercelProject[] = [];
      let until: number | undefined;
      do {
        const page = await http.request<{ projects: VercelProject[]; pagination?: { next: number | null } }>(
          "/v9/projects",
          { query: q({ limit: 100, until }) },
        );
        all.push(...page.projects);
        until = page.pagination?.next ?? undefined;
      } while (until);
      return all;
    },
    getProject: (p) => http.request<VercelProject>(`/v9/projects/${id(p)}`, { query: q() }),
    listEnv: async (p) =>
      (await http.request<{ envs: VercelEnvVar[] }>(`/v10/projects/${id(p)}/env`, { query: q({ decrypt: "true" }) }))
        .envs,
    listDomains: async (p) =>
      (await http.request<{ domains: VercelDomain[] }>(`/v9/projects/${id(p)}/domains`, { query: q() })).domains,
  };
}

export interface ScopeProbe {
  userOk: boolean;
  user: VercelUser | null;
  teams: VercelTeam[] | null;
  projectsOk: boolean;
}

// Vercel doesn't document which endpoints each token scope can reach, so we
// try the three we need and record what works. A rejected token is rethrown.
export async function probeVercelToken(c: VercelClient): Promise<ScopeProbe> {
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (isAuthError(e)) throw e;
      return null;
    }
  };
  const user = await attempt(() => c.getUser());
  const teams = await attempt(() => c.listTeams());
  const projects = await attempt(() => c.listProjects());
  return { userOk: user !== null, user, teams, projectsOk: projects !== null };
}
