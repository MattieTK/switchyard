import { ApiError, createJsonClient, type FetchFn } from "../http.ts";

export interface GitHubRepo {
  id: number;
  name: string;
  ownerId: number;
  ownerLogin: string;
  defaultBranch: string;
  private: boolean;
}

export interface PullRequest {
  url: string;
  number: number;
}

export interface GitHubClient {
  getViewer(): Promise<{ login: string }>;
  getRepo(owner: string, repo: string): Promise<GitHubRepo>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  listDir(owner: string, repo: string, path: string, ref: string): Promise<string[] | null>;
  findOpenPr(owner: string, repo: string, branch: string): Promise<PullRequest | null>;
  createPr(owner: string, repo: string, p: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
  commentOnPr(owner: string, repo: string, number: number, body: string): Promise<void>;
}

const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

export function createGitHubClient(o: { fetch: FetchFn; token: () => Promise<string> }): GitHubClient {
  const http = createJsonClient({
    service: "github",
    baseUrl: "https://api.github.com",
    fetch: o.fetch,
    token: o.token,
    headers: { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "switchyard" },
    errorMessage: (b) => (b as { message?: string } | null)?.message,
  });
  const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    getViewer: () => http.request<{ login: string }>("/user"),
    async getRepo(owner, repo) {
      const r = await http.request<{
        id: number;
        name: string;
        owner: { id: number; login: string };
        default_branch: string;
        private: boolean;
      } | null>(repoPath(owner, repo), { allow404: true });
      if (!r) {
        throw new ApiError(
          "github",
          404,
          `Repository ${owner}/${repo} was not found, or the GitHub token can't access it. If it belongs to an organisation that uses SSO, authorise the token for that organisation (for gh: gh auth refresh).`,
        );
      }
      return {
        id: r.id,
        name: r.name,
        ownerId: r.owner.id,
        ownerLogin: r.owner.login,
        defaultBranch: r.default_branch,
        private: r.private,
      };
    },
    async getFile(owner, repo, path, ref) {
      const r = await http.request<{ type?: string; content?: string } | unknown[] | null>(
        `${repoPath(owner, repo)}/contents/${encodePath(path)}`,
        { query: { ref }, allow404: true },
      );
      if (!r || Array.isArray(r) || r.type !== "file" || typeof r.content !== "string") return null;
      return Buffer.from(r.content, "base64").toString("utf8");
    },
    async listDir(owner, repo, path, ref) {
      const r = await http.request<{ name: string }[] | null>(
        `${repoPath(owner, repo)}/contents/${encodePath(path)}`,
        { query: { ref }, allow404: true },
      );
      return Array.isArray(r) ? r.map((e) => e.name) : null;
    },
    async findOpenPr(owner, repo, branch) {
      const prs = await http.request<{ html_url: string; number: number }[]>(`${repoPath(owner, repo)}/pulls`, {
        query: { state: "open", head: `${owner}:${branch}` },
      });
      const pr = prs[0];
      return pr ? { url: pr.html_url, number: pr.number } : null;
    },
    async createPr(owner, repo, p) {
      const pr = await http.request<{ html_url: string; number: number }>(`${repoPath(owner, repo)}/pulls`, {
        method: "POST",
        body: p,
      });
      return { url: pr.html_url, number: pr.number };
    },
    async commentOnPr(owner, repo, number, body) {
      await http.request(`${repoPath(owner, repo)}/issues/${number}/comments`, { method: "POST", body: { body } });
    },
  };
}
