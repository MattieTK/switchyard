import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, claudeDriver, claudeLogLines } from "../../src/agent/claude.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/agent", name), "utf8");
const request = {
  cwd: "/work/project",
  prompt: "fix it",
  writableDirs: ["/cache/pnpm"],
  protectedPaths: ["/home/u/.config/switchyard"],
  timeoutMs: 60_000,
};
const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

function driver(handler: Parameters<typeof fakeRunner>[0], over: { platform?: NodeJS.Platform; tools?: string[] } = {}) {
  const runner = fakeRunner(handler);
  const tools = new Set(over.tools ?? ["bwrap", "socat"]);
  const d = claudeDriver(runner.run, { platform: over.platform ?? "linux", onPath: async (cmd) => tools.has(cmd) });
  return { d, calls: runner.calls };
}

describe("claude status", () => {
  it("reports a subscription sign-in with its plan", async () => {
    const { d } = driver(() => ({
      code: 0,
      output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    }));
    expect(await d.status()).toEqual({
      id: "claude",
      installed: true,
      signedIn: true,
      detail: "Signed in with your Claude subscription (Max)",
      sandbox: { available: true, detail: "Commands run in Claude Code's sandbox." },
    });
  });

  it("says an API key is billed to that key", async () => {
    const { d } = driver(() => ({ code: 0, output: JSON.stringify({ loggedIn: true, authMethod: "api_key" }) }));
    const status = await d.status();
    expect(status.signedIn).toBe(true);
    expect(status.detail).toBe("Signed in with an API key, so its usage is billed to that key");
  });

  it("reports when nobody is signed in", async () => {
    const { d } = driver(() => ({ code: 1, output: JSON.stringify({ loggedIn: false, authMethod: "none" }) }));
    expect(await d.status()).toMatchObject({ installed: true, signedIn: false, detail: "Not signed in: run claude, then /login" });
  });

  it("reports when claude isn't installed", async () => {
    const { d } = driver(() => {
      throw new Error("Couldn't start claude (ENOENT). Check it's installed and on PATH.");
    });
    expect(await d.status()).toMatchObject({ installed: false, signedIn: false, detail: "Not installed" });
  });

  it("names the sandbox tools that are missing on Linux, and needs none on macOS", async () => {
    const ok = () => ({ code: 0, output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) });
    expect((await driver(ok, { tools: ["bwrap"] }).d.status()).sandbox).toEqual({
      available: false,
      detail: "Commands run without a sandbox. Install socat to turn on Claude Code's sandbox.",
    });
    expect((await driver(ok, { tools: [], platform: "darwin" }).d.status()).sandbox?.available).toBe(true);
  });
});

describe("claudeArgs", () => {
  it("runs headless, refuses anything not allowed, and never uses --bare", () => {
    const args = claudeArgs(request, false);
    expect(args.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--allowedTools"]);
    expect(args).toEqual(expect.arrayContaining(["Edit", "Bash", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("WebFetch");
    expect(settingsOf(args).sandbox).toBeUndefined();
  });

  it("keeps the agent out of Switchyard's own folder and away from commits and pushes", () => {
    const deny = settingsOf(claudeArgs(request, false)).permissions.deny as string[];
    expect(deny).toEqual(
      expect.arrayContaining([
        "Read(//home/u/.config/switchyard/**)",
        "Edit(//home/u/.config/switchyard/**)",
        "Bash(git push:*)",
        "Bash(git commit:*)",
        "WebFetch",
      ]),
    );
  });

  it("passes the model, the writable folders and the sandbox settings when given", () => {
    const args = claudeArgs({ ...request, model: "opus" }, true);
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/cache/pnpm");
    const settings = settingsOf(args);
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { allowWrite: ["/cache/pnpm"], denyRead: ["/home/u/.config/switchyard"] },
    });
    expect(settings.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
  });
});

describe("claudeLogLines", () => {
  it("describes edits, commands and messages, with paths relative to the project", () => {
    const lines = fixture("claude-stream.jsonl")
      .trim()
      .split("\n")
      .flatMap((l) => claudeLogLines(JSON.parse(l), "/work/project"));
    expect(lines).toContain("Agent: edited build.js");
    expect(lines).toContain("Agent: ran npm run build");
    expect(lines).toContain("Agent: read build.js");
    expect(lines.some((l) => l.startsWith("Agent: ") && l.includes("greet"))).toBe(true);
  });

  it("says when a tool wasn't allowed, and ignores events it doesn't know", () => {
    expect(claudeLogLines({ type: "system", subtype: "permission_denied", tool_name: "Write" }, "/w")).toEqual([
      "Agent: wasn't allowed to use Write",
    ]);
    expect(claudeLogLines({ type: "something_new" }, "/w")).toEqual([]);
    expect(claudeLogLines(null, "/w")).toEqual([]);
  });
});

describe("claude run", () => {
  it("sends the prompt on stdin, logs as it goes and reads the verdict from the result", async () => {
    const { d, calls } = driver(() => ({ code: 0, output: fixture("claude-stream.jsonl") }));
    const logs: string[] = [];
    const result = await d.run({ ...request, log: (l) => logs.push(l) });
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.opts).toMatchObject({ cwd: "/work/project", input: "fix it", killGroup: true, timeoutMs: 60_000 });
    expect(settingsOf(calls[0]?.args ?? []).sandbox?.enabled).toBe(true);
    expect(logs).toContain("Agent: edited build.js");
    expect(result).toMatchObject({ verdict: "fixed", exitCode: 0, timedOut: false });
    expect(result.message).toContain("greet");
    expect(result.events).toContain('"type":"result"');
  });

  it("runs without the sandbox when it isn't available", async () => {
    const { d, calls } = driver(() => ({ code: 0, output: fixture("claude-stream.jsonl") }), { tools: ["bwrap"] });
    await d.run({ ...request, log: () => {} });
    expect(settingsOf(calls[0]?.args ?? []).sandbox).toBeUndefined();
  });

  it("reports a run the runner stopped for taking too long", async () => {
    const runner = fakeRunner(() => ({ code: 143, output: "" }));
    const d = claudeDriver(
      async (cmd, args, opts) => ({ ...(await runner.run(cmd, args, opts)), timedOut: true }),
      { platform: "linux", onPath: async () => true },
    );
    expect((await d.run({ ...request, log: () => {} })).timedOut).toBe(true);
  });

  it("explains a run that couldn't start", async () => {
    const { d } = driver(() => ({ code: 1, output: fixture("claude-sandbox-unavailable.jsonl") }));
    const result = await d.run({ ...request, log: () => {} });
    expect(result).toMatchObject({ verdict: "no-verdict", exitCode: 1 });
    expect(result.message).toContain("socat not installed");
  });
});
