// Pinned vinext release used for Next.js conversions.
export const VINEXT_VERSION = "1.1.0";

// Next.js release older apps are upgraded to before conversion, since vinext targets Next.js 16.
// The same version of @next/codemod runs the upgrade.
export const NEXT_UPGRADE_VERSION = "16.4.1";

// Branch Switchyard pushes conversion changes to. It must never be a production branch.
export const MIGRATION_BRANCH = "cloudflare-migration";

// Workers Builds trigger names. Switchyard finds its own triggers by these names.
export const PRODUCTION_TRIGGER = "switchyard-production";
export const PREVIEW_TRIGGER = "switchyard-preview";

// SWITCHYARD_PORT and SWITCHYARD_CLOUDFLARE_CLIENT_ID are for development, so a second copy can
// run beside a normal one (with SWITCHYARD_HOME for its data). Another port needs an OAuth
// client that lists that port's callback URL.
const portOverride = Number.parseInt(process.env.SWITCHYARD_PORT ?? "", 10);
export const PORT = Number.isInteger(portOverride) && portOverride > 0 ? portOverride : 4417;
export const ORIGIN = `http://localhost:${PORT}`;
export const CLOUDFLARE_REDIRECT_URI = `${ORIGIN}/auth/cloudflare/callback`;

// Public PKCE client "Switchyard (local)" on the maintainer's Cloudflare account (no secret).
export const CLOUDFLARE_CLIENT_ID = process.env.SWITCHYARD_CLOUDFLARE_CLIENT_ID || "fd44d867323dfcafb07057f91e3730c1";

// offline_access asks for a refresh token; without it the session ends after an hour.
export const CLOUDFLARE_SCOPES = [
  "offline_access",
  "user-details.read",
  "memberships.read",
  "account-settings.read",
  "workers-scripts.write",
  "workers-ci.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "d1.write",
  "zone.read",
  "dns.read",
  "workers-routes.write",
  // Creates the API token behind a Workers Builds token for a user who has none. The OAuth
  // client must allow it too, or Cloudflare rejects the whole request with invalid_scope.
  "account-api-tokens.write",
] as const;
