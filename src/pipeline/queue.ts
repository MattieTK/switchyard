export interface JobQueue {
  enqueue(jobId: string): void;
  idle(): Promise<void>;
}

// Runs one job at a time: parallel jobs would share disk, rate limits and the
// user's attention, and the extra complexity isn't worth it at this point.
export function createJobQueue(
  run: (jobId: string) => Promise<unknown>,
  onError: (jobId: string, e: unknown) => void = () => {},
): JobQueue {
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<string>();
  return {
    enqueue(jobId) {
      if (pending.has(jobId)) return;
      pending.add(jobId);
      tail = tail.then(async () => {
        try {
          await run(jobId);
        } catch (e) {
          onError(jobId, e);
        } finally {
          pending.delete(jobId);
        }
      });
    },
    idle: () => tail,
  };
}
