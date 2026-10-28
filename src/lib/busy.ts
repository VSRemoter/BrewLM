/**
 * Which notebooks have work running right now: a chat reply streaming, or a
 * Studio job. The tab strip shows a dot on busy background tabs, and a busy
 * tab is never the one closed to make room for a new one.
 */
import { useMemo, useSyncExternalStore } from "react";
import { hasStudioJobs, useAllStudioJobs } from "./studioJobs";

let streaming = new Set<string>();
const listeners = new Set<() => void>();

/** ChatPanel reports when its reply starts and stops streaming. */
export function setChatStreaming(notebookId: string, on: boolean): void {
  if (streaming.has(notebookId) === on) return;
  streaming = new Set(streaming);
  if (on) streaming.add(notebookId);
  else streaming.delete(notebookId);
  for (const l of listeners) l();
}

export function isNotebookBusy(notebookId: string): boolean {
  return streaming.has(notebookId) || hasStudioJobs(notebookId);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ids of every notebook with a reply streaming or a Studio job running. */
export function useBusyNotebooks(): Set<string> {
  const chats = useSyncExternalStore(subscribe, () => streaming);
  const jobs = useAllStudioJobs();
  return useMemo(() => new Set([...chats, ...jobs.map((j) => j.notebookId)]), [chats, jobs]);
}
