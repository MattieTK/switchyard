export interface CronJob {
  path: string;
  schedule: string;
}

export interface VercelJsonTranslation {
  crons: CronJob[];
  manual: string[];
}

const CRON_FIELDS = /^\S+(\s+\S+){4}$/;

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function translateVercelJson(raw: string | null): VercelJsonTranslation {
  if (raw === null) return { crons: [], manual: [] };
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { crons: [], manual: [`vercel.json couldn't be parsed (${(e as Error).message}), so nothing in it was translated.`] };
  }

  const crons: CronJob[] = [];
  const manual: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    if (key === "$schema") continue;
    if (key === "crons" && Array.isArray(value)) {
      for (const c of value as Partial<CronJob>[]) {
        if (typeof c.path === "string" && c.path.startsWith("/") && typeof c.schedule === "string" && CRON_FIELDS.test(c.schedule.trim())) {
          crons.push({ path: c.path, schedule: c.schedule.trim() });
        } else {
          manual.push(`Cron job ${JSON.stringify(c)} in vercel.json isn't valid, so it wasn't translated.`);
        }
      }
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
    manual.push(NOTES[key] ?? `\`${key}\` in vercel.json isn't translated.`);
  }
  return { crons, manual };
}
