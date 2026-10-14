import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  output: string;
}

export type CommandRunner = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export class CommandError extends Error {
  readonly code: number;
  readonly output: string;

  constructor(cmd: string, args: readonly string[], result: RunResult) {
    super(`${[cmd, ...args].join(" ")} exited with code ${result.code}`);
    this.name = "CommandError";
    this.code = result.code;
    this.output = result.output;
  }
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Runs a command without a shell, so arguments are never interpreted.
export function createCommandRunner(): CommandRunner {
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const emit = (line: string) => opts.onLine?.(line.replace(ANSI, ""));

      // Each stream gets its own decoder and partial line, so output from
      // stdout and stderr never splices into the same line.
      const attach = (stream: Readable): (() => void) => {
        const decoder = new StringDecoder("utf8");
        let partial = "";
        const push = (text: string) => {
          output += text;
          const lines = (partial + text).split(/\r?\n/);
          partial = lines.pop() ?? "";
          for (const line of lines) emit(line);
        };
        stream.on("data", (chunk: Buffer) => push(decoder.write(chunk)));
        return () => {
          push(decoder.end());
          if (partial) emit(partial);
        };
      };
      const flushes = [attach(child.stdout), attach(child.stderr)];

      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        for (const flush of flushes) flush();
        resolve({ code: code ?? (signal ? 128 : 1), output: output.replace(ANSI, "") });
      });
    });
}

export async function runOrThrow(
  run: CommandRunner,
  cmd: string,
  args: readonly string[],
  opts?: RunOptions,
): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) throw new CommandError(cmd, args, result);
  return result;
}
