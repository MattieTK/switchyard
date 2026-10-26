import { describe, expect, it } from "vitest";
import { CommandError, createCommandRunner, runOrThrow, stopProcessGroups } from "../src/exec.ts";

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

  it("names the command that couldn't be started", async () => {
    await expect(run("definitely-not-a-command-sy", [])).rejects.toThrow(
      /^Couldn't start definitely-not-a-command-sy \((ENOENT|EACCES)\)\. Check it's installed and on PATH\.$/,
    );
  });

  it("puts a per-run path prefix before the runner's own", async () => {
    const prefixed = createCommandRunner({ pathPrefix: "/sy/bin" });
    const r = await prefixed(node, ["-e", "console.log(process.env.PATH.split(require('path').delimiter).slice(0, 2).join(' '))"], {
      pathPrefix: "/run/bin",
    });
    expect(r.stdout.trim()).toBe("/run/bin /sy/bin");
  });

  it("puts the path prefix first on PATH", async () => {
    const prefixed = createCommandRunner({ pathPrefix: "/sy/bin" });
    const r = await prefixed(node, ["-e", "console.log(process.env.PATH.split(require('path').delimiter)[0])"]);
    expect(r.stdout.trim()).toBe("/sy/bin");
  });

  it("kills the process after the timeout", async () => {
    const r = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });

  it("writes input to stdin and then closes it", async () => {
    const r = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello\nworld" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello\nworld");
  });

  it("gives commands without input an empty stdin, so nothing waits on it", async () => {
    const r = await run(node, ["-e", "process.stdin.on('data', () => {}).on('end', () => console.log('ended'))"], {
      timeoutMs: 2000,
    });
    expect(r.stdout.trim()).toBe("ended");
  });

  it("stops the command's own child processes with it when killGroup is set", async () => {
    const script =
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });" +
      "console.log(c.pid); setTimeout(() => {}, 30000);";
    const started = Date.now();
    const r = await run(node, ["-e", script], { timeoutMs: 300, killGroup: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    const grandchild = Number(r.stdout.trim());
    // Signal 0 only checks the process exists; give the kernel a moment to reap it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("stops what a killGroup command left running when it exits normally", async () => {
    const script =
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });" +
      "console.log(c.pid); c.unref();";
    const r = await run(node, ["-e", script], { killGroup: true });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(Number(r.stdout.trim()), 0)).toThrow();
  });

  it("stops running process groups when Switchyard stops", async () => {
    const started = Date.now();
    const pending = run(node, ["-e", "setTimeout(() => {}, 30000)"], { killGroup: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopProcessGroups();
    const r = await pending;
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
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
