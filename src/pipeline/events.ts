import type { JobEvent } from "./types.ts";

export interface JobEvents {
  emit(e: JobEvent): void;
  subscribe(jobId: string, fn: (e: JobEvent) => void): () => void;
}

export function createJobEvents(): JobEvents {
  const listeners = new Map<string, Set<(e: JobEvent) => void>>();
  return {
    emit(e) {
      const id = e.type === "job" ? e.job.id : e.jobId;
      for (const fn of listeners.get(id) ?? []) fn(e);
    },
    subscribe(jobId, fn) {
      const set = listeners.get(jobId) ?? new Set();
      set.add(fn);
      listeners.set(jobId, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(jobId);
      };
    },
  };
}
