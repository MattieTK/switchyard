import type { CommandRunner, RunOptions, RunResult } from "../../src/exec.ts";

export interface RunCall {
  cmd: string;
  args: string[];
  opts: RunOptions | undefined;
}

// Handlers may omit stdout; it then defaults to output, which suits tests where only stdout is produced.
export interface FakeResult {
  code: number;
  output: string;
  stdout?: string;
}

export function fakeRunner(
  handler: (cmd: string, args: readonly string[], opts?: RunOptions) => FakeResult | Promise<FakeResult> = () => ({
    code: 0,
    output: "",
  }),
): { run: CommandRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const result = await handler(cmd, args, opts);
    for (const line of result.output.split("\n")) if (line) opts?.onLine?.(line);
    return { code: result.code, output: result.output, stdout: result.stdout ?? result.output };
  };
  return { run, calls };
}
