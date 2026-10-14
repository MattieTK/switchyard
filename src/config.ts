// Pinned vinext release used for Next.js conversions.
export const VINEXT_VERSION = "1.1.0";

// Branch Switchyard pushes conversion changes to. It must never be a production branch.
export const MIGRATION_BRANCH = "cloudflare-migration";

// Workers Builds trigger names. Switchyard finds its own triggers by these names.
export const PRODUCTION_TRIGGER = "switchyard-production";
export const PREVIEW_TRIGGER = "switchyard-preview";

// Where the user installs the Cloudflare GitHub App when Cloudflare can't see the repository.
export const GITHUB_APP_INSTALL_URL = "https://github.com/apps/cloudflare-workers-and-pages/installations/new";
