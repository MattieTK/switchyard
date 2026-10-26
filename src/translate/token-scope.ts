import type { ScopeProbe, VercelTeam } from "../clients/vercel.ts";

export type TokenScope = { kind: "account"; teams: VercelTeam[] } | { kind: "team" } | { kind: "limited" };

// Checked against Vercel on 2026-10-14: team-scoped tokens can read /v2/user, so they look like
// full-account tokens; the connect route auto-selects a single team.
export function inferTokenScope(p: ScopeProbe): TokenScope {
  if (!p.projectsOk) return { kind: "limited" };
  if (p.userOk) return { kind: "account", teams: p.teams ?? [] };
  return { kind: "team" };
}
