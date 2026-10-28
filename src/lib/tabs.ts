/**
 * Notebook tabs (desktop layout). Open notebooks stay loaded while they have
 * a tab, so a streaming reply or a scroll position survives a switch.
 *
 * Tabs are this device's own: the open list is saved in localStorage, never
 * synced. After a relaunch the tabs come back but the app opens on Home, and
 * each tab loads its notebook only when it's first shown.
 */
import { useSyncExternalStore } from "react";
import { isNotebookBusy } from "./busy";

/** Opening one more closes the least recently used idle tab. */
export const MAX_TABS = 8;
const KEY = "om.tabs";

export interface TabsState {
  /** Open notebook ids, left to right. */
  ids: string[];
  /** The notebook on screen; null = Home. */
  active: string | null;
  /** Most recently shown first; picks which tab makes room for a new one. */
  recent: string[];
  /** Tabs shown since launch. The others haven't loaded their notebook yet. */
  loaded: string[];
}

export const EMPTY_TABS: TabsState = { ids: [], active: null, recent: [], loaded: [] };

/* ------------------------------ transitions ------------------------------ */

export function activate(s: TabsState, id: string | null): TabsState {
  if (id === null || !s.ids.includes(id)) return { ...s, active: null };
  return {
    ...s,
    active: id,
    recent: [id, ...s.recent.filter((x) => x !== id)],
    loaded: s.loaded.includes(id) ? s.loaded : [...s.loaded, id],
  };
}

export function open(
  s: TabsState,
  id: string,
  background = false,
  isBusy: (id: string) => boolean = () => false
): TabsState {
  if (s.ids.includes(id)) return background ? s : activate(s, id);
  let next: TabsState = { ...s, ids: [...s.ids, id] };
  if (next.ids.length > MAX_TABS) {
    // Never-shown tabs count as least recent, then the recent list from its end.
    const lru = [
      ...s.ids.filter((x) => !s.recent.includes(x)),
      ...[...s.recent].reverse().filter((x) => s.ids.includes(x)),
    ];
    const victim = lru.find((x) => x !== s.active && !isBusy(x));
    if (victim) next = remove(next, victim);
  }
  return background ? next : activate(next, id);
}

function remove(s: TabsState, id: string): TabsState {
  return {
    ...s,
    ids: s.ids.filter((x) => x !== id),
    recent: s.recent.filter((x) => x !== id),
    loaded: s.loaded.filter((x) => x !== id),
  };
}

/** Closing the tab on screen shows its right-hand neighbour (else the left one, else Home). */
export function close(s: TabsState, id: string): TabsState {
  const i = s.ids.indexOf(id);
  if (i < 0) return s;
  const next = remove(s, id);
  if (s.active !== id) return next;
  return activate(next, next.ids[i] ?? next.ids[i - 1] ?? null);
}

export function move(s: TabsState, id: string, toIndex: number): TabsState {
  if (!s.ids.includes(id)) return s;
  const ids = s.ids.filter((x) => x !== id);
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, id);
  return { ...s, ids };
}

/** Next (+1) or previous (-1) tab, wrapping; from Home, the first or last. */
export function cycle(s: TabsState, dir: 1 | -1): TabsState {
  const n = s.ids.length;
  if (n === 0) return s;
  const i = s.active ? s.ids.indexOf(s.active) : -1;
  const j = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
  return activate(s, s.ids[j]);
}

/** Drop tabs whose notebook is gone (trashed or deleted, here or on another device). */
export function prune(s: TabsState, exists: (id: string) => boolean): TabsState {
  let next = s;
  for (const id of s.ids) if (!exists(id)) next = close(next, id);
  return next;
}

/* --------------------------------- store --------------------------------- */

function restore(): TabsState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const ids = strings(raw?.ids).slice(0, MAX_TABS);
    return { ...EMPTY_TABS, ids, recent: strings(raw?.recent).filter((x) => ids.includes(x)) };
  } catch {
    return EMPTY_TABS;
  }
}

let state = restore();
const listeners = new Set<() => void>();

function set(next: TabsState) {
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ids: state.ids, recent: state.recent }));
  } catch {
    // storage full or blocked — tabs just won't come back after a relaunch
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTabs(): TabsState {
  return useSyncExternalStore(subscribe, () => state);
}

export const getTabs = (): TabsState => state;
export const openTab = (id: string, background = false) => set(open(state, id, background, isNotebookBusy));
export const showTab = (id: string | null) => set(activate(state, id));
export const closeTab = (id: string) => set(close(state, id));
export const moveTab = (id: string, toIndex: number) => set(move(state, id, toIndex));
export const cycleTab = (dir: 1 | -1) => set(cycle(state, dir));
export const pruneTabs = (exists: (id: string) => boolean) => set(prune(state, exists));
