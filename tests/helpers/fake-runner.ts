import type { CommandRunner, RunOptions, RunResult } from "../../src/exec.ts";

export interface RunCall {
  cmd: string;
  args: string[];
  opts: RunOptions | undefined;
}

export function fakeRunner(
  handler: (cmd: string, args: readonly string[], opts?: RunOptions) => RunResult | Promise<RunResult> = () => ({
    code: 0,
    output: "",
  }),
): { run: CommandRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const result = await handler(cmd, args, opts);
    for (const line of result.output.split("\n")) if (line) opts?.onLine?.(line);
    return result;
  };
  return { run, calls };
}
