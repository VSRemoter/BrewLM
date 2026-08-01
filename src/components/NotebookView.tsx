import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { listArtifacts, listSources, renameNotebook } from "../lib/db";
import type { Artifact, Notebook, Settings, Source } from "../lib/types";
import ChatPanel from "./ChatPanel";
import SourcesPanel from "./SourcesPanel";
import StudioPanel from "./StudioPanel";
import { IconButton } from "./ui";

export default function NotebookView({
  notebook,
  settings,
  onBack,
  onOpenSettings,
  onRenamed,
}: {
  notebook: Notebook;
  settings: Settings;
  onBack: () => void;
  onOpenSettings: () => void;
  onRenamed: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [titleDraft, setTitleDraft] = useState(notebook.title);

  const refreshSources = useCallback(async () => {
    setSources(await listSources(notebook.id));
  }, [notebook.id]);

  const refreshArtifacts = useCallback(async () => {
    setArtifacts(await listArtifacts(notebook.id));
  }, [notebook.id]);

  useEffect(() => {
    setTitleDraft(notebook.title);
    refreshSources();
    refreshArtifacts();
  }, [notebook.id, notebook.title, refreshSources, refreshArtifacts]);

  const commitTitle = async () => {
    const t = titleDraft.trim();
    if (t && t !== notebook.title) {
      await renameNotebook(notebook.id, t);
      onRenamed();
    } else {
      setTitleDraft(notebook.title);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* notebook header */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge-soft bg-panel px-3">
        <IconButton onClick={onBack} label="Back to notebooks">
          <ArrowLeft size={16} strokeWidth={1.8} />
        </IconButton>
        <input
         	value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[14px] font-semibold tracking-tight outline-none hover:bg-hover-soft focus:bg-hover-soft"
          aria-label="Notebook title"
        />
        <IconButton onClick={onOpenSettings} label="Settings">
          <SettingsIcon size={15} strokeWidth={1.8} />
        </IconButton>
      </header>

      {/* three panels */}
      <div className="flex min-h-0 flex-1">
        <SourcesPanel
          notebookId={notebook.id}
          sources={sources}
          onChanged={refreshSources}
        />
        <ChatPanel
          notebookId={notebook.id}
          notebookTitle={notebook.title}
          sources={sources}
          settings={settings}
          onOpenSettings={onOpenSettings}
        />
        <StudioPanel
          notebookId={notebook.id}
          sources={sources}
          artifacts={artifacts}
          settings={settings}
          onArtifactsChanged={refreshArtifacts}
          onSourcesChanged={refreshSources}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}
