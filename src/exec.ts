import { spawn } from "node:child_process";
import { delimiter } from "node:path";
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
  // stdout and stderr interleaved in arrival order.
  output: string;
  // stdout only.
  stdout: string;
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

// Corepack shims must never stop to ask before downloading, or pin a version into the user's package.json.
const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_AUTO_PIN: "0" };

// Runs a command without a shell, so arguments are never interpreted.
// pathPrefix goes first on PATH, for tools Switchyard sets up itself.
export function createCommandRunner(options: { pathPrefix?: string } = {}): CommandRunner {
  const basePath = process.env.PATH ?? "";
  const PATH = options.pathPrefix ? [options.pathPrefix, basePath].filter(Boolean).join(delimiter) : basePath;
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH, ...COREPACK_ENV, FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let stdout = "";
      const emit = (line: string) => opts.onLine?.(line.replace(ANSI, ""));

      // Each stream gets its own decoder and partial line, so output from
      // stdout and stderr never splices into the same line.
      const attach = (stream: Readable, capture: (text: string) => void): (() => void) => {
        const decoder = new StringDecoder("utf8");
        let partial = "";
        const push = (text: string) => {
          output += text;
          capture(text);
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
      const flushes = [
        attach(child.stdout, (text) => {
          stdout += text;
        }),
        attach(child.stderr, () => undefined),
      ];

      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // A missing command can surface as EACCES rather than ENOENT, for example when WSL
        // puts unreadable Windows folders on PATH, so both get the same explanation.
        if (err.code === "ENOENT" || err.code === "EACCES") {
          reject(new Error(`Couldn't start ${cmd} (${err.code}). Check it's installed and on PATH.`, { cause: err }));
        } else reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        for (const flush of flushes) flush();
        resolve({
          code: code ?? (signal ? 128 : 1),
          output: output.replace(ANSI, ""),
          stdout: stdout.replace(ANSI, ""),
        });
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
