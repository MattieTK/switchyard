# Spike results – 2026-10-14

These checks ran against the live APIs on 2026-10-14, using `cf` 1.0.0-beta.14 locally and `cf` 1.0.0-beta.17 in converted projects, vinext 1.1.0 for `init` (1.2.0 ended up installed), the Cloudflare account "Mattietk@gmail.com's Account" and a Vercel team-scoped token.

Test resources:
- Worker `switchyard-spike`
- KV namespace `switchyard-spike-vinext-kv-cache`
- private repo `MattieTK/switchyard-spike`
- Builds trigger `switchyard-production` on that repo

## OAuth client

The client was created through the dashboard: public, PKCE, auth method `none`, redirect `http://localhost:4417/auth/cloudflare/callback`.

- `cf` can't create the client, because OAuth tokens have no OAuth-client scope (403). The dashboard can.
- The dashboard's Workers "Edit" box maps to `workers-scripts.edit` (Workers Editor). That scope can't upload Worker assets: `cf deploy` failed with 403 at "Starting asset upload". The client was changed to `workers-scripts.write`, which is the scope `cf`'s own login requests. The dashboard UI can't select it, so the scope list in the dashboard's edit request was rewritten before it was sent.
- Without `offline_access` in the authorise request, no refresh token comes back and the access token lasts an hour. `CLOUDFLARE_SCOPES` now includes `offline_access`.

## Spike 1 – `cf deploy` with an OAuth token: passes

`CLOUDFLARE_API_TOKEN=<OAuth access token>` together with `CLOUDFLARE_ACCOUNT_ID` deploys a vinext app. The deploy also provisions the `VINEXT_KV_CACHE` namespace. The output includes `https://<worker>.<subdomain>.workers.dev`, which the deploy step's pattern matches.

## Spike 2 – Workers Builds running `cf`: passes

A trigger with build command `pnpm exec cf build` and deploy command `pnpm exec cf deploy --prebuilt` built and deployed using the account's existing build token.

Build status values seen:
- `queued` / `null`
- `running` / `null`
- `stopped` / `success`

`interpretBuild` handles all of these.

`cf` has no command that builds and uploads a preview version (only the raw `cf workers versions create` API), so the preview trigger keeps its build-only deploy command for now.

The `repos/connections` PUT succeeded straight away, because the Cloudflare GitHub App was already installed on the account.

## Spike 3 – secrets surviving later deploys: passes

A secret uploaded with `--secrets-file` was still present after:
- a local `cf deploy` without the flag;
- a Workers Builds `cf deploy --prebuilt`.

The Worker's `/secrets` endpoint lists it as `secret_text`.

## Spike 4 – Vercel token reach: two findings

- A token scoped to a team ("All Projects") gets 200 from `/v2/user`, `/v2/teams` (which returns only its team) and `/v9/projects`. It therefore looks like a full-account token. The connect route now picks the only team automatically.
- **Critical:** `GET /v10/projects/{id}/env?decrypt=true` returns ciphertext for `encrypted` variables (`decrypted: false`, about 992 characters). Only `GET /v1/projects/{id}/env/{envId}` returns the plaintext (`decrypted: true`). The Vercel client now reads each variable from that endpoint, and the env plan counts a value only when it is plain or decrypted.

## Spike 5 – OAuth token and the Builds API: passes

The OAuth token works for `/user`, `/accounts`, `/zones`, `/workers/scripts` and the Builds endpoints (tokens, repo connections, triggers, builds, logs). `/workers/scripts` returned all 235 scripts in one response.

## Spike 6 – cron wrapper at runtime: passes

The generated `switchyard-entry.ts` runs the route's `scheduled` handler under `cf dev`. Locally, the trigger is `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=<name>` with `{"cron": "..."}`. The older `/cdn-cgi/handler/scheduled` endpoint doesn't apply here.

## Other observations

- `vinext init` writes `"vinext": "^1.1.0"`, so a new release (1.2.0) was installed. The pin applies to `init` only.
- `cf dev` only exposes `.dev.vars` keys that are declared with `bindings.secret()`. Development-only variables aren't declared, so they are missing locally. This is a known gap for now.

## Spike 7 – package manager version in Workers Builds: reads `packageManager` (2026-10-23)

A converted pnpm app with `"packageManager": "pnpm@9.15.9"` was built three times on the account "Mattietk@gmail.com's Account". The temporary Worker, trigger and repo connection were deleted afterwards. The build command printed `pnpm --version` before `cf build`.

- With no build variables, the build log said "Detected the following tools from environment: pnpm@9.15.9", installed with pnpm v9.15.9 and printed `9.15.9`. Workers Builds' default would have been 10.11.1, so it reads `packageManager`.
- With `PNPM_VERSION=9.14.4` on the trigger, it still used 9.15.9. When both are set, `packageManager` wins.

Switchyard therefore only writes `packageManager` (the pnpm switch, the Yarn 1 pin) and sets no version variables.

Two notes on `cf` 1.0.0-beta.20 from this run: list-valued flags can't express an empty list (`[]` is sent as the string `"[]"`), so trigger bodies need `--body` with raw JSON, and deletes need `--force` when not interactive.
