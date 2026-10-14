// Spike helper: run with SWITCHYARD_HOME=/some/scratch node scripts/spike-login.ts
import { createServer } from "node:http";
import { buildAuthorizeUrl, createPendingAuthStore, exchangeCode } from "../src/auth/cloudflare-oauth.ts";
import { createCredentialStore } from "../src/auth/store.ts";
import { CLOUDFLARE_CLIENT_ID, CLOUDFLARE_REDIRECT_URI, CLOUDFLARE_SCOPES, PORT } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

const store = createCredentialStore(resolvePaths().credentialsFile);
const pending = createPendingAuthStore();
const { state, challenge } = pending.create();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/auth/cloudflare/callback") return res.writeHead(404).end();
  const verifier = pending.take(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!verifier || !code) return res.writeHead(400).end(`Login failed: ${url.searchParams.get("error_description") ?? "bad state"}`);
  const t = await exchangeCode(fetch, { clientId: CLOUDFLARE_CLIENT_ID, redirectUri: CLOUDFLARE_REDIRECT_URI, code, verifier });
  await store.update((c) => ({ ...c, cloudflare: t }));
  res.end("Logged in. You can close this tab.");
  console.log(`Token stored; expires ${new Date(t.expiresAt).toISOString()}; refresh token: ${t.refreshToken ? "yes" : "no"}`);
  server.close();
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(buildAuthorizeUrl({ clientId: CLOUDFLARE_CLIENT_ID, redirectUri: CLOUDFLARE_REDIRECT_URI, scopes: CLOUDFLARE_SCOPES, state, challenge }));
});
