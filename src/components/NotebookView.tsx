import {
  ArrowLeft,
  Library,
  MessageSquare,
  Settings as SettingsIcon,
  Share2,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import {
  addMessage,
  addSource,
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
  setSetting,
  touchChat,
} from "../lib/db";
import { cloneNotebook } from "../lib/share";
import { ingestFiles } from "../lib/ingest";
import { fetchLinkContent } from "../lib/source";
import type { Artifact, ArtifactKind, Chat, Notebook, Provider, Settings, Source, SourceType } from "../lib/types";
import { MiniPlayerDock } from "./AudioPlayer";
import ChatPanel from "./ChatPanel";
import ChatsPanel from "./ChatsPanel";
import { confirmAction } from "./ConfirmDialog";
import PairPhonePanel from "./PairPhonePanel";
import ShareDialog from "./ShareDialog";
import SharedBanner from "./SharedBanner";
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

/** How many chats a notebook can show side by side. */
const MAX_PANES = 3;
/**
 * One chat shown in the notebook. `model` is the pane's own model (for
 * `provider`); without one, or after the provider changes, it follows the
 * app-wide model from Settings.
 */
type Pane = { id: string; chatId: string; model?: string; provider?: Provider };
const paneOf = (chatId: string): Pane => ({ id: crypto.randomUUID(), chatId });
const panesKey = (notebookId: string) => `om.chatPanes.${notebookId}`;
const loadPanes = (notebookId: string): Pane[] => {
  try {
    const v = JSON.parse(localStorage.getItem(panesKey(notebookId)) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((p) => typeof p?.chatId === "string")
      .slice(0, MAX_PANES)
      .map((p) => ({ ...p, id: typeof p.id === "string" ? p.id : crypto.randomUUID() }));
  } catch {
    return [];
  }
};

/** Minimum Studio width while reading an output (reports, quizzes, mind maps…). */
const STUDIO_READING_W = 460;

export default function NotebookView({
  notebook,
  settings,
  tabbed,
  shown = true,
  onBack,
  onOpenSettings,
  onRenamed,
  onNotebookMoved,
  onSettingsChanged,
  onOpenNotebook,
}: {
  notebook: Notebook;
  settings: Settings;
  /** Desktop: App's tab strip is the top bar, so this view draws no header. */
  tabbed?: boolean;
  /** This notebook is the one on screen (App keeps other open notebooks mounted, hidden). */
  shown?: boolean;
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
  const [shareOpen, setShareOpen] = useState(false);
  /** Opened from someone's link: their sources and outputs can't be changed here. */
  const readOnly = !!notebook.share_id;
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  /** The chats on screen, left to right (one on phones). */
  const [panes, setPanes] = useState<Pane[]>([]);
  /** The pane the chat list, "New chat" and /clear act on. */
  const [focusedPane, setFocusedPane] = useState(0);
  const focusIdx = Math.min(focusedPane, Math.max(panes.length - 1, 0));
  const activeChatId = panes[focusIdx]?.chatId ?? null;
  /** Show `chatId` in the focused pane; a chat already open in another pane is focused there instead. */
  const setActiveChatId = useCallback(
    (chatId: string | null) => {
      if (!chatId) return;
      setPanes((cur) => {
        const at = cur.findIndex((p) => p.chatId === chatId);
        if (at >= 0) {
          setFocusedPane(at);
          return cur;
        }
        if (cur.length === 0) return [paneOf(chatId)];
        const i = Math.min(focusedPane, cur.length - 1);
        return cur.map((p, j) => (j === i ? { ...p, chatId } : p));
      });
    },
    [focusedPane]
  );
  /** Keep panes whose chats still exist; never leave none while there's a chat. */
  const prunePanes = useCallback((list: Chat[]) => {
    setPanes((cur) => {
      const kept = cur.filter((p) => list.some((c) => c.id === p.chatId));
      if (kept.length === cur.length && kept.length > 0) return cur;
      return kept.length ? kept : list[0] ? [paneOf(list[0].id)] : [];
    });
  }, []);
  // Remember which chats were open side by side, per notebook.
  useEffect(() => {
    if (panes.length) localStorage.setItem(panesKey(notebook.id), JSON.stringify(panes));
  }, [panes, notebook.id]);
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
        if (c.tables.has("chats")) void refreshChats().then(prunePanes);
      }),
    [refreshSources, refreshArtifacts, refreshChats, prunePanes]
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
      const { title, text, finalUrl } = await fetchLinkContent(url);
      const src = await addSource(notebook.id, "link", title, text, finalUrl);
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
        setPanes((cur) => {
          const exists = (p: Pane) => list.some((c) => c.id === p.chatId);
          if (cur.length && cur.every(exists)) return cur;
          // First open: bring back the panes from last time.
          const saved = (cur.length ? cur : loadPanes(notebook.id)).filter(exists);
          return saved.length ? saved : list[0] ? [paneOf(list[0].id)] : [];
        });
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

  /** Open a fresh chat beside the others (up to MAX_PANES), on the app's current model. */
  const addPane = async () => {
    if (panes.length >= MAX_PANES) return;
    const chat = await createChat(notebook.id);
    await refreshChats();
    setPanes((cur) =>
      cur.length >= MAX_PANES ? cur : [...cur, { ...paneOf(chat.id), model: settings.model, provider: settings.provider }]
    );
    setFocusedPane(panes.length);
  };

  /** The model a pane runs: its own, unless the provider changed since it was picked. */
  const paneModel = (p: Pane) => (p.model && p.provider === settings.provider ? p.model : settings.model);

  const closePane = async (i: number) => {
    const rest = panes.filter((_, j) => j !== i);
    if (rest.length === 0) return;
    // Down to one chat: it keeps the model it was on, which becomes the app's model.
    if (rest.length === 1) {
      const m = paneModel(rest[0]);
      rest[0] = { id: rest[0].id, chatId: rest[0].chatId };
      if (m !== settings.model) {
        await setSetting("model", m);
        onSettingsChanged();
      }
    }
    setPanes(rest);
    setFocusedPane((f) => (f > i ? f - 1 : Math.min(f, rest.length - 1)));
  };

  const setPaneModel = (i: number, model: string) =>
    setPanes((cur) => cur.map((p, j) => (j === i ? { ...p, model, provider: settings.provider } : p)));

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
    const CANCELLED = { reply: "Cancelled — nothing was removed." };
    const confirmRemove = (what: string) =>
      confirmAction({
        title: "Remove from this notebook?",
        message: `This deletes ${what}. This can't be undone.`,
        confirmLabel: "Remove",
      });
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
      interactive: "interactive", interactives: "interactive",
    };

    if (what === "sources") {
      const t = filter ? SOURCE_TYPES[filter] : undefined;
      if (filter && !t) {
        return { reply: `I don't know a source type "${filter}" — try text, links, pdf, images, audio, files, or context.` };
      }
      const count = sources.filter((s) => !t || s.type === t).length;
      if (count > 0 && !(await confirmRemove(`${count} ${t ? t + " " : ""}source${count === 1 ? "" : "s"}`))) return CANCELLED;
      const n = await deleteSources(notebook.id, t);
      refreshSources();
      return {
        reply: n === 0
          ? `No sources${t ? ` of type ${t}` : ""} to remove.`
          : `Removed ${n} ${t ? t + " " : ""}source${n === 1 ? "" : "s"}.`,
      };
    }

    if (what === "chats") {
      if (!(await confirmRemove(`all ${chats.length} chat${chats.length === 1 ? "" : "s"}, including this one`))) return CANCELLED;
      await deleteAllChats(notebook.id);
      const fresh = await createChat(notebook.id);
      await refreshChats();
      setPanes((cur) => [{ ...(cur[focusIdx] ?? paneOf(fresh.id)), chatId: fresh.id }]);
      setFocusedPane(0);
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
      const count = artifacts.filter((a) => !k || a.kind === k).length;
      if (count > 0 && !(await confirmRemove(`${count} ${k ? k + " " : ""}studio output${count === 1 ? "" : "s"}`))) return CANCELLED;
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
    const at = panes.findIndex((p) => p.chatId === chatId);
    if (at < 0) return;
    if (panes.length > 1) {
      // Side by side: the pane closes with its chat.
      const rest = panes.filter((_, j) => j !== at);
      setPanes(rest);
      setFocusedPane((f) => (f > at ? f - 1 : Math.min(f, rest.length - 1)));
      return;
    }
    const next = list[0] ?? (await createChat(notebook.id));
    if (!list[0]) await refreshChats();
    setPanes((cur) => cur.map((p, j) => (j === at ? { ...p, chatId: next.id } : p)));
  };

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
        readOnly={readOnly}
        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[14px] font-semibold tracking-tight outline-none hover:bg-hover-soft focus:bg-hover-soft"
        aria-label="Notebook title"
      />
      {!readOnly && (
        <IconButton onClick={() => setShareOpen(true)} label="Share notebook">
          <Share2 size={15} strokeWidth={1.8} />
        </IconButton>
      )}
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

  const constitutionOn = (notebook.constitution_on ?? 1) !== 0;
  const sourcesPanel = (
    <SourcesPanel
      notebookId={notebook.id}
      sources={sources}
      constitutionOn={constitutionOn}
      onChanged={refreshSources}
      showDetails={settings.showDetails}
      readOnly={readOnly}
    />
  );
  // Studio never sees the constitution — it governs chat only; Studio tools
  // carry their own settings (customize modals).
  const studioSources = useMemo(() => sources.filter((s) => s.type !== "context"), [sources]);

  const chatsPanel = (
    <ChatsPanel
      chats={chats}
      activeChatId={activeChatId}
      openChatIds={panes.length > 1 ? panes.map((p) => p.chatId) : undefined}
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

  const panesFor = phone ? panes.slice(focusIdx, focusIdx + 1) : panes;
  /** Settings as a pane sees them: its own model swapped in (one stable object per model). */
  const settingsFor = useMemo(() => {
    const cache = new Map<string, Settings>();
    return (model: string) => {
      if (model === settings.model) return settings;
      if (!cache.has(model)) cache.set(model, { ...settings, model });
      return cache.get(model)!;
    };
  }, [settings]);
  const chatPanelFor = (pane: Pane, i: number) => {
    const chat = chats.find((c) => c.id === pane.chatId);
    const model = paneModel(pane);
    const own = panes.length > 1 && !phone;
    return (
    <ChatPanel
      key={pane.id}
      notebookId={notebook.id}
      chatId={pane.chatId}
      notebookTitle={notebook.title}
      notebookFolderId={notebook.folder_id}
      chatTitle={chat?.title ?? ""}
      sources={sources}
      artifacts={artifacts}
      settings={settingsFor(model)}
      onOpenSettings={onOpenSettings}
      onChatActivity={handleChatActivity}
      onAddFiles={handleChatFiles}
      onNotebookMoved={onNotebookMoved}
      onNewChat={async () => {
        setFocusedPane(i);
        const c = await createChat(notebook.id);
        await refreshChats();
        setPanes((cur) => cur.map((p, j) => (j === i ? { ...p, chatId: c.id } : p)));
      }}
      onAddNote={handleAddNote}
      onAddLink={handleAddLink}
      onClearChat={() => handleDeleteChat(pane.chatId)}
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
      notebookConstitutionOn={notebook.constitution_on ?? 1}
      chatBg={notebook.chat_bg}
      chatBgDim={notebook.chat_bg_dim}
      onChatBgChange={async (bg, dim) => {
        await setNotebookChatBg(notebook.id, bg);
        await setNotebookChatBgDim(notebook.id, dim);
        onNotebookMoved();
      }}
      onShowChats={phone ? () => setChatsOpen(true) : undefined}
      onSetModel={own ? (id) => setPaneModel(i, id) : undefined}
      onSplit={!phone && panes.length < MAX_PANES ? () => void addPane() : undefined}
      onClosePane={own ? () => void closePane(i) : undefined}
      focused={!own || i === focusIdx}
      onFocusPane={own && i !== focusIdx ? () => setFocusedPane(i) : undefined}
    />
    );
  };

  const studioPanel = (
    <StudioPanel
      ref={studioRef}
      notebookId={notebook.id}
      width={phone ? "100%" : studioW}
      onReadingChange={setStudioReading}
      sources={studioSources}
      artifacts={artifacts}
      settings={settings}
      onArtifactsChanged={refreshArtifacts}
      onSourcesChanged={refreshSources}
      onOpenSettings={onOpenSettings}
      readOnly={readOnly}
    />
  );

  const pairModal = pairOpen && (
    <Modal title="Pair your phone" onClose={() => setPairOpen(false)}>
      <PairPhonePanel />
    </Modal>
  );

  const sharedBanner = readOnly && (
    <SharedBanner
      notebook={notebook}
      onUpdated={() => {
        refreshSources();
        refreshArtifacts();
        void refreshChats();
        onNotebookMoved(); // App reloads the notebook row (its version)
      }}
      onCopied={(id) => {
        onNotebookMoved();
        onOpenNotebook(id);
      }}
    />
  );

  const shareModal = shareOpen && (
    <ShareDialog
      notebookId={notebook.id}
      onClose={() => setShareOpen(false)}
      onOpenSettings={() => {
        setShareOpen(false);
        onOpenSettings();
      }}
    />
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
        {sharedBanner}
        <div className="relative min-h-0 flex-1">
          <div className={`absolute inset-0 flex flex-col bg-panel ${tab === "sources" ? "" : "hidden"}`}>{sourcesPanel}</div>
          <div className={`absolute inset-0 flex flex-col ${tab === "chat" ? "" : "hidden"}`}>{panesFor.map((p) => chatPanelFor(p, focusIdx))}</div>
          <div className={`absolute inset-0 flex flex-col ${tab === "studio" ? "" : "hidden"}`}>{studioPanel}</div>
        </div>
        {/* The audio player docks here, above the tabs, instead of floating over them. */}
        {shown && <div className={typing ? "hidden" : ""}><MiniPlayerDock level={1} /></div>}
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
        {shareModal}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!tabbed && header}
      {sharedBanner}
      {pairModal}
      {shareModal}

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
        {panesFor.map((p, i) => (
          <div key={p.id} className={`flex h-full min-w-0 flex-1 ${i > 0 ? "border-l border-edge-soft" : ""}`}>
            {chatPanelFor(p, i)}
          </div>
        ))}
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
