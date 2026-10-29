import { Hono } from "hono";
import { z } from "zod";
import { buildAuthorizeUrl, exchangeCode } from "../../auth/cloudflare-oauth.ts";
import { createCloudflareClient, readOnlyAccountMessage, type CloudflareAccount } from "../../clients/cloudflare.ts";
import { createGitHubClient } from "../../clients/github.ts";
import { DEVICE_CODE_TTL_MS, pollDeviceCode, requestDeviceCode, type DeviceCode } from "../../auth/openai-oauth.ts";
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
  // Optional: fixes build and deploy errors when connected.
  openai:
    | { connected: false; error?: string }
    | { connected: true; via: "chatgpt" | "apikey"; email?: string; plan?: string; model: string; models: string[] };
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

    const openai = async (): Promise<ConnectionStatus["openai"]> => {
      const saved = creds.openai;
      const connected = await d.clients.openai();
      if (!saved || !connected) return { connected: false };
      const { model } = saved;
      const who =
        saved.kind === "chatgpt"
          ? { via: "chatgpt" as const, ...(saved.email ? { email: saved.email } : {}), ...(saved.plan ? { plan: saved.plan } : {}) }
          : { via: "apikey" as const };
      try {
        const models = await connected.client.listModels();
        // A model OpenAI has since retired stays listed, so the select can show what's chosen.
        return { connected: true, ...who, model, models: models.includes(model) ? models : [model, ...models] };
      } catch (e) {
        if (isAuthError(e)) return { connected: false, error: e.message };
        // Still connected when OpenAI can't be reached; the saved model is the only one shown.
        return { connected: true, ...who, model, models: [model] };
      }
    };

    const [v, cf, gh, ai] = await Promise.all([vercel(), cloudflare(), github(), openai()]);
    // JSON drops undefined fields, so the browser sees only what is known.
    return c.json({ vercel: v, cloudflare: cf, github: gh, openai: ai } satisfies ConnectionStatus);
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

  // Whether OpenAI is connected, from the saved credentials alone, for pages that only need that.
  r.get("/api/openai", async (c) => {
    const saved = (await d.store.read()).openai;
    return c.json(saved ? { connected: true, via: saved.kind, model: saved.model } : { connected: false });
  });

  r.post("/api/openai/key", async (c) => {
    const { apiKey } = z.object({ apiKey: z.string().trim().min(1).max(500) }).parse(await c.req.json());
    let models: string[];
    try {
      models = await d.clients.openaiWith(apiKey).listModels();
    } catch (e) {
      if (isAuthError(e)) {
        throw new UserInputError("OpenAI rejected this key. Check that you copied all of it and that it hasn't been revoked.");
      }
      throw e;
    }
    const [model] = models;
    if (!model) throw new UserInputError("This key can't use any OpenAI model that writes code. Check the project's model access.");
    await d.store.update((cr) => ({ ...cr, openai: { kind: "apikey", apiKey, model } }));
    return c.json({ ok: true, model });
  });

  // Sign in with ChatGPT: the browser shows the code from start, the user enters it at OpenAI,
  // and the browser polls until OpenAI says it was entered. One sign-in waits at a time.
  let device: { code: DeviceCode; startedAt: number } | null = null;

  r.post("/api/openai/device", async (c) => {
    const code = await requestDeviceCode(d.fetch);
    device = { code, startedAt: Date.now() };
    return c.json({ userCode: code.userCode, verificationUrl: code.verificationUrl, interval: code.interval });
  });

  r.post("/api/openai/device/poll", async (c) => {
    const waiting = device;
    if (!waiting || Date.now() - waiting.startedAt > DEVICE_CODE_TTL_MS) {
      device = null;
      throw new UserInputError("The sign-in code expired. Start again.", 409);
    }
    const tokens = await pollDeviceCode(d.fetch, waiting.code);
    if (!tokens) return c.json({ status: "pending" });
    if (device === waiting) device = null;
    const [model] = await d.clients.chatgptWith(tokens).listModels();
    if (!model) {
      throw new UserInputError("Your ChatGPT plan doesn't include Codex models. Use a plan that includes Codex, or an API key.");
    }
    await d.store.update((cr) => ({ ...cr, openai: { kind: "chatgpt", model, ...tokens } }));
    return c.json({ status: "connected", model });
  });

  r.post("/api/openai/model", async (c) => {
    const { model } = z.object({ model: z.string().min(1) }).parse(await c.req.json());
    const connected = await d.clients.openai();
    if (!connected) throw new UserInputError("Connect OpenAI first.");
    if (!(await connected.client.listModels()).includes(model)) throw new UserInputError(`You can't use ${model} with this sign-in.`);
    await d.store.update((cr) => {
      if (!cr.openai) throw new UserInputError("Connect OpenAI first.");
      return { ...cr, openai: { ...cr.openai, model } };
    });
    return c.json({ ok: true });
  });

  r.delete("/api/openai", async (c) => {
    await d.store.update(({ openai: _o, ...rest }) => rest);
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
