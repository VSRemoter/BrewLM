/**
 * Which notebooks have work running right now: a chat reply streaming, or a
 * Studio job. The tab strip shows a dot on busy background tabs, and a busy
 * tab is never the one closed to make room for a new one.
 */
import { useMemo, useSyncExternalStore } from "react";
import { hasStudioJobs, useAllStudioJobs } from "./studioJobs";

let streaming = new Set<string>();
/** Which chat panes of each notebook are streaming (a notebook can show up to three side by side). */
const streamingPanes = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

/** ChatPanel reports when its reply starts and stops streaming; `pane` tells side-by-side chats apart. */
export function setChatStreaming(notebookId: string, on: boolean, pane = ""): void {
  const panes = streamingPanes.get(notebookId) ?? new Set<string>();
  if (on) panes.add(pane);
  else panes.delete(pane);
  if (panes.size) streamingPanes.set(notebookId, panes);
  else streamingPanes.delete(notebookId);
  const busy = panes.size > 0;
  if (streaming.has(notebookId) === busy) return;
  streaming = new Set(streaming);
  if (busy) streaming.add(notebookId);
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
