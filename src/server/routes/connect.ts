import { Hono } from "hono";
import { z } from "zod";
import { buildAuthorizeUrl, exchangeCode } from "../../auth/cloudflare-oauth.ts";
import { createCloudflareClient, readOnlyAccountMessage, type CloudflareAccount } from "../../clients/cloudflare.ts";
import { createGitHubClient } from "../../clients/github.ts";
import { createVercelClient, probeVercelToken, type ScopeProbe, type VercelTeam } from "../../clients/vercel.ts";
import { UserInputError } from "../../errors.ts";
import { isAuthError } from "../../http.ts";
import { inferTokenScope } from "../../translate/token-scope.ts";
import type { AppDeps } from "../app.ts";
import { tokenGuard } from "../guard.ts";

export interface ConnectionStatus {
  vercel:
    | { connected: false }
    | { connected: true; scope: "account" | "team"; username?: string; teamId?: string; teamName?: string; teams: VercelTeam[] };
  cloudflare:
    | { connected: false; error?: string }
    | { connected: true; email?: string; accountId?: string; accountName?: string; accounts: CloudflareAccount[] };
  github: { connected: false; error?: string } | { connected: true; source: "gh" | "pat"; login: string };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function connectRoutes(d: AppDeps): Hono {
  const r = new Hono();

  r.get("/api/status", async (c) => {
    const creds = await d.store.read();

    const vercel = async (): Promise<ConnectionStatus["vercel"]> => {
      if (!creds.vercel) return { connected: false };
      const { token: _token, ...rest } = creds.vercel;
      const teams = rest.scope === "account" ? await (await d.clients.vercel()).listTeams().catch(() => []) : [];
      return { connected: true, ...rest, teams };
    };
    const cloudflare = async (): Promise<ConnectionStatus["cloudflare"]> => {
      if (!creds.cloudflare) return { connected: false };
      try {
        const accounts = await d.clients.cloudflare.listAccounts();
        const { email, accountId, accountName } = creds.cloudflare;
        return { connected: true, email, accountId, accountName, accounts };
      } catch (e) {
        if (isAuthError(e)) return { connected: false, error: e.message };
        throw e;
      }
    };
    const github = async (): Promise<ConnectionStatus["github"]> => {
      try {
        const auth = await d.clients.githubAuth();
        const { login } = await (await d.clients.github()).getViewer();
        return { connected: true, source: auth.source, login };
      } catch (e) {
        return { connected: false, error: errorText(e) };
      }
    };

    const [v, cf, gh] = await Promise.all([vercel(), cloudflare(), github()]);
    // JSON drops undefined fields, so the browser sees only what is known.
    return c.json({ vercel: v, cloudflare: cf, github: gh } satisfies ConnectionStatus);
  });

  r.post("/api/vercel/token", async (c) => {
    const { token } = z.object({ token: z.string().trim().min(1) }).parse(await c.req.json());
    let probe: ScopeProbe;
    try {
      probe = await probeVercelToken(createVercelClient({ fetch: d.fetch, token }));
    } catch (e) {
      if (isAuthError(e)) {
        throw new UserInputError("Vercel rejected this token. Check that you copied all of it and that it hasn't expired.");
      }
      throw e;
    }
    const scope = inferTokenScope(probe);
    if (scope.kind === "limited") {
      throw new UserInputError(
        "This token can't list projects. Create one scoped to a team with All Projects selected, or to Full Account.",
      );
    }
    // A team-scoped token can read /v2/user and sees only its own team, so
    // there is nothing for the user to choose.
    const onlyTeam = scope.kind === "account" && scope.teams.length === 1 ? scope.teams[0] : undefined;
    await d.store.update((cr) => ({
      ...cr,
      vercel: {
        token,
        scope: scope.kind,
        ...(probe.user ? { username: probe.user.username } : {}),
        ...(onlyTeam ? { teamId: onlyTeam.id, teamName: onlyTeam.name } : {}),
      },
    }));
    return c.json({
      ok: true,
      scope: scope.kind,
      warning: token.startsWith("vcp_")
        ? undefined
        : "This doesn't look like a current Vercel token (they start with vcp_). It worked, so Switchyard will use it.",
    });
  });

  r.post("/api/vercel/team", async (c) => {
    const { teamId } = z.object({ teamId: z.string().nullable() }).parse(await c.req.json());
    const team = teamId ? (await (await d.clients.vercel()).listTeams()).find((t) => t.id === teamId) : null;
    if (teamId && !team) throw new UserInputError("This token can't see that team.");
    await d.store.update((cr) => {
      if (!cr.vercel) throw new UserInputError("Connect Vercel first.");
      const { teamId: _id, teamName: _name, ...rest } = cr.vercel;
      return { ...cr, vercel: team ? { ...rest, teamId: team.id, teamName: team.name } : rest };
    });
    return c.json({ ok: true });
  });

  r.delete("/api/vercel", async (c) => {
    await d.store.update(({ vercel: _v, ...rest }) => rest);
    return c.json({ ok: true });
  });

  r.post("/api/github/pat", async (c) => {
    const { token } = z.object({ token: z.string().trim().min(1) }).parse(await c.req.json());
    let login: string;
    try {
      ({ login } = await createGitHubClient({ fetch: d.fetch, token: async () => token }).getViewer());
    } catch (e) {
      if (isAuthError(e)) throw new UserInputError("GitHub rejected this token.");
      throw e;
    }
    await d.store.update((cr) => ({ ...cr, githubPat: token }));
    return c.json({ ok: true, login });
  });

  r.delete("/api/github", async (c) => {
    await d.store.update(({ githubPat: _p, ...rest }) => rest);
    return c.json({ ok: true });
  });

  r.get("/auth/cloudflare/start", tokenGuard(d.launchToken), (c) => {
    const { state, challenge } = d.oauth.pending.create();
    return c.redirect(
      buildAuthorizeUrl({
        clientId: d.oauth.clientId,
        redirectUri: d.oauth.redirectUri,
        scopes: d.oauth.scopes,
        state,
        challenge,
      }),
    );
  });

  // Not behind the token guard: Cloudflare redirects here. The state
  // parameter, known only to this server, authenticates the request instead.
  r.get("/auth/cloudflare/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    const q = c.req.query();
    // Take the state first, on every path: the launch token is only handed
    // back to a request that proves it knows a state this server issued.
    const verifier = d.oauth.pending.take(q.state ?? "");
    if (!verifier) {
      return c.redirect(`/#/connect?error=${encodeURIComponent("The login link expired or was already used. Try again.")}`);
    }
    const back = (error?: string) =>
      c.redirect(`/?t=${encodeURIComponent(d.launchToken)}#/connect${error ? `?error=${encodeURIComponent(error)}` : ""}`);
    if (q.error) return back(q.error_description ?? q.error);
    if (!q.code) return back("The login link expired or was already used. Try again.");
    try {
      const tokens = await exchangeCode(d.fetch, {
        clientId: d.oauth.clientId,
        redirectUri: d.oauth.redirectUri,
        code: q.code,
        verifier,
      });
      const cf = createCloudflareClient({ fetch: d.fetch, token: async () => tokens.accessToken });
      const user = await cf.getUser();
      const accounts = await cf.listAccounts();
      // Pick an account only when exactly one can take a deploy.
      const deployable = accounts.filter((a) => a.canDeployWorkers);
      const only = deployable.length === 1 ? deployable[0] : undefined;
      await d.store.update((cr) => ({
        ...cr,
        cloudflare: {
          ...tokens,
          email: user.email,
          ...(only ? { accountId: only.id, accountName: only.name } : {}),
        },
      }));
      return back();
    } catch (e) {
      return back(errorText(e));
    }
  });

  r.post("/api/cloudflare/account", async (c) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(await c.req.json());
    const account = (await d.clients.cloudflare.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new UserInputError("You don't have access to that Cloudflare account.");
    if (!account.canDeployWorkers) throw new UserInputError(`${readOnlyAccountMessage(account.name)}.`);
    await d.store.update((cr) => {
      if (!cr.cloudflare) throw new UserInputError("Log in with Cloudflare first.");
      return { ...cr, cloudflare: { ...cr.cloudflare, accountId: account.id, accountName: account.name } };
    });
    return c.json({ ok: true });
  });

  r.delete("/api/cloudflare", async (c) => {
    await d.store.update(({ cloudflare: _cf, ...rest }) => rest);
    return c.json({ ok: true });
  });

  return r;
}
