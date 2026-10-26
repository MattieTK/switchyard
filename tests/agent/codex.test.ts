import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexArgs, codexDriver, codexLogLines, unwrapShell } from "../../src/agent/codex.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";

const fixture = readFileSync(join(import.meta.dirname, "../fixtures/agent/codex-stream.jsonl"), "utf8");
const request = { cwd: "/work/project", prompt: "fix it", writableDirs: ["/cache/pnpm"], protectedPaths: [], timeoutMs: 60_000 };

describe("codex status", () => {
  const status = (code: number, output: string) => codexDriver(fakeRunner(() => ({ code, output, stdout: "" })).run).status();

  it("reports a ChatGPT sign-in", async () => {
    expect(await status(0, "Logged in using ChatGPT")).toEqual({
      id: "codex",
      installed: true,
      signedIn: true,
      detail: "Signed in with ChatGPT",
    });
  });

  it("doesn't use an API key sign-in, since Switchyard runs Codex on ChatGPT only", async () => {
    expect(await status(0, "API key configured - sk-proj-***ABCD")).toMatchObject({
      signedIn: false,
      detail: "Signed in with an API key. Switchyard uses Codex with a ChatGPT sign-in only: run codex login",
    });
  });

  it("reports when nobody is signed in, or codex isn't installed", async () => {
    expect(await status(1, "Not logged in")).toMatchObject({ installed: true, signedIn: false, detail: "Not signed in: run codex login" });
    const missing = codexDriver(
      fakeRunner(() => {
        throw new Error("Couldn't start codex (ENOENT). Check it's installed and on PATH.");
      }).run,
    );
    expect(await missing.status()).toMatchObject({ installed: false, detail: "Not installed" });
  });
});

describe("codexArgs", () => {
  it("runs in the workspace sandbox with network, on the ChatGPT sign-in, reading the prompt from stdin", () => {
    const args = codexArgs(request);
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "sandbox_workspace_write.network_access=true",
        'forced_login_method="chatgpt"',
      ]),
    );
    expect(args[args.indexOf("-C") + 1]).toBe("/work/project");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/cache/pnpm");
    expect(args).not.toContain("-m");
    expect(args.at(-1)).toBe("-");
    expect(codexArgs({ ...request, model: "gpt-6-luna" })).toEqual(expect.arrayContaining(["-m", "gpt-6-luna"]));
  });
});

describe("codexLogLines", () => {
  it("describes edits, commands with their exit codes, and messages", () => {
    const lines = fixture
      .trim()
      .split("\n")
      .flatMap((l) => codexLogLines(JSON.parse(l), "/work/project"));
    expect(lines).toContain("Agent: edited build.js");
    expect(lines).toContain("Agent: ran npm run build (exit 0)");
    expect(lines).toContain("Agent: ran npm run build (exit 1)");
    expect(lines.filter((l) => l.startsWith("Agent: ran")).length).toBe(4);
    expect(lines).toContain("Agent: SWITCHYARD: fixed");
  });

  it("reports a failed turn and skips what it doesn't know", () => {
    expect(codexLogLines({ type: "turn.failed", error: { message: "usage limit reached" } }, "/w")).toEqual([
      "Agent: Codex stopped: usage limit reached",
    ]);
    expect(codexLogLines({ type: "item.started", item: { type: "command_execution", command: "ls" } }, "/w")).toEqual([]);
    expect(codexLogLines("nonsense", "/w")).toEqual([]);
  });
});

describe("unwrapShell", () => {
  it("removes the login shell Codex wraps commands in", () => {
    expect(unwrapShell("/usr/bin/zsh -lc 'npm run build'")).toBe("npm run build");
    expect(unwrapShell(`/bin/bash -lc "rg --files -g '!node_modules'"`)).toBe("rg --files -g '!node_modules'");
    expect(unwrapShell("pnpm install")).toBe("pnpm install");
  });
});

describe("codex run", () => {
  it("sends the prompt on stdin and takes the verdict from the last message", async () => {
    const runner = fakeRunner(() => ({ code: 0, output: fixture }));
    const logs: string[] = [];
    const result = await codexDriver(runner.run).run({ ...request, log: (l) => logs.push(l) });
    expect(runner.calls[0]?.cmd).toBe("codex");
    expect(runner.calls[0]?.opts).toMatchObject({ cwd: "/work/project", input: "fix it", killGroup: true });
    expect(logs).toContain("Agent: edited build.js");
    expect(result).toMatchObject({ verdict: "fixed", exitCode: 0, timedOut: false });
    expect(result.message).toContain("Updated the import");
  });

  it("explains a failed turn", async () => {
    const output = [JSON.stringify({ type: "turn.started" }), JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })].join("\n");
    const result = await codexDriver(fakeRunner(() => ({ code: 1, output })).run).run({ ...request, log: () => {} });
    expect(result).toMatchObject({ verdict: "no-verdict", exitCode: 1, message: "usage limit reached" });
  });
});
