import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import {
  addMessage,
  addSource,
  cloneNotebook,
  createChat,
  deleteAllChats,
  deleteArtifacts,
  deleteChat,
  deleteSources,
  listArtifacts,
  listChats,
  listSources,
  renameChat,
  renameNotebook,
  setNotebookChatBg,
  setNotebookChatBgDim,
  touchChat,
} from "../lib/db";
import { ingestFiles } from "../lib/ingest";
import { fetchLinkContent } from "../lib/source";
import type { Artifact, ArtifactKind, Chat, Notebook, Settings, Source, SourceType } from "../lib/types";
import ChatPanel from "./ChatPanel";
import ChatsPanel from "./ChatsPanel";
import SourcesPanel from "./SourcesPanel";
import StudioPanel, { type StudioPanelHandle } from "./StudioPanel";
import { IconButton } from "./ui";

const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));
const LS = { left: "om.panel.left", right: "om.panel.right", split: "om.split.left" };
const num = (key: string, fallback: number) => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export default function NotebookView({
  notebook,
  settings,
  onBack,
  onOpenSettings,
  onRenamed,
  onNotebookMoved,
  onSettingsChanged,
  onOpenNotebook,
}: {
  notebook: Notebook;
  settings: Settings;
  onBack: () => void;
  onOpenSettings: () => void;
  onRenamed: () => void;
  /** Folder changes via /move in chat — App refreshes notebooks+folders. */
  onNotebookMoved: () => void;
  /** Settings mutated via /model in chat — App reloads the settings object. */
  onSettingsChanged: () => void;
  /** /clone yes — App switches to the cloned notebook. */
  onOpenNotebook: (id: string) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(notebook.title);
  const [leftW, setLeftW] = useState(() => clamp(200, 560, num(LS.left, 264)));
  const [rightW, setRightW] = useState(() => clamp(240, 620, num(LS.right, 288)));
  const [split, setSplit] = useState(() => clamp(0.25, 0.8, num(LS.split, 0.62)));
  const leftColRef = useRef<HTMLDivElement>(null);
  const studioRef = useRef<StudioPanelHandle>(null);

  // persist layout preferences
  useEffect(() => { localStorage.setItem(LS.left, String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem(LS.right, String(rightW)); }, [rightW]);
  useEffect(() => { localStorage.setItem(LS.split, String(split)); }, [split]);

  /** Pointer-drag helper: tracks deltas, disables selection while dragging. */
  const startDrag = useCallback(
    (e: RPointerEvent, onMove: (dx: number, dy: number) => void) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      document.body.classList.add("select-none");
      const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("select-none");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    []
  );

  const refreshSources = useCallback(async () => {
    setSources(await listSources(notebook.id));
  }, [notebook.id]);

  const refreshArtifacts = useCallback(async () => {
    setArtifacts(await listArtifacts(notebook.id));
  }, [notebook.id]);

  const refreshChats = useCallback(async () => {
    const list = await listChats(notebook.id);
    setChats(list);
    return list;
  }, [notebook.id]);

  /** Files dropped/picked in chat become notebook sources (+ auto-@mention). */
  const handleChatFiles = useCallback(
    async (files: FileList | File[]) => {
      const result = await ingestFiles(notebook.id, files);
      refreshSources();
      return result;
    },
    [notebook.id, refreshSources]
  );

  /** `/note <text>` in chat — save pasted text as a source. */
  const handleAddNote = useCallback(
    async (text: string) => {
      const flat = text.replace(/\s+/g, " ").trim();
      const title = flat.length > 42 ? flat.slice(0, 42).trimEnd() + "…" : flat || "Pasted note";
      const src = await addSource(notebook.id, "text", title, text);
      refreshSources();
      return src;
    },
    [notebook.id, refreshSources]
  );

  /** `/url <link>` in chat — fetch a web page and save it as a link source. */
  const handleAddLink = useCallback(
    async (url: string) => {
      const { title, text } = await fetchLinkContent(url);
      const src = await addSource(notebook.id, "link", title, text, url);
      refreshSources();
      return src;
    },
    [notebook.id, refreshSources]
  );

  // Load per-notebook data; guarantee at least one chat exists and select the
  // most recently active one.
  useEffect(() => {
    setTitleDraft(notebook.title);
    refreshSources();
    refreshArtifacts();
    let cancelled = false;
    (async () => {
      let list = await refreshChats();
      if (list.length === 0) {
        await createChat(notebook.id);
        list = await refreshChats();
      }
      if (!cancelled) {
        setChats(list);
        setActiveChatId((cur) =>
          list.some((c) => c.id === cur) ? cur : list[0]?.id ?? null
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notebook.id, notebook.title, refreshSources, refreshArtifacts, refreshChats]);

  const commitTitle = async () => {
    const t = titleDraft.trim();
    if (t && t !== notebook.title) {
      await renameNotebook(notebook.id, t);
      onRenamed();
    } else {
      setTitleDraft(notebook.title);
    }
  };

  const newChat = async () => {
    const chat = await createChat(notebook.id);
    await refreshChats();
    setActiveChatId(chat.id);
  };

  /** /clone command — exact copy of this notebook (sources, chats, studio). */
  const handleClone = async (title: string, jump: boolean): Promise<string> => {
    const clone = await cloneNotebook(notebook.id, title, { includeChats: true });
    onNotebookMoved(); // App refreshes the homepage lists
    if (jump) onOpenNotebook(clone.id);
    return clone.title;
  };

  /**
   * /remove command — bulk delete sources (optionally one type), all chats,
   * or studio outputs (optionally one kind). Chats get replaced by a fresh one.
   */
  const handleRemove = async (
    what: string,
    filter?: string
  ): Promise<{ reply: string; chatReplaced?: boolean }> => {
    const SOURCE_TYPES: Record<string, SourceType> = {
      text: "text", texts: "text",
      link: "link", links: "link",
      pdf: "pdf", pdfs: "pdf",
      image: "image", images: "image",
      audio: "audio", audios: "audio",
      file: "file", files: "file",
      context: "context",
    };
    const ARTIFACT_KINDS: Record<string, ArtifactKind> = {
      flashcard: "flashcards", flashcards: "flashcards",
      quiz: "quiz", quizzes: "quiz",
      mindmap: "mindmap", mindmaps: "mindmap",
      audio: "audio", audios: "audio",
      report: "report", reports: "report",
      research: "research",
      note: "notes", notes: "notes",
    };

    if (what === "sources") {
      const t = filter ? SOURCE_TYPES[filter] : undefined;
      if (filter && !t) {
        return { reply: `I don't know a source type "${filter}" — try text, links, pdf, images, audio, files, or context.` };
      }
      const n = await deleteSources(notebook.id, t);
      refreshSources();
      return {
        reply: n === 0
          ? `No sources${t ? ` of type ${t}` : ""} to remove.`
          : `Removed ${n} ${t ? t + " " : ""}source${n === 1 ? "" : "s"}.`,
      };
    }

    if (what === "chats") {
      await deleteAllChats(notebook.id);
      const fresh = await createChat(notebook.id);
      await refreshChats();
      setActiveChatId(fresh.id);
      const reply = "Removed all chats — this is a fresh one.";
      // The old chat (and the message this command ran in) is gone: post the
      // confirmation into the fresh chat ourselves.
      await addMessage(fresh.id, notebook.id, "assistant", reply);
      return { reply, chatReplaced: true };
    }

    if (what === "studios") {
      const k = filter ? ARTIFACT_KINDS[filter] : undefined;
      if (filter && !k) {
        return { reply: `I don't know a studio output type "${filter}" — try flashcards, quizzes, mindmaps, audios, reports, research, or notes.` };
      }
      const n = await deleteArtifacts(notebook.id, k);
      refreshArtifacts();
      return {
        reply: n === 0
          ? `No studio outputs${k ? ` of type ${k}` : ""} to remove.`
          : `Removed ${n} ${k ? k + " " : ""}studio output${n === 1 ? "" : "s"}.`,
      };
    }

    return { reply: "I didn't get that — try /remove sources, /remove chats, or /remove studios." };
  };

  /** Called by ChatPanel whenever a message lands; auto-titles fresh chats. */
  const handleChatActivity = useCallback(
    async (chatId: string, firstUserText?: string) => {
      await touchChat(chatId);
      const list = await refreshChats();
      const chat = list.find((c) => c.id === chatId);
      if (chat && chat.title === "New chat" && firstUserText) {
        const title = firstUserText.replace(/\s+/g, " ").trim().slice(0, 48);
        await renameChat(chatId, title + (firstUserText.trim().length > 48 ? "…" : ""));
        await refreshChats();
      }
    },
    [refreshChats]
  );

  const handleDeleteChat = async (chatId: string) => {
    await deleteChat(chatId);
    const list = await refreshChats();
    if (chatId === activeChatId) {
      if (list.length > 0) {
        setActiveChatId(list[0].id);
      } else {
        const fresh = await createChat(notebook.id);
        await refreshChats();
        setActiveChatId(fresh.id);
      }
    }
  };

  /** `/clear` in chat — delete the active thread; a fresh one is auto-selected. */
  const handleClearChat = async () => {
    if (!activeChatId) return;
    await handleDeleteChat(activeChatId);
  };

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

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
        <div
          ref={leftColRef}
          className="flex h-full shrink-0 flex-col border-r border-edge-soft bg-panel"
          style={{ width: leftW }}
        >
          <div className="flex min-h-0 flex-col" style={{ flex: `${split} 1 0%`, minHeight: 110 }}>
            <SourcesPanel
              notebookId={notebook.id}
              sources={sources}
              onChanged={refreshSources}
            />
          </div>
          <div
            role="separator"
            aria-label="Resize sources and chats"
            onPointerDown={(e) => {
              const start = split;
              const h = leftColRef.current?.clientHeight ?? 800;
              startDrag(e, (_dx, dy) => setSplit(clamp(0.25, 0.8, start + dy / h)));
            }}
            className="h-[5px] shrink-0 cursor-row-resize border-t border-edge-soft transition-colors hover:bg-hover"
          />
          <div className="flex min-h-0 flex-col" style={{ flex: `${1 - split} 1 0%`, minHeight: 90 }}>
            <ChatsPanel
              chats={chats}
              activeChatId={activeChatId}
              onSelect={setActiveChatId}
              onNew={newChat}
              onRename={async (chatId, title) => {
                await renameChat(chatId, title);
                await refreshChats();
              }}
              onDelete={handleDeleteChat}
            />
          </div>
        </div>
        <div
          role="separator"
          aria-label="Resize sources panel"
          onPointerDown={(e) => {
            const start = leftW;
            startDrag(e, (dx) => setLeftW(clamp(200, 560, start + dx)));
          }}
          className="w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-hover"
        />
        <ChatPanel
          notebookId={notebook.id}
          chatId={activeChatId}
          notebookTitle={notebook.title}
          notebookFolderId={notebook.folder_id}
          chatTitle={activeChat?.title ?? ""}
          sources={sources}
          artifacts={artifacts}
          settings={settings}
          onOpenSettings={onOpenSettings}
          onChatActivity={handleChatActivity}
          onAddFiles={handleChatFiles}
          onNotebookMoved={onNotebookMoved}
          onNewChat={newChat}
          onAddNote={handleAddNote}
          onAddLink={handleAddLink}
          onClearChat={handleClearChat}
          onReturnHome={onBack}
          onSettingsChanged={onSettingsChanged}
          onStudioCommand={(cmd) => studioRef.current!.run(cmd)}
          onCloneNotebook={handleClone}
          onRemove={handleRemove}
           notebookStarred={notebook.starred === 1}
           chatBg={notebook.chat_bg}
           chatBgDim={notebook.chat_bg_dim}
           onChatBgChange={async (bg, dim) => {
             await setNotebookChatBg(notebook.id, bg);
             await setNotebookChatBgDim(notebook.id, dim);
             onNotebookMoved();
           }}
         />
        <div
          role="separator"
          aria-label="Resize studio panel"
          onPointerDown={(e) => {
            const start = rightW;
            startDrag(e, (dx) => setRightW(clamp(240, 620, start - dx)));
          }}
          className="w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-hover"
        />
        <StudioPanel
          ref={studioRef}
          notebookId={notebook.id}
          width={rightW}
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
