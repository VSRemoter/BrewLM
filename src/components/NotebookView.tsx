import {
  ArrowLeft,
  Library,
  MessageSquare,
  Settings as SettingsIcon,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import {
  addMessage,
  addSource,
  cloneNotebook,
  createChat,
  ensureChat,
  deleteAllChats,
  deleteArtifacts,
  deleteChat,
  deleteSources,
  listArtifacts,
  listChats,
  setChatPinned,
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
import PairPhonePanel from "./PairPhonePanel";
import SourcesPanel from "./SourcesPanel";
import StudioPanel, { type StudioPanelHandle } from "./StudioPanel";
import { IconButton, Modal } from "./ui";
import { onRemoteChanges } from "../lib/sync";
import { platform } from "../platform";
import { NARROW, useMediaQuery } from "../lib/usePhone";

const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));
const LS = { left: "om.panel.left", right: "om.panel.right", split: "om.split.left" };
const num = (key: string, fallback: number) => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Minimum Studio width while reading an output (reports, quizzes, mind maps…). */
const STUDIO_READING_W = 460;

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
  const [pairOpen, setPairOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(notebook.title);
  const [leftW, setLeftW] = useState(() => clamp(200, 560, num(LS.left, 264)));
  const [rightW, setRightW] = useState(() => clamp(240, 620, num(LS.right, 288)));
  const [split, setSplit] = useState(() => clamp(0.25, 0.8, num(LS.split, 0.62)));
  const leftColRef = useRef<HTMLDivElement>(null);
  /** Phones and upright tablets show one panel at a time (see the end of this component). */
  const phone = useMediaQuery(NARROW);
  const [tab, setTab] = useState<"sources" | "chat" | "studio">("chat");
  const [chatsOpen, setChatsOpen] = useState(false);
  /** Touch screens: the on-screen keyboard is up (a text field has focus); the tab bar steps aside. */
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!phone || !window.matchMedia("(pointer: coarse)").matches) return;
    const isField = (el: EventTarget | Element | null) =>
      el instanceof HTMLElement && el.matches("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]");
    const onFocus = (e: FocusEvent) => setTyping(isField(e.target));
    // Focus may be moving to another field: check where it landed.
    const onBlur = () => setTimeout(() => setTyping(isField(document.activeElement)), 0);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      setTyping(false);
    };
  }, [phone]);
  const studioRef = useRef<StudioPanelHandle>(null);

  // persist layout preferences
  useEffect(() => { localStorage.setItem(LS.left, String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem(LS.right, String(rightW)); }, [rightW]);
  /** While a Studio output is open, the panel is at least this wide for reading. */
  const [studioReading, setStudioReading] = useState(false);
  const studioW = studioReading ? Math.max(rightW, STUDIO_READING_W) : rightW;
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

  // Changes pulled from other devices (BrewLM Sync).
  useEffect(
    () =>
      onRemoteChanges((c) => {
        if (c.tables.has("sources")) void refreshSources();
        if (c.tables.has("artifacts")) void refreshArtifacts();
        if (c.tables.has("chats"))
          void refreshChats().then((list) =>
            setActiveChatId((cur) => (list.some((ch) => ch.id === cur) ? cur : list[0]?.id ?? null))
          );
      }),
    [refreshSources, refreshArtifacts, refreshChats]
  );

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
    async (text: string, title?: string) => {
      const flat = text.replace(/\s+/g, " ").trim();
      title ||= flat.length > 42 ? flat.slice(0, 42).trimEnd() + "…" : flat || "Pasted note";
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

  // Load per-notebook data; guarantee at least one chat exists (atomic in the
  // DB — StrictMode's double-mount can't duplicate it) and select the most
  // recently active one.
  useEffect(() => {
    setTitleDraft(notebook.title);
    refreshSources();
    refreshArtifacts();
    let cancelled = false;
    (async () => {
      await ensureChat(notebook.id);
      const list = await refreshChats();
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
      drawing: "drawing", drawings: "drawing",
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
        return { reply: `I don't know a studio output type "${filter}" — try flashcards, quizzes, mindmaps, audios, reports, research, drawings, or notes.` };
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

  // Each panel is built once and placed in whichever layout this screen uses.
  const header = (
    <header
      className={`flex shrink-0 items-center gap-2 border-b border-edge-soft bg-panel px-3 ${
        phone ? "safe-top box-content h-12" : "h-12"
      }`}
    >
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
      {platform.kind === "desktop" && (
        <IconButton onClick={() => setPairOpen(true)} label="Pair your phone">
          <Smartphone size={15} strokeWidth={1.8} />
        </IconButton>
      )}
      <IconButton onClick={onOpenSettings} label="Settings">
        <SettingsIcon size={15} strokeWidth={1.8} />
      </IconButton>
    </header>
  );

  const sourcesPanel = <SourcesPanel notebookId={notebook.id} sources={sources} onChanged={refreshSources} />;

  const chatsPanel = (
    <ChatsPanel
      chats={chats}
      activeChatId={activeChatId}
      onSelect={(chatId) => {
        setActiveChatId(chatId);
        setChatsOpen(false);
      }}
      onNew={() => {
        void newChat();
        setChatsOpen(false);
      }}
      onRename={async (chatId, title) => {
        await renameChat(chatId, title);
        await refreshChats();
      }}
      onDelete={handleDeleteChat}
      onPin={async (chatId, pinned) => {
        await setChatPinned(chatId, pinned);
        await refreshChats();
      }}
    />
  );

  const chatPanel = (
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
      onStudioCommand={(cmd) => {
        if (phone) setTab("studio"); // show what the command makes
        return studioRef.current!.run(cmd);
      }}
      onCloneNotebook={handleClone}
      onRemove={handleRemove}
      notebookStarred={notebook.starred === 1}
      notebookGrounded={notebook.grounded ?? 1}
      chatBg={notebook.chat_bg}
      chatBgDim={notebook.chat_bg_dim}
      onChatBgChange={async (bg, dim) => {
        await setNotebookChatBg(notebook.id, bg);
        await setNotebookChatBgDim(notebook.id, dim);
        onNotebookMoved();
      }}
      onShowChats={phone ? () => setChatsOpen(true) : undefined}
    />
  );

  const studioPanel = (
    <StudioPanel
      ref={studioRef}
      notebookId={notebook.id}
      width={phone ? "100%" : studioW}
      onReadingChange={setStudioReading}
      sources={sources}
      artifacts={artifacts}
      settings={settings}
      onArtifactsChanged={refreshArtifacts}
      onSourcesChanged={refreshSources}
      onOpenSettings={onOpenSettings}
    />
  );

  const pairModal = pairOpen && (
    <Modal title="Pair your phone" onClose={() => setPairOpen(false)}>
      <PairPhonePanel />
    </Modal>
  );

  if (phone) {
    // One panel at a time, picked from the tab bar. All three stay mounted
    // (hidden ones too), so a streaming reply or a Studio job carries on.
    const tabs = [
      { id: "sources", label: "Sources", icon: Library, badge: sources.length || undefined },
      { id: "chat", label: "Chat", icon: MessageSquare },
      { id: "studio", label: "Studio", icon: Sparkles, badge: artifacts.length || undefined },
    ] as const;
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="relative min-h-0 flex-1">
          <div className={`absolute inset-0 flex flex-col bg-panel ${tab === "sources" ? "" : "hidden"}`}>{sourcesPanel}</div>
          <div className={`absolute inset-0 flex flex-col ${tab === "chat" ? "" : "hidden"}`}>{chatPanel}</div>
          <div className={`absolute inset-0 flex flex-col ${tab === "studio" ? "" : "hidden"}`}>{studioPanel}</div>
        </div>
        <nav
          className={`safe-bottom shrink-0 border-t border-edge-soft bg-panel ${typing ? "hidden" : "flex"}`}
          aria-label="Notebook sections"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                tab === t.id ? "text-accent" : "text-ink-3"
              }`}
            >
              <span className="relative">
                <t.icon size={20} strokeWidth={tab === t.id ? 2.1 : 1.7} />
                {"badge" in t && t.badge !== undefined && (
                  <span className="absolute -right-2.5 -top-1 min-w-4 rounded-full bg-hover px-1 text-center text-[9.5px] leading-4 text-ink-2">
                    {t.badge}
                  </span>
                )}
              </span>
              {t.label}
            </button>
          ))}
        </nav>
        {chatsOpen && (
          <Modal title="Chats" onClose={() => setChatsOpen(false)}>
            <div className="-mx-5 -my-4 flex max-h-[60dvh] min-h-48 flex-col">{chatsPanel}</div>
          </Modal>
        )}
        {pairModal}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      {pairModal}

      {/* three panels */}
      <div className="flex min-h-0 flex-1">
        <div
          ref={leftColRef}
          className="anim-panel-left flex h-full shrink-0 flex-col border-r border-edge-soft bg-panel"
          style={{ width: leftW }}
        >
          <div className="flex min-h-0 flex-col" style={{ flex: `${split} 1 0%`, minHeight: 110 }}>
            {sourcesPanel}
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
            {chatsPanel}
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
        {chatPanel}
        <div
          role="separator"
          aria-label="Resize studio panel"
          onPointerDown={(e) => {
            const start = studioW;
            startDrag(e, (dx) => setRightW(clamp(240, 620, start - dx)));
          }}
          className="w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-hover"
        />
        {studioPanel}
      </div>
    </div>
  );
}
