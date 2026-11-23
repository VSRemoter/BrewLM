/**
 * "Keep on this device only" controls (lib/localOnly.ts): a hook that knows
 * what's marked, the hover toggle on source / chat / studio-output rows, and
 * the small badge on notebook cards. Desktop only, and only while Sync is on:
 * a browser can clear its storage, so the web app keeps syncing everything.
 */
import { CloudOff } from "lucide-react";
import { useEffect, useState } from "react";
import { localOnlyMarks, onLocalOnlyChange, setLocalOnly, syncFootprint, type LocalItemTable } from "../lib/localOnly";
import { formatBytes } from "../lib/storage";
import { getSyncStatus, onSyncStatus, storageNeeded } from "../lib/sync";
import { platform } from "../platform";
import { confirmAction } from "./ConfirmDialog";

export interface LocalOnlyState {
  /** Sync is on here and this app can keep things local. */
  enabled: boolean;
  isLocal(tbl: LocalItemTable, id: string): boolean;
  /** Opened from someone's shared link: never synced, nothing to choose. */
  isShared(notebookId: string): boolean;
}

export function useLocalOnly(): LocalOnlyState {
  const [syncOn, setSyncOn] = useState(() => getSyncStatus().state === "on");
  const [marks, setMarks] = useState<Set<string>>(() => new Set());
  useEffect(() => onSyncStatus((s) => setSyncOn(s.state === "on")), []);
  useEffect(() => {
    let live = true;
    const load = () => void localOnlyMarks().then((m) => live && setMarks(m)).catch(() => {});
    load();
    const off = onLocalOnlyChange(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return {
    enabled: platform.kind === "desktop" && syncOn,
    isLocal: (tbl, id) => marks.has(`${tbl}:${id}`),
    isShared: (notebookId) => marks.has(`shared:${notebookId}`),
  };
}

const WHAT: Record<LocalItemTable, string> = {
  notebooks: "notebook",
  sources: "source",
  chats: "chat",
  artifacts: "studio output",
};

/**
 * Ask first, then keep it here only (it leaves the server and other devices),
 * or let it sync again (no question: nothing is lost). Returns whether it changed.
 */
export async function toggleLocalOnly(tbl: LocalItemTable, id: string, title: string, on: boolean): Promise<boolean> {
  if (on) {
    const ok = await confirmAction({
      title: "Keep on this device only?",
      message: `“${title}” will stop syncing. It stays here, and is removed from your other devices and from BrewLM Sync's servers.${
        tbl === "notebooks" ? " Everything in this notebook goes with it." : ""
      } If you sync it again later, all of it uploads again.`,
      confirmLabel: "Keep here only",
    });
    if (!ok) return false;
  } else if (!(await roomToSync(tbl, id, title))) return false;
  await setLocalOnly(tbl, id, on);
  return true;
}

/** Uploads bigger than this get a heads-up first. */
const BIG_UPLOAD = 1024 ** 3;

/**
 * Before syncing an item again: does it fit in the plan's storage? If not it
 * stays here (syncing part of it would fill the storage and stall other
 * changes). A big upload is confirmed first.
 */
async function roomToSync(tbl: LocalItemTable, id: string, title: string): Promise<boolean> {
  let need: Awaited<ReturnType<typeof storageNeeded>>;
  try {
    const fp = await syncFootprint(tbl, id);
    need = await storageNeeded(fp.files, fp.recordChars);
  } catch {
    return true; // offline: the server still enforces the plan, and what doesn't fit waits
  }
  if (need.free !== null && need.bytes > need.free) {
    await confirmAction({
      notice: true,
      title: "Not enough sync storage",
      message: `“${title}” needs about ${formatBytes(need.bytes)} and your plan has ${formatBytes(need.free)} left, so it stays on this device. Free up space or choose a bigger plan in Settings → Sync.`,
    });
    return false;
  }
  if (need.bytes >= BIG_UPLOAD)
    return confirmAction({
      title: `Upload ${formatBytes(need.bytes)}?`,
      message: `“${title}” has ${need.files} file${need.files === 1 ? "" : "s"} to upload. That can take a while: keep BrewLM open until it's done. Changes from your other devices keep coming in meanwhile.`,
      confirmLabel: "Sync it",
    });
  return true;
}

/** The hover toggle on an item row; always shown (muted) while the item is local. */
export function LocalOnlyToggle({
  state,
  tbl,
  id,
  title,
  notebookId,
  size = 12,
  className = "p-0.5",
}: {
  state: LocalOnlyState;
  tbl: Exclude<LocalItemTable, "notebooks">;
  id: string;
  title: string;
  /** The notebook it's in: a local notebook already covers it, so no toggle. */
  notebookId: string;
  size?: number;
  className?: string;
}) {
  if (!state.enabled || state.isLocal("notebooks", notebookId) || state.isShared(notebookId)) return null;
  const local = state.isLocal(tbl, id);
  const label = local
    ? `On this device only. Click to sync this ${WHAT[tbl]} again`
    : `Keep this ${WHAT[tbl]} on this device only (don't sync)`;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void toggleLocalOnly(tbl, id, title, !local);
      }}
      className={`shrink-0 rounded transition-all hover:text-ink ${className} ${
        local ? "text-ink-2" : "text-ink-3 opacity-0 group-hover:opacity-100"
      }`}
      title={label}
      aria-label={label}
      aria-pressed={local}
    >
      <CloudOff size={size} strokeWidth={1.8} />
    </button>
  );
}

/** "This device only" beside a notebook's date on Home, and in its header. */
export function LocalOnlyBadge({ size = 11, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-ink-3"
      title="Kept on this device only: Sync doesn't upload it"
    >
      <CloudOff size={size} strokeWidth={1.8} aria-hidden />
      {withText ? "This device only" : <span className="sr-only">This device only</span>}
    </span>
  );
}
