import { useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import NotebookView from "./components/NotebookView";
import SettingsModal from "./components/SettingsModal";
import {
  createFolder,
  createNotebook,
  deleteFolder,
  deleteNotebook,
  getDb,
  listFolders,
  listNotebooks,
  moveNotebookToFolder,
  setFolderCover,
  setNotebookCover,
  setNotebookStarred,
  updateFolderDetails,
  updateNotebookDetails,
} from "./lib/db";
import { loadSettings } from "./lib/settings";
import { applyTheme } from "./lib/themes";
import type { Folder, Notebook, Settings } from "./lib/types";

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [nbs, fds] = await Promise.all([listNotebooks(), listFolders()]);
    setNotebooks(nbs);
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
            OpenMind couldn't load its database
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
        />
      ) : (
        <Home
          notebooks={notebooks}
          folders={folders}
          onOpen={setOpenId}
          onSettings={() => setSettingsOpen(true)}
          onCreate={async (title, description, folderId) => {
            const nb = await createNotebook(title, description, folderId);
            await refresh();
            setOpenId(nb.id);
          }}
          onDelete={async (id) => {
            await deleteNotebook(id);
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
