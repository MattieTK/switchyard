import type { ScopeProbe, VercelTeam } from "../clients/vercel.ts";

export type TokenScope = { kind: "account"; teams: VercelTeam[] } | { kind: "team" } | { kind: "limited" };

// Rule confirmed (or adjusted) by spike 4 in docs/spikes.md.
export function inferTokenScope(p: ScopeProbe): TokenScope {
  if (!p.projectsOk) return { kind: "limited" };
  if (p.userOk) return { kind: "account", teams: p.teams ?? [] };
  return { kind: "team" };
}
