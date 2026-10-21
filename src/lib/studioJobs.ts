/**
 * Studio generations in flight. Several can run at once (an audio overview,
 * a report and a deep research together); each shows as a row at the top of
 * the notebook's Saved list with live progress and a cancel button.
 *
 * Kept outside React so a job keeps its row when the user leaves the notebook
 * and comes back — the Studio panel just subscribes to its notebook's jobs.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { ArtifactKind } from "./types";

export interface StudioJob {
  id: string;
  notebookId: string;
  kind: ArtifactKind;
  title: string;
  /** What it's doing right now, e.g. "Writing script — part 2 of 6…". */
  phase: string;
}

export interface JobHandle {
  signal: AbortSignal;
  setPhase: (phase: string) => void;
  /** Remove the row (success, failure or cancel). */
  finish: () => void;
}

let jobs: StudioJob[] = [];
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function update(next: StudioJob[]) {
  jobs = next;
  for (const l of listeners) l();
}

export function startStudioJob(
  notebookId: string,
  kind: ArtifactKind,
  title: string,
  phase: string
): JobHandle {
  const id = crypto.randomUUID();
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  update([{ id, notebookId, kind, title, phase }, ...jobs]);
  return {
    signal: ctrl.signal,
    setPhase: (p) => {
      if (jobs.some((j) => j.id === id)) update(jobs.map((j) => (j.id === id ? { ...j, phase: p } : j)));
    },
    finish: () => {
      controllers.delete(id);
      if (jobs.some((j) => j.id === id)) update(jobs.filter((j) => j.id !== id));
    },
  };
}

/** Stop a job and drop its row now; it saves nothing. */
export function cancelStudioJob(id: string): void {
  controllers.get(id)?.abort();
  controllers.delete(id);
  update(jobs.filter((j) => j.id !== id));
}

/** Throw the AbortError a cancelled job should end with (checked right before saving). */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The notebook's running jobs, newest first. */
export function useStudioJobs(notebookId: string): StudioJob[] {
  const all = useSyncExternalStore(subscribe, () => jobs);
  return useMemo(() => all.filter((j) => j.notebookId === notebookId), [all, notebookId]);
}
