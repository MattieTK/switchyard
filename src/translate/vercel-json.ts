export interface CronJob {
  path: string;
  schedule: string;
}

export interface VercelJsonTranslation {
  crons: CronJob[];
  manual: string[];
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

export function translateVercelJson(raw: string | null): VercelJsonTranslation {
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
  return { crons, manual };
}
