import { useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import NotebookView from "./components/NotebookView";
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
import type { Folder, Notebook, Settings } from "./lib/types";
import { AudioPlayerProvider } from "./components/AudioPlayer";

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [trashedNotebooks, setTrashedNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

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
        await getDb();
        startJobRunner(); // drains phone-queued chat/generate jobs
        const s = await loadSettings();
        // Trash auto-empty (retention 0 = disabled).
        const purged = await purgeExpiredTrash(s.trashRetentionDays);
        if (purged > 0) console.info(`trash: auto-emptied ${purged} notebook(s)`);
        applyTheme(s.theme);
        applyFont(s.font);
        setSettings(s);
        await refresh();
        setReady(true);
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
        if (s.updateCheckOnLaunch) {
          void checkForUpdate().then((info) => {
            if (info?.isNewer) setUpdateInfo(info);
          });
        }
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e));
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
            Try relaunching the app. If it persists, the app data folder may need to be reset.
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

  const open = notebooks.find((n) => n.id === openId) ?? null;

  return (
    <AudioPlayerProvider>
      <div className="h-full overflow-hidden bg-canvas text-ink">
        {open ? (
          <NotebookView
            notebook={open}
            settings={settings}
            onBack={() => setOpenId(null)}
            onOpenSettings={() => setSettingsOpen(true)}
            onRenamed={refresh}
            onNotebookMoved={refresh}
            onSettingsChanged={reloadSettings}
            onOpenNotebook={async (id) => {
              // Refresh first so `open` resolves before the id changes.
              await refresh();
              setOpenId(id);
            }}
          />
        ) : (
          <Home
            notebooks={notebooks}
            trashedNotebooks={trashedNotebooks}
            folders={folders}
            updateInfo={updateInfo}
            onDismissUpdate={() => setUpdateInfo(null)}
            trashRetentionDays={settings.trashRetentionDays}
            onOpen={setOpenId}
            onSettings={() => setSettingsOpen(true)}
            onCreate={async (title, description, folderId, cover) => {
              const nb = await createNotebook(title, description, folderId);
              if (cover) await setNotebookCover(nb.id, cover);
              await refresh();
              setOpenId(nb.id);
            }}
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
    </AudioPlayerProvider>
  );
}
