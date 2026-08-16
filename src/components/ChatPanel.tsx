import {
  AlignLeft,
  ArrowUp,
  ArrowUpFromLine,
  AudioLines,
  BookOpen,
  Copy,
  FileText,
  FolderClosed,
  GraduationCap,
  Image,
  Layers,
  Link,
  ListPlus,
  Loader2,
  MessageSquarePlus,
  Network,
  Palette,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Telescope,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMessage,
  clearMessages,
  findFolderByName,
  listFolders,
  moveNotebookToFolder,
  renameChat,
  setNotebookStarred,
  setSetting,
} from "../lib/db";
import type { IngestResult } from "../lib/ingest";
import { renderMarkdown } from "../lib/markdown";
import { hydrateMermaid } from "../lib/mermaid";
import {
  buildMentionCatalog,
  resolveMentions,
  segmentMentions,
  type MentionItem,
} from "../lib/mentions";
import { isAbortError, streamChat, type LlmMessage } from "../lib/llm";
import {
  activeKey,
  loadModelList,
  saveModelList,
} from "../lib/settings";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { ACCEPT_STRING, fileToCoverDataUrl } from "../lib/source";
import { parseStudioCommand, type StudioCommand } from "../lib/studioCommands";
import { BrewIcon } from "./BrewIcon";
import { THEMES, chooseTheme } from "../lib/themes";
import type { Artifact, ChatMessage, Folder, Settings, Source } from "../lib/types";
import { BrewingStatus, IconButton } from "./ui";

const MAX_CONSTITUTION_CHARS = 6000;
const MAX_SOURCE_CHARS = 6000;
const MAX_TOTAL_CONTEXT = 30_000;
const MAX_MENTION_CHARS = 8000;
const MAX_MENTION_TOTAL = 16_000;
const HISTORY_LIMIT = 16;

/** Empty-chat inspiration: one quote is picked each time a new chat opens. */
const CHAT_QUOTES: { text: string; author: string }[] = [
  { text: "The mind is not a vessel to be filled, but a fire to be kindled.", author: "Plutarch" },
  { text: "Somewhere, something incredible is waiting to be known.", author: "Carl Sagan" },
  { text: "I am still learning.", author: "Michelangelo" },
  { text: "The important thing is not to stop questioning.", author: "Albert Einstein" },
  { text: "Real knowledge is to know the extent of one's ignorance.", author: "Confucius" },
  { text: "He who learns but does not think, is lost; he who thinks but does not learn is in great danger.", author: "Confucius" },
  { text: "Wonder is the beginning of wisdom.", author: "Socrates" },
  { text: "It is not that I'm so smart. But I stay with the questions much longer.", author: "Albert Einstein" },
  { text: "We are a way for the cosmos to know itself.", author: "Carl Sagan" },
  { text: "The more I learn, the more I realize how much I don't know.", author: "Albert Einstein (attributed)" },
];

interface ChatCommand {
  cmd: string;
  usage: string;
  desc: string;
  icon: typeof FolderClosed;
  /** True when the command inserts a partial draft (expects an argument). */
  takesArgs: boolean;
  /** Argument kind with its own autocomplete popup. */
  autocomplete?: "theme" | "model";
}

/** Registry behind the `/` autocomplete palette. */
const COMMANDS: ChatCommand[] = [
  {
    cmd: "/help",
    usage: "/help",
    desc: "How to use BrewLM — setup, tools & tips",
    icon: BookOpen,
    takesArgs: false,
  },
  {
    cmd: "/model",
    usage: "/model <id>",
    desc: "Switch the active model (autocompletes yours)",
    icon: Settings2,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/move",
    usage: "/move <folder>",
    desc: "File this notebook into a folder (or /move out)",
    icon: FolderClosed,
    takesArgs: true,
  },
  {
    cmd: "/theme",
    usage: "/theme <name>",
    desc: "Switch the app theme instantly (e.g. /theme Wine)",
    icon: Palette,
    takesArgs: true,
    autocomplete: "theme",
  },
  {
    cmd: "/new",
    usage: "/new",
    desc: "Start a fresh chat — this one stays saved in the Chats panel",
    icon: MessageSquarePlus,
    takesArgs: false,
  },
  {
    cmd: "/clone",
    usage: "/clone \"<title>\" [yes|no]",
    desc: "Exact copy of this notebook (title in quotes; yes = jump to it)",
    icon: Copy,
    takesArgs: true,
  },
  {
    cmd: "/remove",
    usage: "/remove <sources|chats|studios> [type]",
    desc: "Bulk delete sources, chats, or studio outputs",
    icon: Trash2,
    takesArgs: true,
  },
  {
    cmd: "/return",
    usage: "/return",
    desc: "Back to the homepage",
    icon: BookOpen,
    takesArgs: false,
  },
  {
    cmd: "/clear",
    usage: "/clear",
    desc: "Delete this chat thread and start fresh",
    icon: Trash2,
    takesArgs: false,
  },
  {
    cmd: "/star",
    usage: "/star",
    desc: "Star or un-star this notebook",
    icon: Star,
    takesArgs: false,
  },
  {
    cmd: "/note",
    usage: "/note <text>",
    desc: "Paste text straight into your Sources",
    icon: StickyNote,
    takesArgs: true,
  },
  {
    cmd: "/url",
    usage: "/url <link>",
    desc: "Fetch a webpage into your Sources",
    icon: Link,
    takesArgs: true,
  },
  {
    cmd: "/summarize",
    usage: "/summarize",
    desc: "Summarize the whole notebook here in chat",
    icon: AlignLeft,
    takesArgs: false,
  },
  {
    cmd: "/flashcards",
    usage: "/flashcards [8|12|24] [easy|medium|hard] [focus]",
    desc: "Active-recall deck — saved to Studio",
    icon: Layers,
    takesArgs: true,
  },
  {
    cmd: "/quiz",
    usage: "/quiz [4|8|15] [easy|medium|hard] [focus]",
    desc: "Multiple-choice questions — saved to Studio",
    icon: GraduationCap,
    takesArgs: true,
  },
  {
    cmd: "/mindmap",
    usage: "/mindmap [focus]",
    desc: "Hierarchical outline of key ideas — saved to Studio",
    icon: Network,
    takesArgs: true,
  },
  {
    cmd: "/audio",
    usage: "/audio [format] [length] [focus]",
    desc: "Two-host podcast — deep-dive|brief|debate|critique · short|standard|long",
    icon: AudioLines,
    takesArgs: true,
  },
  {
    cmd: "/report",
    usage: "/report [summary|study-guide|briefing|faq|timeline|analysis|custom]",
    desc: "Grounded markdown document — saved to Studio",
    icon: FileText,
    takesArgs: true,
  },
  {
    cmd: "/research",
    usage: "/research <topic>",
    desc: "Web-powered cited report — saved to Studio",
    icon: Telescope,
    takesArgs: true,
  },
  {
    cmd: "/queue",
    usage: "/queue <prompt or command>",
    desc: "Line up a prompt/command to run when the current task finishes",
    icon: ListPlus,
    takesArgs: true,
  },
  {
    cmd: "/rename",
    usage: "/rename <title>",
    desc: "Rename this chat thread",
    icon: Pencil,
    takesArgs: true,
  },
];

const HELP_TEXT = `# BrewLM — quick start guide

BrewLM is a private, local-first study workspace: your documents stay on your computer, and the AI only sees the sources you share while chatting.

## 1. Connect a provider
Open **Settings** (gear icon, top right of any notebook):
1. Pick a provider — **OpenAI**, **Anthropic**, or **OpenRouter** (one OpenRouter key gives you access to Claude, GPT, Gemini, Llama, DeepSeek and many more).
2. Paste your API key. It is stored in the local database on your machine and is only sent to your chosen provider.
3. Choose a model — or edit the model list to add/remove models.
One key powers everything: chat, Studio tools, and web research.

## 2. Organize notebooks (homepage)
- Create a **notebook** per class, project, or topic. Edit its title, description and cover anytime.
- **Folders** keep things tidy: create one with "New folder", then drag notebooks into it — or use the /move command from chat. Click a folder to enter it, **← Notebooks** to go back.
- **Star** notebooks to pin them, switch between grid/list view, sort by date or name, and search by title.
- **Reuse** your work: hover a notebook card and click **Use as template** to make a sources-only starter copy, or type /clone inside a notebook for an exact copy — chats included.

## 3. Add sources (left panel)
Use **+** in the Sources panel to upload **PDFs, text, markdown, CSV, images or audio**, **paste text**, or add a **web link** (the page is fetched and cleaned automatically). PDF text is extracted locally, on your machine.
The **constitution** button adds a persona document (Professor, Tutor, Critic…). Edit that source — it changes how the AI behaves inside this notebook.

## 4. Chat
- Ask anything. Answers are grounded in your sources and **cite them by title**.
- **@-mention**: type \`@\` and pick a source or a saved output. Mentioned material gets **top priority**, so the reply centers on it — e.g. "Compare @Lecture 3 with @Lecture 5".
- **Drag files into the chat** to add them as sources and @-mention them automatically.
- Keep several **chat threads** per notebook (Chats panel, bottom left): create, rename, delete, switch.
- The AI can draw: ask for a mermaid flowchart, a diagram, or an SVG sketch and it renders inline.

## 5. Studio (right panel)
One click turns your sources into study materials. Every result is saved as an **artifact** you can reopen, **download** (.md / .mp3 / .wav), or **add back as a source**:

| Tool | What it does |
| --- | --- |
| Flashcards | Active-recall deck — 8/12/24 cards, difficulty & focus |
| Quiz | Multiple-choice questions with explanations — 4/8/15 |
| Mind map | Hierarchical outline of the key ideas |
| Report | Summary, Study guide, FAQ, Timeline, Briefing doc, or your own prompt |
| Audio overview | Two hosts (Alex & Sam) discuss your sources — Deep dive / Brief / Debate / Critique, then voiced via OpenAI, OpenRouter or ElevenLabs |
| Deep research | Plans search queries, browses the web, writes a cited report |

## 6. Chat commands
Type \`/\` in the composer to browse them (arrow keys + Enter).

**App actions** (run locally — no AI tokens):
- \`/help\` — shows this guide.
- \`/move <folder>\` — files this notebook into a folder (folder names autocomplete); \`/move out\` returns it to the homepage root.
- \`/theme <name>\` — switches the app theme instantly (names autocomplete). Available: ${THEMES.map((t) => t.name).join(", ")}. Also changeable in Settings.
- \`/model <id>\` — swaps the active AI model (your model list autocompletes). A new id is added to your list automatically.
- \`/star\` — stars or un-stars this notebook (pinned order on the homepage).
- \`/new\` — starts a fresh chat; the current conversation stays saved in the Chats panel.
- \`/clone "<title>" [yes|no]\` — makes an exact, independent copy of this whole notebook (sources, chats, studio work). **The title must be in quotes.** \`/clone "My copy"\` or \`/clone "My copy" no\` keeps you here; \`/clone "My copy" yes\` takes you there. Because the title is quoted, a *yes* or *no* inside it can't be confused for the flag — \`/clone "Project yes" no\` clones "Project yes" and stays put. For a sources-only starter copy, use **Use as template** on the homepage cards.
- \`/remove <sources|chats|studios> [type]\` — bulk delete. \`/remove sources\` wipes every source; \`/remove chats\` deletes all chat threads and starts fresh; \`/remove studios\` clears the Studio. Narrow it with a type, e.g. \`/remove sources links\` (text, links, pdf, images, audio, files) or \`/remove studios audios\` (flashcards, quizzes, mindmaps, audios, reports, research).
- \`/return\` — goes back to the homepage (everything is saved).
- \`/clear\` — deletes this chat thread entirely and starts fresh (unlike \`/new\`, which keeps it).
- \`/note <text>\` — pastes text straight into your Sources panel (great for lecture notes) and @-mentions it.
- \`/url <link>\` — fetches a webpage into your Sources panel and @-mentions it.
- \`/rename <title>\` — renames this chat thread, e.g. \`/rename "Math notes wk 4"\`.
- \`/queue <prompt or command>\` — lines up work while the AI is busy. Stackable: \`/queue /url <link>\` then \`/queue /summarize\` then \`/queue "Explain Bayes' theorem"\` run one after another, in order. Remove items from the queue bar that appears above the composer.

**AI actions** (use your provider):
- \`/summarize\` — a well-structured summary of the whole notebook, right here in chat.
- \`/flashcards [8|12|24] [easy|medium|hard] [focus]\` — e.g. \`/flashcards 24 hard photosynthesis\`.
- \`/quiz [4|8|15] [easy|medium|hard] [focus]\` — e.g. \`/quiz 15 easy\`.
- \`/mindmap [focus]\` — hierarchical outline of the key ideas.
- \`/audio [deep-dive|brief|debate|critique] [short|standard|long] [focus]\` — two-host podcast, e.g. \`/audio debate short\`.
- \`/report [summary|study-guide|briefing|faq|timeline|analysis|custom <instructions>]\` — grounded markdown documents.
- \`/research <topic>\` — plans searches, reads the web, writes a cited report (imported pages become sources).
AI Studio results are saved as artifacts in the Studio panel (right) — reopen, download, or add them back as sources from there. No arguments = the same defaults as clicking the tool card. Queued AI actions consume tokens when they run.

## Privacy
API keys, sources, chats and artifacts all live in a local database on your machine. No account, no cloud sync. Organizing works offline; only AI calls need a network.`;


export function buildSystemPrompt(sources: Source[], mentioned: MentionItem[] = []): string {
  const constitutions = sources.filter(
    (s) => s.type === "context" && s.content.trim()
  );
  // Mentioned sources move into the priority section — don't include twice.
  const mentionedSourceIds = new Set(
    mentioned.filter((m) => m.group === "source").map((m) => m.id)
  );
  const knowledge = sources.filter(
    (s) =>
      s.type !== "context" &&
      s.content &&
      !s.content.startsWith("data:") &&
      !mentionedSourceIds.has(s.id)
  );

  const parts: string[] = ["You are BrewLM, a thoughtful study assistant."];

  // Constitution: the notebook's governing document. It may override defaults.
  if (constitutions.length > 0) {
    const body = constitutions
      .map((c) =>
        c.content.length > MAX_CONSTITUTION_CHARS
          ? c.content.slice(0, MAX_CONSTITUTION_CHARS) + "\n[…constitution truncated]"
          : c.content
      )
      .join("\n\n");
    parts.push(`# Notebook constitution\n${body}\n\nThe constitution above governs how you behave in this notebook — follow it strictly. Where it conflicts with the default rules below, the constitution wins.`);
  }

  parts.push(`# Default rules\n- Base answers on the user's sources first; say when something isn't covered.\n- Cite sources by title in parentheses, e.g. (Source: Week 4 lecture.pdf).\n- When a message references @Title, the user is pointing at that material — center the answer on it.\n- Write math in LaTeX notation — $...$ or \\(...\\) inline, $$...$$ or \\[...\\] for display equations (integrals, fractions, matrices…). The app renders it; never spell formulas out in plaintext.\n- Visuals the app renders inline when you emit them: fenced svg diagrams, fenced mermaid flowcharts/graphs, and image embeds ![alt](https://image-url). Use them when they'd clarify a concept.\n- Be concise and clear. Use markdown formatting (lists, headers, bold) where it improves readability.`);

  if (mentioned.length > 0) {
    let budget = MAX_MENTION_TOTAL;
    const sections: string[] = [];
    for (const m of mentioned) {
      if (budget <= 0) break;
      const cap = Math.min(MAX_MENTION_CHARS, budget);
      const body = m.text
        ? m.text.length > cap
          ? m.text.slice(0, cap) + "\n[…truncated]"
          : m.text
        : "[No readable text — this is a binary/media file; acknowledge it by title, but don't invent its contents.]";
      sections.push(
        `### @${m.title} (${m.group === "source" ? "Source" : "Output"} · ${m.type})\n${body}`
      );
      budget -= body.length;
    }
    parts.push(
      `# @-mentioned materials — PRIORITY\nThe user pointed at these with @, so focus on them and cite them by title:\n\n${sections.join("\n\n")}`
    );
  }

  if (knowledge.length === 0) {
    if (mentioned.length === 0) {
      parts.push(
        "The user has not added any knowledge sources yet — encourage them to add sources, or answer simple questions generally."
      );
    }
    return parts.join("\n\n");
  }

  let budget = MAX_TOTAL_CONTEXT;
  const sections: string[] = [];
  for (const s of knowledge) {
    if (budget <= 0) break;
    const cap = Math.min(MAX_SOURCE_CHARS, budget);
    const trimmed = s.content.length > cap ? s.content.slice(0, cap) + "\n[…truncated]" : s.content;
    sections.push(`### ${s.title} (${s.type})\n${trimmed}`);
    budget -= trimmed.length;
  }

  parts.push(`# Sources\n${sections.join("\n\n---\n\n")}`);
  return parts.join("\n\n");
}

/** Grow the textarea with its content, up to ~10 lines. */
function autoSize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

/** Detect `@query` at the caret: prefix must be start/whitespace/paren. */
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\n@]{0,80})$/.exec(value.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export default function ChatPanel({
  notebookId,
  chatId,
  notebookTitle,
  notebookFolderId,
  chatTitle,
  sources,
  artifacts,
  settings,
  onOpenSettings,
  onChatActivity,
  onAddFiles,
  onNotebookMoved,
  onNewChat,
  onAddNote,
  onAddLink,
  onClearChat,
  onReturnHome,
  onSettingsChanged,
  onStudioCommand,
  onCloneNotebook,
  onRemove,
  notebookStarred,
  chatBg,
  chatBgDim,
  onChatBgChange,
}: {
  notebookId: string;
  chatId: string | null;
  notebookTitle: string;
  /** "" when the notebook sits at the homepage root. */
  notebookFolderId: string;
  chatTitle: string;
  sources: Source[];
  artifacts: Artifact[];
  settings: Settings;
  onOpenSettings: () => void;
  onChatActivity?: (chatId: string, firstUserText?: string) => void;
  /** Ingest dropped/picked files as notebook sources; returns what was added. */
  onAddFiles: (files: FileList | File[]) => Promise<IngestResult>;
  /** Folder reassignment happened via /move — App refreshes notebook/folder state. */
  onNotebookMoved: () => void;
  /** /new command — NotebookView creates + selects a fresh chat. */
  onNewChat: () => void | Promise<void>;
  /** /note command — NotebookView saves the text as a source; returns it. */
  onAddNote: (text: string) => Promise<Source>;
  /** /url command — NotebookView fetches + saves the page as a link source. */
  onAddLink: (url: string) => Promise<Source>;
  /** /clear command — NotebookView deletes the active chat thread. */
  onClearChat: () => void | Promise<void>;
  /** /return command — NotebookView exits to the homepage. */
  onReturnHome: () => void;
  /** /model command — App reloads the persisted settings object. */
  onSettingsChanged: () => void;
  /** Studio tool commands — StudioPanel's imperative run(); result string for chat. */
  onStudioCommand: (cmd: StudioCommand) => Promise<string>;
  /** /clone command — NotebookView deep-copies the notebook; returns the clone title. */
  onCloneNotebook: (title: string, jump: boolean) => Promise<string>;
  /** /remove command — NotebookView bulk-deletes sources/chats/studio outputs. */
  onRemove: (what: string, filter?: string) => Promise<{ reply: string; chatReplaced?: boolean }>;
  /** Live starred flag so /star can toggle it. */
  notebookStarred: boolean;
  /** Data-URL image behind the chat area ("" = none). */
  chatBg: string;
  /** Readability scrim over chatBg: 0–80 (percent). */
  chatBgDim: number;
  /** Set/clear (bg="") the chat background and/or its dim strength. */
  onChatBgChange: (bg: string, dim: number) => void | Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState<{ query: string; active: number } | null>(null);
  const [moveQuery, setMoveQuery] = useState<{ query: string; active: number } | null>(null);
  const [themeQuery, setThemeQuery] = useState<{ query: string; active: number } | null>(null);
  const [modelQuery, setModelQuery] = useState<{ query: string; active: number } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // Mirror of settings.theme so "/theme" updates the "current" marker instantly.
  const [theme, setTheme] = useState(settings.theme);
  useEffect(() => setTheme(settings.theme), [settings.theme]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [ingesting, setIngesting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  /** Quote for the empty-chat splash — re-rolled whenever a different chat opens. */
  const emptyQuote = useMemo(
    () => CHAT_QUOTES[Math.floor(Math.random() * CHAT_QUOTES.length)],
    [chatId]
  );
  // Chat background popover; dimDraft mirrors chatBgDim for smooth live slider preview.
  const [bgMenuOpen, setBgMenuOpen] = useState(false);
  const [dimDraft, setDimDraft] = useState(chatBgDim);
  useEffect(() => setDimDraft(chatBgDim), [chatBgDim]);
  /** Native file picker → compress → save as chat background (webview <input type=file> is unreliable). */
  const pickChatBg = async () => {
    try {
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
      });
      if (!path) return;
      const data = await readFile(path as string);
      const base = (path as string).split(/[\\/]/).pop() ?? "background";
      const file = new File([data as unknown as BlobPart], base, { type: "image/*" });
      const bg = await fileToCoverDataUrl(file, 1600, 0.8);
      setBgMenuOpen(false);
      await onChatBgChange(bg, dimDraft);
    } catch {
      setError("Couldn't read that image file.");
    }
  };
  const dragDepth = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  /** Append @Title tokens for freshly added sources, then focus the input. */
  const insertMentions = (titles: string[]) => {
    setDraft((prev) => {
      const add = titles
        .filter((t) => !prev.includes(`@${t}`))
        .map((t) => `@${t}`)
        .join(" ");
      if (!add) return prev;
      const next = (prev ? prev.replace(/\s+$/, "") + " " : "") + add + " ";
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          autoSize(ta);
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        }
      });
      return next;
    });
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (ingesting || !chatId || !files.length) return;
    setIngesting(true);
    try {
      const { added, errors } = await onAddFiles(files);
      if (errors.length) setError(errors.join("\n"));
      if (added.length) insertMentions(added.map((s) => s.title));
    } finally {
      setIngesting(false);
    }
  };

  const hasDraggedFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const catalog = useMemo(() => buildMentionCatalog(sources, artifacts), [sources, artifacts]);
  const mentionHits = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    const all = q ? catalog.filter((c) => c.title.toLowerCase().includes(q)) : catalog;
    return all.slice(0, 8);
  }, [mention, catalog]);
  const activeIdx = Math.min(mention?.active ?? 0, Math.max(mentionHits.length - 1, 0));

  const acceptMention = (item: MentionItem) => {
    if (!mention) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    setDraft(draft.slice(0, mention.start) + `@${item.title} ` + draft.slice(caret));
    setMention(null);
    const pos = mention.start + item.title.length + 2;
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoSize(ta);
    });
  };

  /* ---------------------------- / command palette ---------------------------- */

  /** `/`, `/h`, `/mo…` — the user just started a slash command (no space yet). */
  const detectCommand = (value: string): string | null => {
    const m = /^\/([A-Za-z-]{0,20})$/.exec(value);
    return m ? m[1].toLowerCase() : null;
  };

  const cmdHits = useMemo(() => {
    if (cmdQuery === null) return [];
    const q = cmdQuery.query;
    return q ? COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q)) : COMMANDS;
  }, [cmdQuery]);
  const cmdActiveIdx = Math.min(cmdQuery?.active ?? 0, Math.max(cmdHits.length - 1, 0));

  /** Insert the picked command; arg-commands continue into their own flow. */
  const acceptCommand = (c: ChatCommand) => {
    setCmdQuery(null);
    if (c.takesArgs) {
      setDraft(`${c.cmd} `);
      if (c.cmd === "/move") setMoveQuery({ query: "", active: 0 });
      if (c.autocomplete === "theme") setThemeQuery({ query: "", active: 0 });
      if (c.autocomplete === "model") setModelQuery({ query: "", active: 0 });
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autoSize(ta);
      });
    } else {
      void send(c.cmd);
    }
  };

  /* ----------------------------- /model command ----------------------------- */

  // Mirror of settings.model so /model updates the composer footer instantly.
  const [model, setModel] = useState(settings.model);
  useEffect(() => setModel(settings.model), [settings.model]);

  /** `/model`, `/model gpt-4o` at the start of the draft. */
  const detectModel = (value: string): string | null => {
    const m = /^\/model(?:\s+("?)([^\n"]*)\1?)?$/i.exec(value.trim());
    if (!m) return null;
    return m[2] ?? "";
  };

  const modelHits = useMemo(() => {
    if (modelQuery === null) return [];
    const q = modelQuery.query.trim().toLowerCase();
    const hits = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
    return hits.slice(0, 8);
  }, [modelQuery, models]);
  const modelActiveIdx = Math.min(modelQuery?.active ?? 0, Math.max(modelHits.length - 1, 0));

  useEffect(() => {
    if (modelQuery !== null) void loadModelList(settings.provider).then(setModels);
  }, [modelQuery, settings.provider]);

  const acceptModel = (id: string) => {
    setDraft(`/model "${id}" `);
    setModelQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
    });
  };

  /** Execute /model locally (no LLM) — swap the model and persist it. */
  const runModelCommand = async (text: string): Promise<void> => {
    const m = /^\/model(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
    const raw = (m?.[2] ?? "").trim();
    let reply: string;
    if (!raw) {
      const list = await loadModelList(settings.provider);
      reply = `Current model: \`${model}\`. Your ${settings.provider} models: ${list.map((x) => `\`${x}\``).join(", ")}.`;
    } else {
      await setSetting("model", raw);
      setModel(raw);
      // A genuinely new id also joins the editable Settings list.
      const list = await loadModelList(settings.provider);
      if (!list.includes(raw)) {
        const next = [...list, raw];
        await saveModelList(settings.provider, next);
        setModels(next);
      }
      onSettingsChanged();
      reply = `Model set to \`${raw}\`.`;
    }
    const replyMsg = await addMessage(chatId as string, notebookId, "assistant", reply);
    setMsgs((prev) => [...prev, replyMsg]);
  };

  /* ----------------------------- /theme command ----------------------------- */

  /** `/theme`, `/theme wine` at the start of the draft. */
  const detectTheme = (value: string): string | null => {
    const m = /^\/theme(?:\s+("?)([^\n"]*)\1?)?$/i.exec(value.trim());
    if (!m) return null;
    return m[2] ?? "";
  };

  const themeHits = useMemo(() => {
    if (themeQuery === null) return [];
    const q = themeQuery.query.trim().toLowerCase();
    const hits = q ? THEMES.filter((t) => t.name.toLowerCase().includes(q)) : THEMES;
    return hits.slice(0, 8);
  }, [themeQuery]);
  const themeActiveIdx = Math.min(themeQuery?.active ?? 0, Math.max(themeHits.length - 1, 0));

  const acceptTheme = (name: string) => {
    setDraft(`/theme "${name}" `);
    setThemeQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
    });
  };

  /** Execute /theme locally (no LLM). Returns true when `text` was a command. */
  const runThemeCommand = async (text: string): Promise<boolean> => {
    const m = /^\/theme(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
    if (!m) return false;
    const raw = (m[2] ?? "").trim();
    let reply: string;
    if (!raw) {
      reply = `Current theme: **${THEMES.find((t) => t.id === theme)?.name ?? theme}**. Pick one: ${THEMES.map((t) => `\`/theme ${t.name}\``).join(" · ")}`;
    } else {
      const hit = THEMES.find(
        (t) => t.name.toLowerCase() === raw.toLowerCase() || t.id === raw.toLowerCase()
      );
      if (hit) {
        await chooseTheme(hit.id);
        setTheme(hit.id);
        reply = `Theme set to **${hit.name}** — ${hit.blurb}.`;
      } else {
        reply = `No theme named “${raw}”. Available: ${THEMES.map((t) => t.name).join(", ")}.`;
      }
    }
    const replyMsg = await addMessage(chatId as string, notebookId, "assistant", reply);
    setMsgs((prev) => [...prev, replyMsg]);
    return true;
  };

  /* ------------------------------ /move command ------------------------------ */

  /** `/move`, `/move math`, `/move "Math Courses"` at the start of the draft. */
  const detectMove = (value: string): string | null => {
    const m = /^\/move(?:\s+("?)([^\n"]*)\1?)?$/i.exec(value.trim());
    if (!m) return null;
    return m[2] ?? "";
  };

  /** Folders matching the /move query; a Root row rides on top when applicable. */
  const moveHits = useMemo(() => {
    if (moveQuery === null) return [];
    const q = moveQuery.query.trim().toLowerCase();
    const hits = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;
    return hits.slice(0, 8);
  }, [moveQuery, folders]);
  const moveActiveIdx = Math.min(moveQuery?.active ?? 0, Math.max(moveHits.length - 1, 0));
  const showRootMove =
    moveQuery !== null &&
    notebookFolderId !== "" &&
    (!moveQuery.query.trim() || "notebooks".startsWith(moveQuery.query.trim().toLowerCase()));

  useEffect(() => {
    if (moveQuery !== null) void listFolders().then(setFolders);
  }, [moveQuery]);

  const acceptMove = (name: string) => {
    setDraft(`/move "${name}" `);
    setMoveQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
    });
  };

  /**
   * Execute the /move command locally (no LLM round-trip) and report the
   * outcome as an assistant message. Returns true when `text` was a command.
   */
  const runMoveCommand = async (text: string): Promise<boolean> => {
    const m = /^\/move(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
    if (!m) return false;
    const raw = (m[2] ?? "").trim();
    let reply: string;
    if (!raw || /^(out|root|home|notebooks)$/i.test(raw)) {
      if (!notebookFolderId) {
        reply = `“${notebookTitle}” isn't in any folder — nothing to move.`;
      } else {
        await moveNotebookToFolder(notebookId, "");
        onNotebookMoved();
        reply = `📁 Moved “${notebookTitle}” out of its folder to Notebooks.`;
      }
    } else {
      const hit = await findFolderByName(raw);
      if (hit.status === "found") {
        if (hit.folder.id === notebookFolderId) {
          reply = `“${notebookTitle}” is already in “${hit.folder.name}”.`;
        } else {
          await moveNotebookToFolder(notebookId, hit.folder.id);
          onNotebookMoved();
          reply = `📁 Moved “${notebookTitle}” to folder “${hit.folder.name}”.`;
        }
      } else if (hit.status === "ambiguous") {
        reply = `“${raw}” matches several folders: ${hit.matches.map((f) => f.name).join(", ")}. Be a little more specific.`;
      } else {
        const all = await listFolders();
        reply = all.length
          ? `No folder named “${raw}”. Your folders: ${all.map((f) => f.name).join(", ")}.`
          : `No folder named “${raw}” — there are no folders yet. Create one from the homepage with “New folder”.`;
      }
    }
    const replyMsg = await addMessage(chatId as string, notebookId, "assistant", reply);
    setMsgs((prev) => [...prev, replyMsg]);
    return true;
  };

  useEffect(() => {
    if (!chatId) {
      setMsgs([]);
      return;
    }
    let cancelled = false;
    import("../lib/db").then(({ listMessages }) =>
      // setMsgs matters, not setMessages: messagesRef must follow the switch,
      // or the next send resurrects the previous chat's history.
      listMessages(chatId).then((ms) => {
        if (!cancelled) setMsgs(ms);
      })
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /* ------------------------------ /queue state ------------------------------ */

  /** FIFO of queued prompts/commands. Ref mirrors state for drain loops. */
  const queueRef = useRef<string[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  /** Mirrors `streaming` state synchronously so chained sends aren't blocked by a stale closure. */
  const streamingRef = useRef(false);
  const drainingRef = useRef(false);
  /** Controller for the in-flight LLM stream; the stop button aborts it. */
  const abortRef = useRef<AbortController | null>(null);
  /** Latest messages — drainQueue needs fresh history, not the stale render closure. */
  const messagesRef = useRef<ChatMessage[]>([]);

  /** Update messages state AND the ref atomically (value or updater form). */
  const setMsgs = (
    next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
  ) => {
    messagesRef.current =
      typeof next === "function" ? next(messagesRef.current) : next;
    setMessages(messagesRef.current);
  };

  /** Strip one pair of matching outer quotes: /queue "…" / /rename "…". */
  const stripOuterQuotes = (s: string): string => {
    if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === '"' && s.endsWith('"')))) {
      return s.slice(1, -1).trim();
    }
    return s;
  };

  const removeFromQueue = (i: number) => {
    queueRef.current.splice(i, 1);
    setQueue([...queueRef.current]);
  };

  const clearQueue = () => {
    queueRef.current = [];
    setQueue([]);
  };

  // The queue is per-chat: switching threads drops pending items.
  useEffect(() => {
    queueRef.current = [];
    setQueue([]);
  }, [chatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Render ```mermaid diagrams once streaming settles (mid-stream they stay code).
  useEffect(() => {
    if (streaming === null) void hydrateMermaid(scrollRef.current);
  }, [streaming, messages]);

  const keyed = activeKey(settings);

  /**
   * Send one payload end-to-end (command or chat message). The /queue drain
   * loop calls this in sequence; `streamingRef` mirrors the LLM busy state
   * synchronously so a chained runSend never hits a stale-closure block.
   */
  const runSend = async (text: string): Promise<void> => {
    if (!text || streamingRef.current || !chatId) return;
    setError(null);
    // First "real" user message = first that isn't a /queue command — lets a
    // queued payload (not the "/queue …" wrapper) auto-title a fresh chat.
    const isFirst = !messagesRef.current.some(
      (m) => m.role === "user" && !/^\/queue(\s|$)/i.test(m.content)
    );

    const userMsg = await addMessage(chatId, notebookId, "user", text);
    const history = [...messagesRef.current, userMsg];
    setMsgs(history);

    // /help is a local app command — post the guide, no LLM call.
    if (/^\/help(\s|$)/i.test(text)) {
      const replyMsg = await addMessage(chatId, notebookId, "assistant", HELP_TEXT);
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /move is a local app command — file the notebook, no LLM call.
    if (/^\/move(\s|$)/i.test(text)) {
      await runMoveCommand(text);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /theme is a local app command — switch the palette, no LLM call.
    if (/^\/theme(\s|$)/i.test(text)) {
      await runThemeCommand(text);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /new — save this chat and start a fresh one.
    if (/^\/new(\s|$)/i.test(text)) {
      const replyMsg = await addMessage(
        chatId,
        notebookId,
        "assistant",
        "Started a fresh chat. This conversation is saved in the Chats panel on the left."
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId);
      await onNewChat();
      return;
    }

    // /clone "<title>" [yes|no] — deep-copy this notebook; yes jumps to the copy.
    // The title MUST be in quotes, so a yes/no inside the title can't masquerade
    // as the jump flag (e.g. /clone "Project yes" no → title "Project yes", stays).
    if (/^\/clone(\s|$)/i.test(text)) {
      const rest = text.replace(/^\/clone\s*/i, "").trim();
      const m = /^"([^"]+)"(?:\s+(yes|no))?$/i.exec(rest);
      let reply: string;
      if (!m) {
        reply =
          `Wrap the copy's title in quotes, like \`/clone "My copy"\` — add \`yes\` after the quotes if you want me to take you to it. ` +
          `Quoting matters: in \`/clone "Project yes" no\`, "yes" belongs to the title and "no" is the flag.`;
      } else {
        const title = m[1].slice(0, 80);
        const jump = (m[2] ?? "").toLowerCase() === "yes";
        try {
          const name = await onCloneNotebook(title, jump);
          reply = jump
            ? `Cloned "${notebookTitle}" as "${name}" — everything came along: sources, chats, and studio work. Taking you there.`
            : `Cloned "${notebookTitle}" as "${name}" — sources, chats, and studio work all included. You'll find it on the homepage.`;
        } catch {
          reply = "Couldn't clone this notebook — please try again.";
        }
      }
      const replyMsg = await addMessage(chatId, notebookId, "assistant", reply);
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /remove <sources|chats|studios> [type] — bulk delete notebook data.
    if (/^\/remove(\s|$)/i.test(text)) {
      const tokens = text.replace(/^\/remove\s*/i, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const what = tokens[0] ?? "";
      const filter = tokens[1];
      const scope =
        what === "sources" || what === "source"
          ? "sources"
          : what === "chats" || what === "chat"
            ? "chats"
            : what === "studios" || what === "studio" || what === "outputs"
              ? "studios"
              : null;
      const result = scope
        ? await onRemove(scope, filter)
        : { reply: "Try `/remove sources`, `/remove chats`, or `/remove studios` — optionally with a type, e.g. `/remove sources links` or `/remove studios audios`." };
      // /remove chats deletes this thread; NotebookView posts into the fresh one.
      if (!result.chatReplaced) {
        const replyMsg = await addMessage(chatId, notebookId, "assistant", result.reply);
        setMsgs((prev) => [...prev, replyMsg]);
        onChatActivity?.(chatId, isFirst ? text : undefined);
      }
      textareaRef.current?.focus();
      return;
    }

    // /note — paste text straight into the Sources panel.
    if (/^\/note(\s|$)/i.test(text)) {
      const body = text.replace(/^\/note\s*/i, "").trim();
      if (!body) {
        const replyMsg = await addMessage(
          chatId,
          notebookId,
          "assistant",
          "Paste your note right after the command, e.g. `/note today's lecture covered…`"
        );
        setMsgs((prev) => [...prev, replyMsg]);
      } else {
        const src = await onAddNote(body);
        const replyMsg = await addMessage(
          chatId,
          notebookId,
          "assistant",
          `Saved “${src.title}” as a source — it's in the Sources panel on the left, and the AI can now ground answers in it.`
        );
        setMsgs((prev) => [...prev, replyMsg]);
        insertMentions([src.title]);
        onChatActivity?.(chatId, isFirst ? `Note: ${src.title}` : undefined);
        textareaRef.current?.focus();
        return;
      }
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /rename <title> — rename this chat thread.
    if (/^\/rename(\s|$)/i.test(text)) {
      const raw = stripOuterQuotes(text.replace(/^\/rename\s*/i, "").trim());
      let reply: string;
      if (!raw) {
        reply = `Give me the new title, e.g. \`/rename "Chat About Mathematic Notes"\`.`;
      } else {
        const title = raw.slice(0, 80);
        await renameChat(chatId, title);
        // touchChat refreshes ChatsPanel + header; no-op otherwise.
        onChatActivity?.(chatId);
        reply = `Renamed this chat to “${title}”.`;
      }
      const replyMsg = await addMessage(chatId, notebookId, "assistant", reply);
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /model is a local app command — swap the model, no LLM call.
    if (/^\/model(\s|$)/i.test(text)) {
      await runModelCommand(text);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /star — toggle the notebook's star (pinned order on the homepage).
    if (/^\/star(\s|$)/i.test(text)) {
      await setNotebookStarred(notebookId, !notebookStarred);
      onNotebookMoved();
      const replyMsg = await addMessage(
        chatId,
        notebookId,
        "assistant",
        notebookStarred
          ? `Un-starred “${notebookTitle}”.`
          : `Starred “${notebookTitle}” — it's pinned near the top of the homepage.`
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /clear — delete this thread entirely (unlike /new, which saves it).
    if (/^\/clear(\s|$)/i.test(text)) {
      await onClearChat();
      return;
    }

    // /return — exit to the homepage; the chat stays saved in the Chats panel.
    if (/^\/return(\s|$)/i.test(text)) {
      abortRef.current?.abort(); // stop any in-flight generation on the way out
      onReturnHome();
      return;
    }

    // /url <link> — fetch a webpage into the Sources panel.
    if (/^\/url(\s|$)/i.test(text)) {
      const raw = text.replace(/^\/url\s*/i, "").trim();
      let reply: string | null = null;
      if (!raw) {
        reply = "Give me a link to add, e.g. `/url https://en.wikipedia.org/wiki/Photosynthesis`";
      } else if (!/^https?:\/\//i.test(raw)) {
        reply = "Links need to start with http:// or https:// — try again with the full URL.";
      } else {
        try {
          const src = await onAddLink(raw);
          const replyMsg = await addMessage(
            chatId,
            notebookId,
            "assistant",
            `Saved “${src.title}” as a source — it's in the Sources panel on the left, and the AI can now ground answers in it.`
          );
          setMsgs((prev) => [...prev, replyMsg]);
          insertMentions([src.title]);
          onChatActivity?.(chatId, isFirst ? `Link: ${src.title}` : undefined);
          textareaRef.current?.focus();
          return;
        } catch (e) {
          reply = `Couldn't fetch that link: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const replyMsg = await addMessage(chatId, notebookId, "assistant", reply);
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // Studio tool commands — run in the Studio panel, confirm here.
    const studioMatch = /^\/(flashcards|quiz|mindmap|audio|report|research)(\s|$)/i.exec(text);
    if (studioMatch) {
      const parsed = parseStudioCommand(text);
      if (typeof parsed === "string") {
        const replyMsg = await addMessage(chatId, notebookId, "assistant", parsed);
        setMsgs((prev) => [...prev, replyMsg]);
      } else {
        const notice = await addMessage(chatId, notebookId, "assistant", parsed.notice);
        setMsgs((prev) => [...prev, notice]);
        const result = await onStudioCommand(parsed.cmd);
        const doneMsg = await addMessage(chatId, notebookId, "assistant", result);
        setMsgs((prev) => [...prev, doneMsg]);
      }
      onChatActivity?.(
        chatId,
        isFirst ? (typeof parsed === "string" ? text : parsed.title) : undefined
      );
      textareaRef.current?.focus();
      return;
    }

    // /summarize — LLM call, but with a dedicated notebook-wide prompt.
    const isSummarize = /^\/summarize(\s|$)/i.test(text);

    streamingRef.current = true;
    setStreaming("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Mentions from recent user turns keep their priority across follow-ups.
    const mentioned = resolveMentions(
      history
        .filter((m) => m.role === "user")
        .slice(-8)
        .map((m) => m.content)
        .join("\n"),
      catalog
    );
    const llmMessages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(sources, mentioned) },
      ...history.slice(-HISTORY_LIMIT).map((m, i, arr) => ({
        role: m.role,
        // The visible bubble says "/summarize"; the model gets the real prompt.
        content:
          isSummarize && i === arr.length - 1 && m.role === "user"
            ? `Write a clear, well-structured summary of this whole notebook: the core ideas, why they matter, and the key details worth remembering. Cover every source.`
            : m.content,
      })),
    ];

    let acc = "";
    try {
      for await (const delta of streamChat({
        provider: settings.provider,
        apiKey: keyed,
        model: settings.model,
        messages: llmMessages,
        signal: ctrl.signal,
      })) {
        acc += delta;
        setStreaming(acc);
      }
      // Cancelled right at the tail? Discard rather than save a cut-off answer.
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const assistantMsg = await addMessage(chatId, notebookId, "assistant", acc || "(no response)");
      setMsgs((prev) => [...prev, assistantMsg]);
    } catch (e) {
      if (!(isAbortError(e) || ctrl.signal.aborted)) {
        setError(e instanceof Error ? e.message : String(e));
        if (acc) {
          const assistantMsg = await addMessage(chatId, notebookId, "assistant", acc);
          setMsgs((prev) => [...prev, assistantMsg]);
        }
      }
      // aborted → discard the partial answer entirely (user pressed stop)
    } finally {
      abortRef.current = null;
      streamingRef.current = false;
      setStreaming(null);
      textareaRef.current?.focus();
    }
    onChatActivity?.(chatId, isFirst ? (isSummarize ? "Notebook summary" : text) : undefined);
  };

  /** Drain the FIFO queue — one payload at a time, continuing after LLM streams. */
  const drainQueue = async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0 && !streamingRef.current) {
        const next = queueRef.current.shift()!;
        setQueue([...queueRef.current]);
        // runSend resets streamingRef synchronously when an LLM stream starts,
        // so the loop naturally waits for it before the next item.
        await runSend(next);
      }
    } finally {
      drainingRef.current = false;
    }
  };

  /** Stop the in-flight LLM generation; the partial answer is discarded. */
  const stopGenerating = () => {
    abortRef.current?.abort();
  };

  /** Composer entry: /queue enqueues while busy, everything else sends (then drains). */
  const send = async (direct?: string) => {
    const text = (direct ?? draft).trim();
    if (!text || !chatId) return;

    const queueMatch = /^\/queue\s*([\s\S]*)$/i.exec(text);
    if (queueMatch) {
      setMention(null);
      setCmdQuery(null);
      setMoveQuery(null);
      setThemeQuery(null);
      setModelQuery(null);
      setDraft("");
      const payload = stripOuterQuotes(queueMatch[1].trim());
      if (!payload) {
        const replyMsg = await addMessage(
          chatId,
          notebookId,
          "assistant",
          "Queue what? e.g. `/queue /summarize`, `/queue /url <link>`, or `/queue \"Explain Bayes' theorem\"`."
        );
        setMsgs((prev) => [...prev, replyMsg]);
        textareaRef.current?.focus();
        return;
      }
      queueRef.current.push(payload);
      setQueue([...queueRef.current]);
      const pos = queueRef.current.length;
      const replyMsg = await addMessage(
        chatId,
        notebookId,
        "assistant",
        `Queued **${payload.length > 60 ? payload.slice(0, 60).trimEnd() + "…" : payload}** (position ${pos}).${streamingRef.current ? " I'll run it when the current task finishes." : ""}`
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, messagesRef.current.length === 0 ? "Queued work" : undefined);
      textareaRef.current?.focus();
      void drainQueue();
      return;
    }

    if (streaming !== null) return;
    setError(null);
    setDraft("");
    setMention(null);
    setCmdQuery(null);
    setMoveQuery(null);
    setThemeQuery(null);
    setModelQuery(null);
    // modelQuery cleared above
    await runSend(text);
    void drainQueue();
  };
  return (
    <section
      className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas"
      onDragEnter={(e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (hasDraggedFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!hasDraggedFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      {/* chat background: object-cover re-crops on any zoom/resize; scrim keeps text legible */}
      {chatBg && (
        <div className="absolute inset-0" aria-hidden>
          <img src={chatBg} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-canvas" style={{ opacity: dimDraft / 100 }} />
        </div>
      )}
      {/* drop overlay */}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 m-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-canvas/80">
          <Upload size={22} strokeWidth={1.8} className="text-ink-2" />
          <p className="text-[13.5px] font-medium text-ink-2">
            Drop files to add as sources &amp; @mention them
          </p>
        </div>
      )}
      {/* header (z-20: above the chat surface so its popover menus stay clickable) */}
      <div className="relative z-20 flex h-11 shrink-0 items-center justify-between border-b border-edge-soft bg-panel px-4">
        <span className="truncate text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Chat{chatTitle ? ` · ${chatTitle}` : ""}
        </span>
        <div className="flex items-center gap-1">
          {!keyed && (
            <button
              onClick={onOpenSettings}
              className="mr-1 flex items-center gap-1.5 rounded-full border border-warn-edge bg-warn-bg px-2.5 py-1 text-[11.5px] font-medium text-warn transition-colors hover:opacity-80"
            >
              <Settings2 size={11} /> Add API key
            </button>
          )}
          <IconButton
            onClick={async () => {
              if (!chatId) return;
              await clearMessages(chatId);
              setMsgs([]);
            }}
            label="Clear chat"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </IconButton>
          {/* chat background */}
          <div className="relative">
            <IconButton
              onClick={() => {
                // No image yet: one click goes straight to the file picker.
                // With an image: open the menu (replace / dim / remove).
                if (chatBg) setBgMenuOpen((v) => !v);
                else void pickChatBg();
              }}
              label="Chat background"
            >
              <Image size={14} strokeWidth={1.8} />
            </IconButton>
            {bgMenuOpen && (
              <>
                <div className="fixed inset-0 z-10 cursor-default" onClick={() => setBgMenuOpen(false)} />
                <div className="anim-fade-up absolute right-0 z-20 mt-1.5 w-64 rounded-xl border border-edge bg-panel p-3 shadow-lg">
                  <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                    Chat background
                  </p>
                  {chatBg && (
                    <img
                      src={chatBg}
                      alt=""
                      className="mb-2.5 h-20 w-full rounded-lg border border-edge-soft object-cover"
                    />
                  )}
                  <button
                    onClick={() => void pickChatBg()}
                    className="flex w-full items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-85"
                  >
                    <Upload size={13} strokeWidth={2} />
                    Replace image
                  </button>
                  {chatBg && (
                    <>
                      <div className="mt-3 flex items-center justify-between text-[11.5px] text-ink-2">
                        <span>Dim</span>
                        <span className="text-ink-3">{dimDraft}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={80}
                        value={dimDraft}
                        onChange={(e) => setDimDraft(Number(e.target.value))}
                        onMouseUp={() => onChatBgChange(chatBg, dimDraft)}
                        onTouchEnd={() => onChatBgChange(chatBg, dimDraft)}
                        onKeyUp={() => onChatBgChange(chatBg, dimDraft)}
                        className="mt-1 w-full accent-accent"
                      />
                      <button
                        onClick={async () => {
                          setDimDraft(55);
                          await onChatBgChange("", 55);
                        }}
                        className="mt-2 flex w-full items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover"
                      >
                        <Trash2 size={13} strokeWidth={2} />
                        Remove background
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto">
        {messages.length === 0 && streaming === null ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent">
              <BrewIcon size={18} strokeWidth={1.8} onAccent className="text-accent-ink" />
            </div>
            <p className="max-w-md text-[15px] font-medium italic leading-relaxed text-ink-2">
              {`“${emptyQuote.text}”`}
            </p>
            <p className="mt-2 text-[12px] tracking-wide text-ink-3">
              — {emptyQuote.author}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-5 py-6">
            {messages.map((m) => (
              <Bubble key={m.id} role={m.role} content={m.content} items={catalog} />
            ))}
            {streaming !== null && (
              <div className="anim-fade-up mb-5 flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed">
                  {streaming ? (
                    <div
                      className="md"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(streaming) }}
                    />
                  ) : (
                    <BrewingStatus />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="relative z-10 shrink-0 border-t border-danger-edge bg-danger-bg px-5 py-2.5 text-[12px] leading-snug text-danger">
          {error}
        </div>
      )}

      {/* input */}
      <div className="relative z-10 shrink-0 px-5 pb-5 pt-2">
        {/* queue bar (in flow, above the composer; autocomplete popups layer above it) */}
        {queue.length > 0 && (
          <div className="mx-auto mb-2 max-w-2xl overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
            <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-1.5">
              <ListPlus size={12} strokeWidth={1.8} className="shrink-0 text-ink-3" />
              <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                Queue · {queue.length}
              </span>
              <button
                onClick={clearQueue}
                className="text-[10.5px] font-medium text-ink-3 transition-colors hover:text-danger"
              >
                Clear all
              </button>
            </div>
            <div className="max-h-28 overflow-y-auto py-1">
              {queue.map((q, i) => (
                <div key={`${i}-${q}`} className="group flex w-full items-center gap-2.5 px-3 py-1.5">
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{q}</span>
                  <button
                    onClick={() => removeFromQueue(i)}
                    title="Remove from queue"
                    className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
            <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
              Runs in order when the current task finishes · cleared if you switch chats
            </p>
          </div>
        )}
        <div className="relative mx-auto max-w-2xl">
          {/* / command palette */}
          {cmdQuery !== null && cmdHits.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {cmdHits.map((c, i) => {
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.cmd}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptCommand(c);
                      }}
                      onMouseEnter={() => setCmdQuery((q) => (q ? { ...q, active: i } : q))}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                        i === cmdActiveIdx ? "bg-hover" : ""
                      }`}
                    >
                      <Icon size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                      <span className="shrink-0 font-mono text-[12.5px] font-semibold">{c.usage}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{c.desc}</span>
                    </button>
                  );
                })}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to pick · Esc to dismiss · /help for the full guide
              </p>
            </div>
          )}
          {/* /model suggestions */}
          {modelQuery !== null && modelHits.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {modelHits.map((m, i) => (
                  <button
                    key={m}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptModel(m);
                    }}
                    onMouseEnter={() => setModelQuery((q) => (q ? { ...q, active: i } : q))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      i === modelActiveIdx ? "bg-hover" : ""
                    }`}
                  >
                    <Settings2 size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{m}</span>
                    {model === m && (
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                        current
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to pick · Esc to dismiss · a new id is added to your list
              </p>
            </div>
          )}
          {/* /theme suggestions */}
          {themeQuery !== null && themeHits.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {themeHits.map((t, i) => (
                  <button
                    key={t.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptTheme(t.name);
                    }}
                    onMouseEnter={() => setThemeQuery((q) => (q ? { ...q, active: i } : q))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      i === themeActiveIdx ? "bg-hover" : ""
                    }`}
                  >
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full border border-edge"
                      style={{ background: t.swatch.accent }}
                    />
                    <span className="shrink-0 text-[13px] font-medium">{t.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{t.blurb}</span>
                    {theme === t.id && (
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                        current
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to pick · Esc to dismiss
              </p>
            </div>
          )}
          {/* /move folder suggestions */}
          {moveQuery !== null && (moveHits.length > 0 || showRootMove) && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {showRootMove && (
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setDraft("/move out");
                      setMoveQuery(null);
                      textareaRef.current?.focus();
                    }}
                    onMouseEnter={() => setMoveQuery((m) => (m ? { ...m, active: 0 } : m))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      moveActiveIdx === 0 ? "bg-hover" : ""
                    }`}
                  >
                    <ArrowUpFromLine size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      Out of folder (back to Notebooks)
                    </span>
                  </button>
                )}
                {moveHits.map((f, i) => {
                  const idx = showRootMove ? i + 1 : i;
                  return (
                    <button
                      key={f.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptMove(f.name);
                      }}
                      onMouseEnter={() => setMoveQuery((m) => (m ? { ...m, active: idx } : m))}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                        idx === moveActiveIdx ? "bg-hover" : ""
                      }`}
                    >
                      <FolderClosed size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                        folder
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to pick · Esc to dismiss · /move out to un-file
              </p>
            </div>
          )}
          {/* @-mention suggestions */}
          {mention && mentionHits.length > 0 && (            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {mentionHits.map((item, i) => (
                  <button
                    key={item.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(item);
                    }}
                    onMouseEnter={() => setMention((m) => (m ? { ...m, active: i } : m))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      i === activeIdx ? "bg-hover" : ""
                    }`}
                  >
                    {item.group === "source" ? (
                      <FileText size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    ) : (
                      <Sparkles size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                      {item.type}
                    </span>
                  </button>
                ))}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to insert · Esc to dismiss
              </p>
            </div>
          )}
          <div
            className={`flex items-end gap-2 rounded-2xl border bg-panel p-2 pl-2 shadow-sm transition-colors ${
              streaming !== null ? "border-edge-soft" : "border-edge focus-within:border-ink-3"
            }`}
          >
            <input
              ref={attachInputRef}
              type="file"
              multiple
              accept={ACCEPT_STRING}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => attachInputRef.current?.click()}
              disabled={ingesting}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
              aria-label="Add file to chat"
              title="Add file (also @mentions it)"
            >
              {ingesting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={16} strokeWidth={2} />}
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                autoSize(e.target);
                const mv = detectMove(e.target.value);
                const cmd = mv === null ? detectCommand(e.target.value) : null;
                const th = mv === null && cmd === null ? detectTheme(e.target.value) : null;
                const md = mv === null && cmd === null && th === null ? detectModel(e.target.value) : null;
                setCmdQuery(null);
                setMoveQuery(null);
                setThemeQuery(null);
                setModelQuery(null);
                if (cmd !== null) {
                  setCmdQuery({ query: cmd, active: 0 });
                  setMention(null);
                  return;
                }
                if (mv !== null) {
                  setMoveQuery({ query: mv, active: 0 });
                  setMention(null);
                } else if (th !== null) {
                  setThemeQuery({ query: th, active: 0 });
                  setMention(null);
                } else if (md !== null) {
                  setModelQuery({ query: md, active: 0 });
                  setMention(null);
                } else {
                  const hit = detectMention(e.target.value, e.target.selectionStart);
                  setMention(hit ? { ...hit, active: 0 } : null);
                }
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                setMention((prev) => {
                  const hit = detectMention(el.value, el.selectionStart);
                  if (!hit) return null;
                  return { ...hit, active: prev && prev.query === hit.query ? prev.active : 0 };
                });
              }}
              onKeyDown={(e) => {
                if (cmdQuery !== null && cmdHits.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCmdQuery((q) => q && { ...q, active: (Math.min(q.active, cmdHits.length - 1) + 1) % cmdHits.length });
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdQuery((q) => q && { ...q, active: (Math.min(q.active, cmdHits.length - 1) - 1 + cmdHits.length) % cmdHits.length });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptCommand(cmdHits[cmdActiveIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCmdQuery(null);
                    return;
                  }
                }
                if (themeQuery !== null) {
                  const count = themeHits.length;
                  if (e.key === "ArrowDown" && count > 0) {
                    e.preventDefault();
                    setThemeQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) + 1) % count });
                    return;
                  }
                  if (e.key === "ArrowUp" && count > 0) {
                    e.preventDefault();
                    setThemeQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) - 1 + count) % count });
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && count > 0) {
                    e.preventDefault();
                    acceptTheme(themeHits[themeActiveIdx].name);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setThemeQuery(null);
                    return;
                  }
                }
                if (modelQuery !== null) {
                  const count = modelHits.length;
                  if (e.key === "ArrowDown" && count > 0) {
                    e.preventDefault();
                    setModelQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) + 1) % count });
                    return;
                  }
                  if (e.key === "ArrowUp" && count > 0) {
                    e.preventDefault();
                    setModelQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) - 1 + count) % count });
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && count > 0) {
                    e.preventDefault();
                    acceptModel(modelHits[modelActiveIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setModelQuery(null);
                    return;
                  }
                }
                if (moveQuery !== null) {
                  const count = moveHits.length + (showRootMove ? 1 : 0);
                  if (e.key === "ArrowDown" && count > 0) {
                    e.preventDefault();
                    setMoveQuery((m) => m && { ...m, active: (Math.min(m.active, count - 1) + 1) % count });
                    return;
                  }
                  if (e.key === "ArrowUp" && count > 0) {
                    e.preventDefault();
                    setMoveQuery((m) => m && { ...m, active: (Math.min(m.active, count - 1) - 1 + count) % count });
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && count > 0) {
                    e.preventDefault();
                    if (showRootMove && moveActiveIdx === 0) {
                      setDraft("/move out");
                      setMoveQuery(null);
                      textareaRef.current?.focus();
                    } else {
                      acceptMove(moveHits[showRootMove ? moveActiveIdx - 1 : moveActiveIdx].name);
                    }
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMoveQuery(null);
                    return;
                  }
                }
                if (mention && mentionHits.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMention((m) => m && { ...m, active: (activeIdx + 1) % mentionHits.length });
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMention((m) => m && { ...m, active: (activeIdx - 1 + mentionHits.length) % mentionHits.length });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptMention(mentionHits[activeIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={
                sources.length > 0
                  ? "Ask about your sources… (@ to reference · / for commands)"
                  : "Ask anything… (type / for commands)"
              }
              className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none placeholder:text-ink-3"
            />
            <button
              onClick={() => (streaming !== null ? stopGenerating() : send())}
              disabled={streaming === null && !draft.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-85 disabled:opacity-25"
              aria-label={streaming !== null ? "Stop generating" : "Send message"}
              title={streaming !== null ? "Stop generating" : "Send"}
            >
              {streaming !== null ? (
                <Square size={12} strokeWidth={2.4} fill="currentColor" />
              ) : (
                <ArrowUp size={16} strokeWidth={2.2} />
              )}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-ink-3">
            {model} · via {settings.provider === "openrouter" ? "OpenRouter" : settings.provider}
          </p>
        </div>
      </div>
    </section>
  );
}

function Bubble({
  role,
  content,
  items,
}: {
  role: "user" | "assistant";
  content: string;
  items: MentionItem[];
}) {
  const segments = useMemo(
    () => (role === "user" ? segmentMentions(content, items) : []),
    [role, content, items]
  );
  if (role === "user") {
    return (
      <div className="anim-fade-up mb-5 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-accent-ink">
          {segments.map((seg, i) =>
            seg.item ? (
              <span
                key={i}
                title={`${seg.item.group === "source" ? "Source" : "Output"} · ${seg.item.type}`}
                className="rounded-md border border-accent-ink/25 bg-accent-ink/10 px-1 py-px text-[12.5px] font-medium"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="anim-fade-up mb-5 flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed">
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      </div>
    </div>
  );
}
