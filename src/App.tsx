import { useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import NotebookView from "./components/NotebookView";
import SettingsModal from "./components/SettingsModal";
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
import type { Folder, Notebook, Settings } from "./lib/types";

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [trashedNotebooks, setTrashedNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const reloadSettings = useCallback(async () => {
    setSettings(await loadSettings());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await getDb();
        const s = await loadSettings();
        applyTheme(s.theme);
        applyFont(s.font);
        setSettings(s);
        await refresh();
        setReady(true);
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
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            reloadSettings();
          }}
        />
      )}
    </div>
  );
}
