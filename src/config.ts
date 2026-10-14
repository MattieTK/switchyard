// Pinned vinext release used for Next.js conversions.
export const VINEXT_VERSION = "1.1.0";

// Branch Switchyard pushes conversion changes to. It must never be a production branch.
export const MIGRATION_BRANCH = "cloudflare-migration";

// Workers Builds trigger names. Switchyard finds its own triggers by these names.
export const PRODUCTION_TRIGGER = "switchyard-production";
export const PREVIEW_TRIGGER = "switchyard-preview";

// Where the user installs the Cloudflare GitHub App when Cloudflare can't see the repository.
export const GITHUB_APP_INSTALL_URL = "https://github.com/apps/cloudflare-workers-and-pages/installations/new";

export const PORT = 4417;
export const ORIGIN = `http://localhost:${PORT}`;
export const CLOUDFLARE_REDIRECT_URI = `${ORIGIN}/auth/cloudflare/callback`;

// Public PKCE client "Switchyard (local)" on the maintainer's Cloudflare account (no secret).
export const CLOUDFLARE_CLIENT_ID = "fd44d867323dfcafb07057f91e3730c1";

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
] as const;
