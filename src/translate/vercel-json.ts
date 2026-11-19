export interface CronJob {
  path: string;
  schedule: string;
}

export type HtmlHandling = "force-trailing-slash" | "drop-trailing-slash" | "none";

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export interface ProxyRewrite {
  // Path prefix matched on incoming requests, e.g. "/api" (or "/" for root).
  prefix: string;
  // Upstream origin/path prefix, e.g. "https://api.example.com" or "https://api.example.com/v1".
  target: string;
  // Whether to forward the matched remainder after prefix (true for `/api/:path*` -> `https://.../:path*`).
  wildcard: boolean;
}

export interface VercelJsonTranslation {
  crons: CronJob[];
  manual: string[];
  redirects?: RedirectRule[];
  headers?: HeaderRule[];
  proxyRewrites?: ProxyRewrite[];
  htmlHandling?: HtmlHandling;
}

// Captures the first four fields (keeping their original spacing) and the day-of-week field.
const CRON_SCHEDULE = /^(\S+(?:\s+\S+){3}\s+)(\S+)$/;

type DayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Cloudflare reads weekdays as names. Standard cron numbers them from 0 (Sunday), and 7 also means Sunday.
const DAY_NAMES: Record<DayNumber, string> = { 0: "SUN", 1: "MON", 2: "TUE", 3: "WED", 4: "THU", 5: "FRI", 6: "SAT", 7: "SUN" };
const DAY_NUMBERS = new Map<string, DayNumber>([
  ["SUN", 0],
  ["MON", 1],
  ["TUE", 2],
  ["WED", 3],
  ["THU", 4],
  ["FRI", 5],
  ["SAT", 6],
]);

const NOTES: Record<string, string> = {
  functions:
    "`functions` (memory and duration limits) has no direct equivalent – Workers limits are set per plan and in `limits` in cloudflare.config.ts.",
  regions:
    "`regions` has no direct equivalent – Workers run in every Cloudflare location. Smart Placement is the closest option.",
  cleanUrls: "`cleanUrls` isn't translated – Next.js handles routes itself.",
  trailingSlash: "`trailingSlash` isn't translated – set `trailingSlash` in next.config.js instead.",
  images: "`images` settings aren't translated – image optimisation now uses Cloudflare Images.",
  buildCommand: "`buildCommand` isn't used – Switchyard sets the Cloudflare build commands.",
  installCommand: "`installCommand` isn't used – Workers Builds installs dependencies from the lockfile.",
  outputDirectory: "`outputDirectory` isn't used – the Cloudflare build output goes to .cloudflare/output.",
};

// Advice for apps whose routes are served by Workers static assets rather than Next.js. A key
// mapped to null needs nothing: Workers static assets already serve /about from about.html.
const ASSET_NOTES: Record<string, string | null> = {
  cleanUrls: null,
  trailingSlash: null,
  images: "`images` settings aren't translated – Vercel Image Optimization isn't available on Workers static assets.",
};

export interface VercelJsonOptions {
  // Whether Next.js serves the routes, so routing rules belong in next.config.js.
  nextjs: boolean;
  // Whether the converter follows the build settings vercel.json can override, as static sites do.
  buildSettings?: boolean;
}

// Settings vercel.json can set, which Vercel uses over the project's own.
const BUILD_SETTINGS = ["framework", "buildCommand", "outputDirectory"] as const;

// The build settings vercel.json overrides, leaving out any that aren't strings. A null
// framework in vercel.json means Other, so it's kept.
export function vercelJsonBuildSettings(
  raw: string | null,
): Partial<Record<(typeof BUILD_SETTINGS)[number], string | null>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const config = parsed as Record<string, unknown>;
  return Object.fromEntries(
    BUILD_SETTINGS.filter((k) => typeof config[k] === "string" || (k === "framework" && config[k] === null)).map((k) => [k, config[k]]),
  );
}

// Catch-all sources SPAs use in vercel.json to route non-file paths to index.html,
// including common negative-lookahead exclusions such as `/((?!api|assets).*)`.
const SPA_FALLBACK_PATTERNS = [
  /^\/\(\.\*\)$/,
  /^\/\(\.\+\)$/,
  /^\/\.\*$/,
  /^\/:[a-zA-Z_]\w*\*(?:\(\.\*\))?$/,
  /^\/:[a-zA-Z_]\w*\(\.\*\)$/,
  /^\/\(\(\?![^)]+\)\.\*\)$/,
  /^\/\(\?![^)]+\)\.\*$/,
  /^\/\(\[\^\.\]\*\)$/,
];

// A rewrite of every path to the app's index.html, which single-page apps on Vercel use so
// that client-side routes load. Workers static assets do the same with their
// single-page-application setting, which Switchyard sets for these apps.
export function isSpaFallback(rule: unknown): boolean {
  if (typeof rule !== "object" || rule === null) return false;
  const { source, destination, has, missing } = rule as Record<string, unknown>;
  if (has !== undefined || missing !== undefined) return false;
  if (typeof source !== "string" || (destination !== "/index.html" && destination !== "/")) return false;
  return SPA_FALLBACK_PATTERNS.some((re) => re.test(source));
}

// Legacy Vercel v2 `routes`: `{ handle: "filesystem" }` followed by a catch-all to `/index.html`.
function hasLegacySpaRoute(routes: unknown): boolean {
  if (!Array.isArray(routes)) return false;
  const fsIndex = routes.findIndex((r) => typeof r === "object" && r !== null && (r as Record<string, unknown>).handle === "filesystem");
  if (fsIndex === -1) return false;
  return routes.slice(fsIndex + 1).some((r) => {
    if (typeof r !== "object" || r === null) return false;
    const { src, dest, status } = r as Record<string, unknown>;
    return (
      status === undefined &&
      typeof src === "string" &&
      (dest === "/index.html" || dest === "/") &&
      SPA_FALLBACK_PATTERNS.some((re) => re.test(src))
    );
  });
}

// Whether vercel.json makes the site a single-page app with a catch-all rewrite or legacy route.
export function hasSpaFallback(raw: string | null): boolean {
  try {
    const parsed = JSON.parse(raw ?? "null") as { rewrites?: unknown; routes?: unknown } | null;
    return (Array.isArray(parsed?.rewrites) && parsed.rewrites.some(isSpaFallback)) || hasLegacySpaRoute(parsed?.routes);
  } catch {
    return false;
  }
}

const VALID_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Characters in a path segment that indicate a regex Cloudflare _redirects/_headers can't express.
const REGEX_META = /[()[\]{}?+\\^$|]/;

// Converts a Vercel redirect source/destination pair into Cloudflare Workers `_redirects` syntax,
// or returns null when the rule uses conditions or regex features `_redirects` can't represent.
function translateRedirectRule(rule: unknown): RedirectRule | null {
  if (typeof rule !== "object" || rule === null) return null;
  const { source, destination, permanent, statusCode, has, missing } = rule as Record<string, unknown>;
  if (has !== undefined || missing !== undefined) return null;
  if (typeof source !== "string" || typeof destination !== "string") return null;
  if (!source.startsWith("/") || /\s/.test(source) || /\s/.test(destination)) return null;
  if (!destination.startsWith("/") && !/^https?:\/\//.test(destination)) return null;

  let cfSource = source;
  let cfDest = destination;
  let splatName: string | null = null;
  const splatMatch = cfSource.match(/^(.*)\/(?::([a-zA-Z_]\w*)\*|\(\.\*\))$/);
  if (splatMatch) {
    cfSource = `${splatMatch[1] ?? ""}/*`;
    splatName = splatMatch[2] ?? "$1";
  } else if (cfSource.endsWith("/*")) {
    splatName = "*";
  }
  if (REGEX_META.test(cfSource) || cfSource.includes("*/*")) return null;
  // Wildcards are only allowed at the end of a Cloudflare _redirects source.
  if (cfSource.slice(0, -1).includes("*")) return null;

  if (splatName) {
    if (splatName === "$1") cfDest = cfDest.replace(/\$1/g, ":splat");
    else if (splatName !== "*") cfDest = cfDest.replace(new RegExp(`:${splatName}\\*?`, "g"), ":splat");
  }
  if (REGEX_META.test(cfDest.replace(/^https?:\/\//, ""))) return null;

  const status =
    typeof statusCode === "number" && VALID_REDIRECT_STATUSES.has(statusCode)
      ? statusCode
      : permanent === false
        ? 307
        : 308;
  return { source: cfSource, destination: cfDest, status };
}

// Converts a Vercel headers rule into Cloudflare Workers `_headers` syntax, or null when unsupported.
function translateHeaderRule(rule: unknown): HeaderRule | null {
  if (typeof rule !== "object" || rule === null) return null;
  const { source, headers, has, missing } = rule as Record<string, unknown>;
  if (has !== undefined || missing !== undefined) return null;
  if (typeof source !== "string" || !source.startsWith("/") || /\s/.test(source) || !Array.isArray(headers)) return null;

  let cfSource = source.replace(/\/(?::[a-zA-Z_]\w*\*|\(\.\*\))$/, "/*").replace(/:[a-zA-Z_]\w+/g, "*");
  if (REGEX_META.test(cfSource)) return null;
  const pairs: { key: string; value: string }[] = [];
  for (const h of headers) {
    if (typeof h !== "object" || h === null) return null;
    const { key, value } = h as Record<string, unknown>;
    if (typeof key !== "string" || typeof value !== "string" || !key.trim() || /[\r\n:]/.test(key) || /[\r\n]/.test(value)) {
      return null;
    }
    pairs.push({ key: key.trim(), value });
  }
  if (!pairs.length) return null;
  return { source: cfSource, headers: pairs };
}

// Converts an external proxy rewrite (e.g. `/api/:path*` -> `https://api.example.com/:path*`)
// into a ProxyRewrite for a generated proxy Worker, or null if not a simple external proxy.
function translateProxyRewrite(rule: unknown): ProxyRewrite | null {
  if (typeof rule !== "object" || rule === null) return null;
  const { source, destination, has, missing } = rule as Record<string, unknown>;
  if (has !== undefined || missing !== undefined) return null;
  if (typeof source !== "string" || typeof destination !== "string") return null;
  if (!source.startsWith("/") || !/^https?:\/\//.test(destination)) return null;

  const wild = source.match(/^(\/[a-zA-Z0-9._/-]*?)\/(?::([a-zA-Z_]\w*)\*|\(\.\*\))$/);
  if (wild) {
    const prefix = wild[1] || "/";
    const param = wild[2];
    const tailPattern = param ? new RegExp(`/:${param}\\*?$`) : /\/\$1$/;
    if (!tailPattern.test(destination)) return null;
    const target = destination.replace(tailPattern, "");
    if (!/^https?:\/\/[^/\s]+/.test(target)) return null;
    return { prefix, target, wildcard: true };
  }
  if (!REGEX_META.test(source) && !source.includes(":") && !source.includes("*")) {
    return { prefix: source, target: destination, wildcard: false };
  }
  return null;
}

export function formatRedirectsFile(rules: readonly RedirectRule[]): string {
  return `${rules.map((r) => `${r.source} ${r.destination} ${r.status}`).join("\n")}\n`;
}

export function formatHeadersFile(rules: readonly HeaderRule[]): string {
  return `${rules.map((r) => `${r.source}\n${r.headers.map((h) => `  ${h.key}: ${h.value}`).join("\n")}`).join("\n\n")}\n`;
}

const RULE_MARKER = "# Added by Switchyard from vercel.json";

export function mergeAssetRules(existing: string, generated: string): string {
  const clean = generated.trimEnd();
  if (!clean) return existing;
  if (existing.includes(RULE_MARKER)) {
    const idx = existing.indexOf(RULE_MARKER);
    const before = existing.slice(0, idx).trimEnd();
    return before ? `${before}\n\n${RULE_MARKER}\n${clean}\n` : `${RULE_MARKER}\n${clean}\n`;
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${RULE_MARKER}\n${clean}\n` : `${RULE_MARKER}\n${clean}\n`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Returns the day for a number from 0 to 7 or a three-letter name, or null for anything else.
function dayNumber(token: string): DayNumber | null {
  if (/^[0-7]$/.test(token)) return Number(token) as DayNumber;
  return DAY_NUMBERS.get(token.toUpperCase()) ?? null;
}

// Translates one range, `*` or single day, without any step.
function translateDayRange(base: string): string | null {
  if (base === "*") return "*";
  const [start = "", end, ...extra] = base.split("-");
  const from = dayNumber(start);
  if (extra.length > 0 || from === null) return null;
  if (end === undefined) return DAY_NAMES[from];
  // 7 is Sunday in standard cron, so a range ending in 7 would read as `MON-SUN` rather than the rest of the week,
  // and `0-7` would read as `SUN-SUN`. Those, and reversed ranges, are rejected rather than guessed at.
  const to = dayNumber(end);
  if (to === null || from === 7 || to === 7 || from > to) return null;
  return `${DAY_NAMES[from]}-${DAY_NAMES[to]}`;
}

// Translates one comma-separated part of the day-of-week field. A step after `/` is a count, so it is kept as written.
function translateDayPart(part: string): string | null {
  const [base = "", step, ...extra] = part.split("/");
  if (extra.length > 0 || (step !== undefined && !/^[1-9]\d*$/.test(step))) return null;
  const range = translateDayRange(base);
  if (range === null) return null;
  return step === undefined ? range : `${range}/${step}`;
}

function translateDayOfWeek(field: string): string | null {
  const parts = field.split(",").map(translateDayPart);
  return parts.every((p): p is string => p !== null) ? parts.join(",") : null;
}

// Returns the schedule with its day-of-week field translated, or null if the schedule is malformed.
function translateSchedule(raw: string): string | null {
  const match = CRON_SCHEDULE.exec(raw.trim());
  const head = match?.[1];
  const dayField = match?.[2];
  if (head === undefined || dayField === undefined) return null;
  const day = translateDayOfWeek(dayField);
  return day === null ? null : head + day;
}

export function translateVercelJson(raw: string | null, options: VercelJsonOptions = { nextjs: true }): VercelJsonTranslation {
  if (raw === null) return { crons: [], manual: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { crons: [], manual: [`vercel.json couldn't be parsed (${(e as Error).message}), so nothing in it was translated.`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { crons: [], manual: ["vercel.json isn't a JSON object, so nothing in it was translated."] };
  }
  const config = parsed as Record<string, unknown>;

  const crons: CronJob[] = [];
  const manual: string[] = [];
  const redirects: RedirectRule[] = [];
  const headers: HeaderRule[] = [];
  const proxyRewrites: ProxyRewrite[] = [];
  let htmlHandling: HtmlHandling | undefined;

  if (!options.nextjs) {
    if (config.trailingSlash === true) htmlHandling = "force-trailing-slash";
    else if (config.trailingSlash === false) htmlHandling = "drop-trailing-slash";
    else if (config.cleanUrls === false) htmlHandling = "none";
  }

  for (const [key, value] of Object.entries(config)) {
    if (key === "$schema") continue;
    if (key === "crons" && Array.isArray(value)) {
      for (const c of value as (Partial<CronJob> | null)[]) {
        const schedule = typeof c?.schedule === "string" ? translateSchedule(c.schedule) : null;
        if (typeof c?.path === "string" && c.path.startsWith("/") && schedule !== null) {
          crons.push({ path: c.path, schedule });
        } else {
          manual.push(`Cron job ${JSON.stringify(c)} in vercel.json isn't valid, so it wasn't translated.`);
        }
      }
      continue;
    }
    if (!options.nextjs && key === "redirects" && Array.isArray(value)) {
      let skipped = 0;
      for (const r of value) {
        const translated = translateRedirectRule(r);
        if (translated) redirects.push(translated);
        else skipped++;
      }
      if (skipped) {
        manual.push(
          `${plural(skipped, "redirect", "redirects")} in vercel.json couldn't be converted to \`_redirects\` automatically (for example, conditional or regex rules) – recreate ${skipped === 1 ? "it" : "them"} manually.`,
        );
      }
      continue;
    }
    if (!options.nextjs && key === "headers" && Array.isArray(value)) {
      let skipped = 0;
      for (const r of value) {
        const translated = translateHeaderRule(r);
        if (translated) headers.push(translated);
        else skipped++;
      }
      if (skipped) {
        manual.push(
          `${plural(skipped, "header rule", "header rules")} in vercel.json couldn't be converted to \`_headers\` automatically – recreate ${skipped === 1 ? "it" : "them"} manually.`,
        );
      }
      continue;
    }
    if (!options.nextjs && key === "rewrites" && Array.isArray(value)) {
      let skipped = 0;
      for (const r of value) {
        if (isSpaFallback(r)) continue;
        const proxy = translateProxyRewrite(r);
        if (proxy) proxyRewrites.push(proxy);
        else skipped++;
      }
      if (skipped) {
        manual.push(
          `${plural(skipped, "rewrite", "rewrites")} in vercel.json – recreate ${skipped === 1 ? "it" : "them"} in the app, since Workers static assets don't rewrite internal paths.`,
        );
      }
      continue;
    }
    if (options.buildSettings && (BUILD_SETTINGS as readonly string[]).includes(key)) continue;
    if (!options.nextjs && Object.hasOwn(ASSET_NOTES, key)) {
      const note = ASSET_NOTES[key];
      if (note) manual.push(note);
      continue;
    }
    if ((key === "redirects" || key === "rewrites" || key === "headers") && Array.isArray(value)) {
      const n = value.length;
      const [one, many, fn] =
        key === "redirects"
          ? ["redirect", "redirects", "redirects()"]
          : key === "rewrites"
            ? ["rewrite", "rewrites", "rewrites()"]
            : ["header rule", "header rules", "headers()"];
      manual.push(`${plural(n, one, many)} in vercel.json – add ${n === 1 ? "it" : "them"} to \`${fn}\` in next.config.js.`);
      continue;
    }
    const note = Object.hasOwn(NOTES, key) ? NOTES[key] : undefined;
    manual.push(note ?? `\`${key}\` in vercel.json isn't translated.`);
  }
  return {
    crons,
    manual,
    ...(redirects.length ? { redirects } : {}),
    ...(headers.length ? { headers } : {}),
    ...(proxyRewrites.length ? { proxyRewrites } : {}),
    ...(htmlHandling ? { htmlHandling } : {}),
  };
}
