import { describe, expect, it } from "vitest";
import { activityFromLine, describeCommand } from "../../src/pipeline/activity.ts";

describe("describeCommand", () => {
  it("names the commands Switchyard runs in plain words", () => {
    expect(describeCommand("git", ["clone", "--depth", "1", "--branch", "main", "https://github.com/a/b.git", "/w"])).toBe(
      "Cloning the repository",
    );
    expect(describeCommand("git", ["clean", "-fdx"])).toBe("Cleaning the working copy");
    expect(describeCommand("git", ["-c", "user.name=Switchyard", "commit", "--no-verify", "-m", "x"])).toBe("Committing the changes");
    expect(describeCommand("pnpm", ["install"])).toBe("Installing dependencies");
    expect(describeCommand("yarn", [])).toBe("Installing dependencies");
    expect(describeCommand("pnpm", ["import"])).toBe("Importing the yarn lockfile");
    expect(describeCommand("pnpm", ["add", "-D", "@mdx-js/react@^2.0.0"])).toBe("Adding @mdx-js/react");
    expect(describeCommand("pnpm", ["dlx", "@next/codemod@16.4.1", "upgrade", "16.4.1", "--yes"])).toBe("Running @next/codemod upgrade");
    expect(describeCommand("npx", ["--yes", "vinext@1.3.0", "init", "--platform=cloudflare"])).toBe("Running vinext init");
    expect(describeCommand("pnpm", ["dlx", "cf@1.0.0-beta.25", "init", "."])).toBe("Running cf init");
    expect(describeCommand("pnpm", ["exec", "cf", "build"])).toBe("Running cf build");
    expect(describeCommand("npm", ["run", "build:cloudflare"])).toBe("Running the build:cloudflare script");
    expect(describeCommand("corepack", ["enable", "--install-directory", "/bin", "pnpm"])).toBe("Setting up pnpm");
  });

  it("stays quiet for quick lookups", () => {
    for (const args of [["status", "--porcelain"], ["config", "user.email"], ["rev-parse", "HEAD"], ["show", "HEAD:package.json"]]) {
      expect(describeCommand("git", args)).toBeNull();
    }
  });
});

describe("activityFromLine", () => {
  it("picks out the steps inside long commands", () => {
    expect(
      activityFromLine(
        "Executing command: jscodeshift --parser=tsx --extensions=tsx,ts,jsx,js,mjs --transform /home/u/.cache/pnpm/dlx/x/node_modules/@next/codemod/transforms/next-image-to-legacy-image.js /w",
      ),
    ).toBe("Running the next-image-to-legacy-image codemod");
    expect(
      activityFromLine(
        'executing "node /x/jscodeshift.js --extensions=tsx,ts --no-babel --transform /x/types-react-codemod/transforms/preset-19.js --preset19Transforms="a,b" ."',
      ),
    ).toBe("Running the preset-19 codemod");
    expect(activityFromLine("  Running react-19-replace-reactdom-render")).toBe("Running the react-19-replace-reactdom-render codemod");
    expect(activityFromLine("Removing node_modules/")).toBe("Removing node_modules/");
    expect(activityFromLine("🛠️  Configuring project for React Router")).toBe("Setting the project up for React Router");
    expect(activityFromLine("Upgrading your project to Next.js 16.4.1...")).toBe("Upgrading to Next.js 16.4.1");
    expect(activityFromLine("Migrating from next lint to the ESLint CLI...")).toBe("Migrating from next lint to the ESLint CLI");
    expect(activityFromLine("  Running compatibility check...")).toBe("Checking vinext compatibility");
    expect(activityFromLine("  Installing devDependencies:")).toBe("Installing devDependencies");
    expect(activityFromLine("vite v8.3.0 building ssr environment for production...")).toBe("Building the ssr environment");
    expect(activityFromLine("│  🌀 Starting asset upload...")).toBe("Uploading assets");
    expect(activityFromLine("Build status: running")).toBe("Waiting for the Cloudflare build (running)");
  });

  it("ignores ordinary output", () => {
    for (const line of ["Progress: resolved 363, reused 363, downloaded 0, added 363, done", "✓ 437 modules transformed.", "", "Running"]) {
      expect(activityFromLine(line)).toBeNull();
    }
  });
});
