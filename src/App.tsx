import { Settings as SettingsIcon, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Home from "./components/Home";
import NotebookView from "./components/NotebookView";
import PairPhonePanel from "./components/PairPhonePanel";
import QuickSwitcher from "./components/QuickSwitcher";
import TabStrip from "./components/TabStrip";
import { IconButton, Modal } from "./components/ui";
import { useBusyNotebooks } from "./lib/busy";
import { closeTab, cycleTab, getTabs, openTab, pruneTabs, showTab, useTabs } from "./lib/tabs";
import { NARROW, useMediaQuery } from "./lib/usePhone";
import SettingsPage from "./components/settings/SettingsPage";
import { startJobRunner } from "./lib/jobRunner";
import { migrateMedia } from "./lib/mediaMigration";
import { onRemoteChanges, startSync } from "./lib/sync";
import {
  cloneNotebook,
  createFolder,
  createNotebook,
  deleteFolder,
  deleteNotebook,
  getDb,
  renameNotebook,
  listFolders,
  listNotebooks,
  listTrashedNotebooks,
  moveNotebookToFolder,
  purgeExpiredTrash,
  repairBinarySources,
  restoreNotebook,
  setFolderCover,
  setNotebookCover,
  setNotebookStarred,
  trashNotebook,
  updateFolderDetails,
  updateNotebookDetails,
} from "./lib/db";
import { loadSettings } from "./lib/settings";
import { applyFont } from "./lib/fonts";
import { applyTheme } from "./lib/themes";
import { setSmoothScroll } from "./lib/smoothScroll";
import { checkForUpdate, type UpdateInfo } from "./lib/updates";
import { platform } from "./platform";
import type { Folder, Notebook, Settings } from "./lib/types";
import { AudioPlayerProvider } from "./components/AudioPlayer";
import { confirmAction, ConfirmHost } from "./components/ConfirmDialog";
import { bootDone, bootStep } from "./lib/boot";

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [trashedNotebooks, setTrashedNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const tabs = useTabs();
  const busy = useBusyNotebooks();
  /** Phones and upright tablets: no tab strip, one notebook loaded at a time. */
  const narrow = useMediaQuery(NARROW);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const byId = useMemo(() => new Map(notebooks.map((n) => [n.id, n])), [notebooks]);

  // Close tabs whose notebook was trashed or deleted (here or on another device).
  useEffect(() => {
    if (ready) pruneTabs((id) => byId.has(id));
  }, [ready, byId]);

  // ⌘K everywhere; ⌘1–9, ⌃Tab and ⌘W only in the desktop app (browsers keep those keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
        return;
      }
      if (platform.kind !== "desktop") return;
      const { ids, active } = getTabs();
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        // ⌘9 is always the last tab, as in browsers.
        const id = e.key === "9" ? ids[ids.length - 1] : ids[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          showTab(id);
        }
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.metaKey && e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        cycleTab(e.code === "BracketRight" ? 1 : -1);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "w" && active) {
        // Windows/Linux; on macOS the menu's Close Tab item sends this instead.
        e.preventDefault();
        closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(
    () =>
      platform.onMenu?.((command) => {
        const { active } = getTabs();
        if (command === "close-tab" && active) closeTab(active);
      }),
    []
  );

  const refresh = useCallback(async () => {
    const [nbs, trash, fds] = await Promise.all([
      listNotebooks(),
      listTrashedNotebooks(),
      listFolders(),
    ]);
    setNotebooks(nbs);
    setTrashedNotebooks(trash);
    setFolders(fds);
  }, []);

  // Changes pulled from other devices (BrewLM Sync): homepage lists, settings.
  useEffect(
    () =>
      onRemoteChanges((c) => {
        if (c.tables.has("notebooks") || c.tables.has("folders")) void refresh();
        if (c.tables.has("settings"))
          void loadSettings().then((s) => {
            applyTheme(s.theme);
            applyFont(s.font);
            setSettings(s);
          });
      }),
    [refresh]
  );

  const reloadSettings = useCallback(async () => {
    setSettings(await loadSettings());
  }, []);

  const smoothScroll = settings?.smoothScroll;
  useEffect(() => {
    if (smoothScroll !== undefined) setSmoothScroll(smoothScroll);
  }, [smoothScroll]);

  useEffect(() => {
    (async () => {
      try {
        bootStep("Opening your library");
        await getDb();
        startJobRunner(); // drains phone-queued chat/generate jobs
        bootStep("Loading settings");
        const s = await loadSettings();
        // Trash auto-empty (retention 0 = disabled).
        bootStep("Emptying old trash");
        const purged = await purgeExpiredTrash(s.trashRetentionDays);
        if (purged > 0) console.info(`trash: auto-emptied ${purged} notebook(s)`);
        applyTheme(s.theme);
        applyFont(s.font);
        setSettings(s);
        bootStep("Loading your notebooks");
        await refresh();
        setReady(true);
        bootDone();
        // Background maintenance: repair garbage file sources left by old
        // versions, then move inline media into files (one-time; resumes if
        // interrupted) — its compaction also reclaims the repaired rows' space.
        void repairBinarySources()
          .then((n) => {
            if (n > 0) console.info(`sources: repaired ${n} unreadable file source(s)`);
          })
          .catch((e) => console.warn("source repair:", e))
          .then(() => migrateMedia())
          .catch((e) => console.warn("media migration:", e));
        void startSync().catch((e) => console.warn("sync:", e));
        // Non-blocking update check — never delays or breaks startup.
        if (s.updateCheckOnLaunch && platform.kind === "desktop") {
          void checkForUpdate().then((info) => {
            if (info?.isNewer) setUpdateInfo(info);
          });
        }
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e));
        bootDone();
      }
    })();
  }, [refresh, reloadSettings]);

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas px-8">
        <div className="max-w-md text-center">
          <p className="text-[16px] font-semibold tracking-tight">
            BrewLM couldn't load its database
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            {platform.kind === "desktop"
              ? "Try relaunching the app. If it persists, the app data folder may need to be reset."
              : "Try reloading the page. If it persists, the details below say why."}
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-xl border border-danger-edge bg-danger-bg p-3 text-left text-[11px] leading-snug text-danger">
            {fatal}
          </pre>
        </div>
      </div>
    );
  }

  if (!ready || !settings) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
      </div>
    );
  }

  const active = tabs.active ? byId.get(tabs.active) ?? null : null;
  // Desktop keeps every shown tab loaded (hidden when not active) so replies and
  // scroll positions survive a switch; narrow screens load only the open one.
  const mounted = narrow ? (active ? [active.id] : []) : tabs.loaded;
  const showStrip = !narrow && (tabs.ids.length > 0 || active !== null);

  const createAndOpen = async (title: string, description = "", folderId = "", cover = "") => {
    const nb = await createNotebook(title, description, folderId);
    if (cover) await setNotebookCover(nb.id, cover);
    await refresh();
    openTab(nb.id);
  };

  return (
    <AudioPlayerProvider>
      <div className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
        {showStrip && (
          <TabStrip
            tabs={tabs}
            notebooks={byId}
            busy={busy}
            onNew={() => setSwitcherOpen(true)}
            onRename={async (id, title) => {
              await renameNotebook(id, title);
              await refresh();
            }}
            actions={
              active && (
                <>
                  {platform.kind === "desktop" && (
                    <IconButton onClick={() => setPairOpen(true)} label="Pair your phone">
                      <Smartphone size={15} strokeWidth={1.8} />
                    </IconButton>
                  )}
                  <IconButton onClick={() => setSettingsOpen(true)} label="Settings">
                    <SettingsIcon size={15} strokeWidth={1.8} />
                  </IconButton>
                </>
              )
            }
          />
        )}
        <div className="relative min-h-0 flex-1">
        {mounted.map((id) => {
          const nb = byId.get(id);
          if (!nb) return null;
          const shown = id === tabs.active;
          return (
            <div key={id} inert={!shown} className={`absolute inset-0 ${shown ? "" : "invisible"}`}>
              <NotebookView
                notebook={nb}
                settings={settings}
                tabbed={!narrow}
                onBack={() => showTab(null)}
                onOpenSettings={() => setSettingsOpen(true)}
                onRenamed={refresh}
                onNotebookMoved={refresh}
                onSettingsChanged={reloadSettings}
                onOpenNotebook={async (id) => {
                  // Refresh first so the new tab's notebook resolves.
                  await refresh();
                  openTab(id);
                }}
              />
            </div>
          );
        })}
        <div inert={active !== null} className={`absolute inset-0 ${active ? "invisible" : ""}`}>
          <Home
            notebooks={notebooks}
            trashedNotebooks={trashedNotebooks}
            folders={folders}
            updateInfo={updateInfo}
            onDismissUpdate={() => setUpdateInfo(null)}
            trashRetentionDays={settings.trashRetentionDays}
            onOpen={(id, background) => openTab(id, background)}
            onSettings={() => setSettingsOpen(true)}
            onCreate={createAndOpen}
            onTrash={async (id) => {
              await trashNotebook(id);
              await refresh();
            }}
            onRestore={async (id) => {
              await restoreNotebook(id);
              await refresh();
            }}
            onDeleteForever={async (id) => {
              await deleteNotebook(id);
              await refresh();
            }}
            onMoveNotebookBulk={async (ids, folderId) => {
              for (const id of ids) await moveNotebookToFolder(id, folderId);
              await refresh();
            }}
            onTrashBulk={async (ids) => {
              for (const id of ids) await trashNotebook(id);
              await refresh();
            }}
            onRestoreBulk={async (ids) => {
              for (const id of ids) await restoreNotebook(id);
              await refresh();
            }}
            onDeleteForeverBulk={async (ids) => {
              for (const id of ids) await deleteNotebook(id);
              await refresh();
            }}
            onUpdateDetails={async (id, title, description) => {
              await updateNotebookDetails(id, title, description);
              await refresh();
            }}
            onToggleStar={async (id, starred) => {
              await setNotebookStarred(id, starred);
              await refresh();
            }}
            onSetCover={async (id, cover) => {
              await setNotebookCover(id, cover);
              await refresh();
            }}
            onMoveNotebook={async (id, folderId) => {
              await moveNotebookToFolder(id, folderId);
              await refresh();
            }}
            onCreateFolder={async (name, description, cover) => {
              const f = await createFolder(name, description);
              if (cover) await setFolderCover(f.id, cover);
              await refresh();
            }}
            onUpdateFolder={async (id, name, description) => {
              await updateFolderDetails(id, name, description);
              await refresh();
            }}
            onSetFolderCover={async (id, cover) => {
              await setFolderCover(id, cover);
              await refresh();
            }}
            onDeleteFolder={async (id) => {
              const name = folders.find((f) => f.id === id)?.name ?? "this folder";
              const ok = await confirmAction({
                title: "Delete folder?",
                message: `“${name}” will be deleted. The notebooks inside it aren't — they move back to the Brewery.`,
                confirmLabel: "Delete folder",
              });
              if (!ok) return;
              await deleteFolder(id);
              await refresh();
            }}
            onUseTemplate={async (id) => {
              const src = notebooks.find((n) => n.id === id);
              if (!src) return;
              await cloneNotebook(id, `${src.title} (copy)`, {
                includeChats: false,
                includeArtifacts: false,
              });
              await refresh();
            }}
          />
        </div>
        </div>

        {switcherOpen && (
          <QuickSwitcher
            notebooks={notebooks}
            folders={folders}
            openIds={tabs.ids}
            onOpen={(id, background) => openTab(id, background)}
            onCreate={(title) => void createAndOpen(title)}
            onClose={() => setSwitcherOpen(false)}
          />
        )}
        {pairOpen && (
          <Modal title="Pair your phone" onClose={() => setPairOpen(false)}>
            <PairPhonePanel />
          </Modal>
        )}

        {settingsOpen && (
          <SettingsPage
            updateInfo={updateInfo}
            onClose={() => {
              setSettingsOpen(false);
              reloadSettings();
            }}
          />
        )}
      </div>
      <ConfirmHost />
    </AudioPlayerProvider>
  );
}
