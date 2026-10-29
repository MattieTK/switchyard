// cf build runs the framework's build itself and never the project's build script, so
// steps an app runs before its framework's build (prisma generate, tsc -b, a prebuild script
// that writes data files) would be skipped. Switchyard keeps them in a script of its own.

export const CLOUDFLARE_BUILD_SCRIPT = "build:cloudflare";

// The framework build command that cf build replaces.
export interface FrameworkBuild {
  // As written in the messages, such as `next build`.
  command: string;
  // Whose build output the steps after it expect, such as Next.js.
  label: string;
  // The command with any flags, after optional words such as `cross-env` or VAR=value, which
  // the first group captures.
  pattern: RegExp;
}

export const NEXT_BUILD: FrameworkBuild = { command: "next build", label: "Next.js", pattern: /^(.*?)\bnext\s+build\b.*$/ };

// Operators other than &&, which can't be split into steps safely.
const OTHER_OPERATORS = /[|;`]|\$\(|(?<!&)&(?!&)/;

// Scripts calling scripts deeper than this are left as they are.
const MAX_DEPTH = 5;

type Scripts = Readonly<Record<string, string>>;

// The scripts a step runs one after another, when it does nothing else: `npm run a`,
// `pnpm a`, `yarn a`, `bun run a`, `run-s a b` or `npm-run-all a "b:*"`. Null for anything else.
function scriptsRunBy(step: string, scripts: Scripts): string[] | null {
  const words = step.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
  const [tool = "", ...args] = words;
  let names: string[];
  if (["npm", "pnpm", "yarn", "bun"].includes(tool) && (args[0] === "run" || args[0] === "run-script")) {
    names = args.slice(1, 2);
    if (args.length !== 2) return null;
  } else if ((tool === "pnpm" || tool === "yarn") && args.length === 1 && Object.hasOwn(scripts, args[0] ?? "")) {
    names = args;
  } else if (tool === "run-s" || tool === "npm-run-all") {
    // npm-run-all runs its names in order unless told to run them in parallel.
    const flags = args.filter((a) => a.startsWith("-"));
    if (flags.some((f) => !["-s", "--sequential", "--serial"].includes(f))) return null;
    names = args.filter((a) => !a.startsWith("-")).flatMap((pattern) => matchScripts(pattern, scripts));
  } else {
    return null;
  }
  return names.length && names.every((n) => Object.hasOwn(scripts, n)) ? names : null;
}

// npm-run-all's patterns: `*` matches within one `:` segment and `**` across segments.
function matchScripts(pattern: string, scripts: Scripts): string[] {
  if (!pattern.includes("*")) return [pattern];
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^:]*"))
    .join(".*");
  const regex = new RegExp(`^${source}$`);
  return Object.keys(scripts).filter((name) => regex.test(name));
}

interface Flattened {
  before: string[];
  // The step that runs the framework's build, or null when the script doesn't reach it.
  nextBuild: string | null;
  after: string[];
}

// Splits a script into the steps before and after the one that runs the framework's build,
// following scripts it calls. Returns null when the script can't be read safely.
function flatten(
  command: string,
  scripts: Scripts,
  runScript: (name: string) => string,
  framework: FrameworkBuild,
  depth: number,
): Flattened | null {
  if (depth > MAX_DEPTH || OTHER_OPERATORS.test(command)) return null;
  const result: Flattened = { before: [], nextBuild: null, after: [] };
  for (const step of command.split("&&").map((s) => s.trim())) {
    const add = (steps: readonly string[]) => (result.nextBuild === null ? result.before : result.after).push(...steps);
    if (framework.pattern.test(step)) {
      if (result.nextBuild !== null) return null;
      result.nextBuild = step;
      continue;
    }
    const called = scriptsRunBy(step, scripts);
    const inner = called?.map((name) => ({ name, flat: flatten(scripts[name] ?? "", scripts, runScript, framework, depth + 1) }));
    const reaching = inner?.filter((i) => i.flat?.nextBuild);
    // Calls that don't reach the framework's build stay as they were written.
    if (!called || !inner || !reaching?.length) {
      add([step]);
      continue;
    }
    if (reaching.length > 1 || result.nextBuild !== null) return null;
    for (const { name, flat } of inner) {
      if (!flat?.nextBuild) {
        add([runScript(name)]);
        continue;
      }
      // npm runs a script's pre-script before it.
      result.before.push(...(scripts[`pre${name}`] ? [runScript(`pre${name}`)] : []), ...flat.before);
      result.nextBuild = flat.nextBuild;
      result.after.push(...flat.after, ...(scripts[`post${name}`] ? [runScript(`post${name}`)] : []));
    }
  }
  return result;
}

export interface CloudflareBuildScript {
  // The script's command, or null when cf build alone does the same.
  script: string | null;
  warnings: string[];
}

// runScript gives the command that runs one of the project's scripts, such as `npm run prebuild`.
export function cloudflareBuildScript(
  scripts: Scripts | undefined,
  runScript: (name: string) => string,
  framework: FrameworkBuild = NEXT_BUILD,
): CloudflareBuildScript {
  const all = scripts ?? {};
  const before: string[] = [];
  const warnings: string[] = [];
  if (all.prebuild) before.push(runScript("prebuild"));
  let buildCommand = "cf build";

  const build = all.build?.trim();
  if (build) {
    const flat = flatten(build, all, runScript, framework, 0);
    if (!flat?.nextBuild) {
      warnings.push(
        `Switchyard couldn't find \`${framework.command}\` in the build script (\`${build}\`), so the Cloudflare build runs only \`cf build\`. If the app needs other steps before it builds, add them to the ${CLOUDFLARE_BUILD_SCRIPT} script and set it as the build command in Workers Builds.`,
      );
    } else {
      before.push(...flat.before);
      // Keeps settings such as NODE_OPTIONS=... that came before the framework's build.
      buildCommand = `${flat.nextBuild.match(framework.pattern)?.[1] ?? ""}cf build`;
      const after = [...flat.after, ...(all.postbuild ? [runScript("postbuild")] : [])];
      if (after.length) {
        warnings.push(
          `Switchyard left out the steps that run after \`${framework.command}\` (\`${after.join(" && ")}\`), because they expect ${framework.label}'s own build output, which the Cloudflare build doesn't produce. Check whether the app still needs what they generate.`,
        );
      }
    }
  }
  if (!before.length && buildCommand === "cf build") return { script: null, warnings };
  return { script: [...before, buildCommand].join(" && "), warnings };
}
