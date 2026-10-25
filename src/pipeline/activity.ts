// Short descriptions of what a job is doing right now, shown beside the log on the job page.
// They come from the commands Switchyard starts and from output lines that mark a sub-step of a
// long command, such as each codemod an upgrade runs. The job page imports this file too.

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const RUNNERS = new Set(["npx", "bunx"]);

const GIT: Readonly<Record<string, string>> = {
  clone: "Cloning the repository",
  fetch: "Fetching the latest commits",
  reset: "Resetting the working copy",
  clean: "Cleaning the working copy",
  checkout: "Checking out the migration branch",
  add: "Staging the changes",
  commit: "Committing the changes",
  push: "Pushing the migration branch",
};

const positional = (args: readonly string[]) => args.filter((a) => !a.startsWith("-"));
// "@next/codemod@16.4.1" → "@next/codemod"; a scope's leading @ stays.
const withoutVersion = (spec: string) => spec.replace(/(.)@[^/]*$/, "$1");

// What a command does, or null for quick lookups not worth showing.
export function describeCommand(cmd: string, args: readonly string[]): string | null {
  if (cmd === "git") {
    // Options such as -c name=value can come before the subcommand.
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    return (sub && GIT[sub]) ?? null;
  }
  if (cmd === "corepack") return `Setting up ${args.at(-1) ?? "the package manager"}`;
  if (RUNNERS.has(cmd)) return describeTool(positional(args));
  if (!PACKAGE_MANAGERS.has(cmd)) return `Running ${cmd}`;

  const [sub, ...rest] = positional(args);
  if (sub === undefined || sub === "install" || sub === "i" || sub === "ci") return "Installing dependencies";
  if (sub === "import") return "Importing the yarn lockfile";
  if (sub === "add") return `Adding ${rest.map(withoutVersion).join(", ")}`;
  if (sub === "remove" || sub === "rm") return `Removing ${rest.join(", ")}`;
  if (sub === "dlx" || sub === "exec" || sub === "x") return describeTool(rest);
  if (sub === "run") return rest[0] ? `Running the ${rest[0]} script` : "Running a script";
  return `Running ${cmd} ${sub}`;
}

function describeTool([tool, sub]: readonly string[]): string {
  return tool ? `Running ${withoutVersion(tool)}${sub ? ` ${sub}` : ""}` : "Running a command";
}

const LINE_PATTERNS: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  // jscodeshift, as @next/codemod and types-react-codemod run it, names the transform file.
  [/jscodeshift\b.*?\/transforms\/([\w.-]+?)\.[cm]?[jt]s\b/, (m) => `Running the ${m[1]} codemod`],
  // codemod.com's React 19 recipe prints each bundled codemod indented on its own line.
  [/^\s+Running ([a-z0-9]+(?:-[a-z0-9]+)+)$/, (m) => `Running the ${m[1]} codemod`],
  [/^Removing (\S.*)$/, (m) => `Removing ${m[1]}`],
  [/Upgrading your project to Next\.js ([\d.]+\d)/, (m) => `Upgrading to Next.js ${m[1]}`],
  [/Migrating from next lint to the ESLint CLI/, () => "Migrating from next lint to the ESLint CLI"],
  [/Running compatibility check/, () => "Checking vinext compatibility"],
  [/^\s*Installing (dependencies|devDependencies):$/, (m) => `Installing ${m[1]}`],
  [/building (\w+) environment for production/, (m) => `Building the ${m[1]} environment`],
  [/Starting asset upload|Building list of assets/, () => "Uploading assets"],
  [/^Build status: (.+)$/, (m) => `Waiting for the Cloudflare build (${m[1]})`],
];

// What an output line says is starting, or null for ordinary output.
export function activityFromLine(line: string): string | null {
  for (const [pattern, describe] of LINE_PATTERNS) {
    const m = line.match(pattern);
    if (m) return describe(m);
  }
  return null;
}
