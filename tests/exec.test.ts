import { describe, expect, it } from "vitest";
import { CommandError, createCommandRunner, runOrThrow } from "../src/exec.ts";

const run = createCommandRunner();
const node = process.execPath;

describe("createCommandRunner", () => {
  it("captures stdout and stderr and reports lines as they arrive", async () => {
    const lines: string[] = [];
    const r = await run(node, ["-e", "console.log('a'); console.error('b'); process.stdout.write('c')"], {
      onLine: (l) => lines.push(l),
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain("a");
    expect(r.output).toContain("b");
    expect(lines).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("keeps stderr out of stdout", async () => {
    const r = await run(node, ["-e", "console.log('out'); console.error('err')"]);
    expect(r.stdout.trim()).toBe("out");
    expect(r.output).toContain("err");
  });

  it("returns the exit code without throwing", async () => {
    expect((await run(node, ["-e", "process.exit(3)"])).code).toBe(3);
  });

  it("passes extra env and cwd", async () => {
    const r = await run(node, ["-e", "console.log(process.env.SY_X + ':' + process.cwd())"], {
      env: { SY_X: "hello" },
      cwd: "/",
    });
    expect(r.output.trim()).toBe("hello:/");
  });

  it("strips ANSI colour codes from lines", async () => {
    const lines: string[] = [];
    await run(node, ["-e", "console.log('\\u001b[33mwarn\\u001b[0m')"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["warn"]);
  });

  it("decodes a multibyte character split across chunks", async () => {
    const lines: string[] = [];
    const script =
      "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50)";
    const r = await run(node, ["-e", script], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["é"]);
    expect(r.output).toBe("é\n");
  });

  it("rejects when the command does not exist", async () => {
    // An absolute path skips PATH search, which reports EACCES instead of ENOENT on some hosts (WSL).
    await expect(run("/nonexistent-sy-dir/definitely-not-a-command-sy", [])).rejects.toThrow(/ENOENT/);
  });

  it("kills the process after the timeout", async () => {
    const r = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });
});

describe("runOrThrow", () => {
  it("throws CommandError with the output on a non-zero exit", async () => {
    const err = await runOrThrow(run, node, ["-e", "console.log('boom'); process.exit(2)"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe(2);
    expect((err as CommandError).output).toContain("boom");
  });
});
