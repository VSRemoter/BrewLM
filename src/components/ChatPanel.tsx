import {
  AlignLeft,
  Anchor,
  ArrowUp,
  ArrowLeftRight,
  ArrowUpFromLine,
  AudioLines,
  BookOpen,
  Check,
  Copy,
  FilePlus2,
  FileText,
  FolderClosed,
  GraduationCap,
  Image,
  ImagePlus,
  Info,
  Layers,
  Link,
  ListPlus,
  Loader2,
  MessageSquarePlus,
  Network,
  Palette,
  Type,
  Pencil,
  Plus,
  Search,
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
  findFolderByName,
  getImage,
  listFolders,
  moveNotebookToFolder,
  renameChat,
  setNotebookGrounded,
  setNotebookStarred,
  setSetting,
  sourceText,
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
import { isAbortError, streamChat, type LlmMessage, type StreamUsage } from "../lib/llm";
import { CLOUD_BUDGET, contextBudget, type ContextBudget } from "../lib/local";
import {
  imageAlt,
  imageIdsIn,
  imageRef,
  libraryImageAsReference,
  libraryImageUrl,
  saveImageToLibrary,
  storeGeneratedImages,
  stripHistoryImages,
  unresolvedImageIds,
  withLibraryImages,
} from "../lib/genImage";
import {
  editCapableModels,
  generateImages,
  isImageApiModel,
  maxImagesPerRequest,
  maxInputReferences,
  supportedAspectRatios,
} from "../lib/imageApi";
import { ensureIndexed, isRetrievable, rankChunks, type RetrievedChunk } from "../lib/rag";
import { webAnswer } from "../lib/research";
import {
  activeKey,
  builtInVoices,
  checkImageModel,
  checkOpenRouterModel,
  findVoice,
  hostVoice,
  loadImageModelList,
  loadModelList,
  loadResearchModelList,
  loadSettings,
  loadVoiceList,
  normalizeModelId,
  patchSettings,
  PROVIDER_LABELS,
  saveImageModelList,
  saveModelList,
  saveResearchModelList,
  saveVoiceList,
  TTS_PROVIDER_LABELS,
  voiceLabel,
  type Host,
  type SavedVoice,
  type VoiceProvider,
  voicesNeedIds,
} from "../lib/settings";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { ACCEPT_STRING, fileToCoverDataUrl } from "../lib/source";
import { parseStudioCommand, type StudioCommand } from "../lib/studioCommands";
import { fmtReplyCost, recordUsage, replyCostUsd } from "../lib/usage";
import { BrewIcon } from "./BrewIcon";
import { THEMES, chooseTheme } from "../lib/themes";
import { FONTS, chooseFont } from "../lib/fonts";
import type { Artifact, ChatMessage, Folder, Settings, Source } from "../lib/types";
import { BrewingStatus, IconButton } from "./ui";

const MAX_MENTION_CHARS = 8000;
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
  autocomplete?: "theme" | "model" | "font";
}

/** What the /model-style picker lists: a model list, or saved voices. */
type PickerKind = "chat" | "image" | "research" | "voicehost" | "voicecohost" | "voice";

const PICKER_KIND: Record<string, PickerKind> = {
  model: "chat",
  imagemodel: "image",
  researchmodel: "research",
  voicehost: "voicehost",
  voicecohost: "voicecohost",
  voice: "voice",
};

const PICKER_CMD: Record<PickerKind, string> = {
  chat: "/model",
  image: "/imagemodel",
  research: "/researchmodel",
  voicehost: "/voicehost",
  voicecohost: "/voicecohost",
  voice: "/voice",
};

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
    cmd: "/model add",
    usage: "/model add <id>",
    desc: "Add a model to your list — paste an OpenRouter id or link",
    icon: Plus,
    takesArgs: true,
  },
  {
    cmd: "/model remove",
    usage: "/model remove <id>",
    desc: "Remove a model from your list (autocompletes yours)",
    icon: Trash2,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/imagemodel",
    usage: "/imagemodel <id>",
    desc: "Switch the model /image draws with (autocompletes yours)",
    icon: Image,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/imagemodel add",
    usage: "/imagemodel add <id>",
    desc: "Add an image model to your list — paste an OpenRouter id or link",
    icon: Plus,
    takesArgs: true,
  },
  {
    cmd: "/imagemodel remove",
    usage: "/imagemodel remove <id>",
    desc: "Remove an image model from your list (autocompletes yours)",
    icon: Trash2,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/researchmodel",
    usage: "/researchmodel <id>",
    desc: "Switch the model /research and /search run on (main = your main model)",
    icon: Telescope,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/researchmodel add",
    usage: "/researchmodel add <id>",
    desc: "Add a research model to your list — paste an OpenRouter id or link",
    icon: Plus,
    takesArgs: true,
  },
  {
    cmd: "/researchmodel remove",
    usage: "/researchmodel remove <id>",
    desc: "Remove a research model from your list (autocompletes yours)",
    icon: Trash2,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/voice",
    usage: "/voice",
    desc: "Show the Audio overview hosts' voices and your saved voices",
    icon: AudioLines,
    takesArgs: false,
  },
  {
    cmd: "/voicehost",
    usage: "/voicehost <name>",
    desc: "Switch the Host's voice (autocompletes your voices)",
    icon: AudioLines,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/voicecohost",
    usage: "/voicecohost <name>",
    desc: "Switch the Co-Host's voice (autocompletes your voices)",
    icon: AudioLines,
    takesArgs: true,
    autocomplete: "model",
  },
  {
    cmd: "/voice swap",
    usage: "/voice swap",
    desc: "Trade the Host and Co-Host voices",
    icon: ArrowLeftRight,
    takesArgs: false,
  },
  {
    cmd: "/voice add",
    usage: "/voice add <name> [voice ID]",
    desc: "Save a voice (ElevenLabs: a name + its voice ID)",
    icon: Plus,
    takesArgs: true,
  },
  {
    cmd: "/voice remove",
    usage: "/voice remove <name>",
    desc: "Remove a saved voice (autocompletes yours)",
    icon: Trash2,
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
    cmd: "/font",
    usage: "/font <name>",
    desc: "Switch the interface font (e.g. /font Typewriter)",
    icon: Type,
    takesArgs: true,
    autocomplete: "font",
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
    cmd: "/details",
    usage: "/details [on|off]",
    desc: "Show or hide token counts and cost under AI replies",
    icon: Info,
    takesArgs: false,
  },
  {
    cmd: "/ground",
    usage: "/ground",
    desc: "Toggle source grounding on/off for this notebook",
    icon: Anchor,
    takesArgs: false,
  },
  {
    cmd: "/search",
    usage: "/search <query>",
    desc: "One-shot web answer with cited sources (provider search)",
    icon: Search,
    takesArgs: true,
  },
  {
    cmd: "/image",
    usage: "/image [16:9] <prompt>",
    desc: "Generate a picture with your image model — no chat context sent",
    icon: Image,
    takesArgs: true,
  },
  {
    cmd: "/edit",
    usage: "/edit <change>",
    desc: "Change the latest picture — sends only that image + your instruction",
    icon: ImagePlus,
    takesArgs: true,
  },
  {
    cmd: "/remix",
    usage: "/remix <idea>",
    desc: "New picture inspired by the latest one (style, subject, layout)",
    icon: ImagePlus,
    takesArgs: true,
  },
  {
    cmd: "/more",
    usage: "/more",
    desc: "More like the latest picture — reruns its prompt, no context",
    icon: Image,
    takesArgs: false,
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
    desc: "Two-host podcast — deep-dive|brief|debate|critique · short (~5 min)|standard (~10)|long (~20)",
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
| Audio overview | Two hosts (Host & Co-Host) discuss your sources — Deep dive / Brief / Debate / Critique, then voiced via OpenAI, OpenRouter or ElevenLabs |
| Deep research | Plans search queries, browses the web, writes a cited report |

## 6. Chat commands
Type \`/\` in the composer to browse them (arrow keys + Enter).

**App actions** (run locally — no AI tokens):
- \`/help\` — shows this guide.
- \`/move <folder>\` — files this notebook into a folder (folder names autocomplete); \`/move out\` returns it to the homepage root.
- \`/theme <name>\` — switches the app theme instantly (names autocomplete). Available: ${THEMES.map((t) => t.name).join(", ")}. Also changeable in Settings.
- \`/font <name>\` — switches the interface font instantly (names autocomplete). Available: ${FONTS.map((f) => f.name).join(", ")}. Also changeable in Settings.
- \`/model <id>\` — swaps the active AI model (your model list autocompletes). A new id is added to your list automatically.
- \`/model add <id>\` — adds a model to your list without switching to it. Paste the id or the model's page link from openrouter.ai, e.g. \`/model add anthropic/claude-haiku-5.5\`. On OpenRouter the id is checked first, and you get close matches if it doesn't exist.
- \`/model remove <id>\` — removes a model from your list (your models autocomplete), e.g. \`/model remove anthropic/claude-haiku-5.5\`. Removing the active model keeps it active until you switch.
- \`/imagemodel <id>\` — swaps the model \`/image\` draws with (your image models autocomplete). \`/imagemodel add <id>\` and \`/imagemodel remove <id>\` edit that list, just like \`/model\`; added ids are checked against OpenRouter's image models. Also in Settings → AI Model → Image model.
- \`/researchmodel <id>\` — picks the model Deep Research and \`/search\` run on, separate from your chat model (your research models autocomplete); \`/researchmodel main\` goes back to your main model. \`/researchmodel add <id>\` and \`/researchmodel remove <id>\` edit that list. Also in Settings → AI Model → Research model.
- \`/voice\` — shows which voices the Audio overview hosts use. \`/voicehost <name>\` and \`/voicecohost <name>\` switch the Host's and Co-Host's voice, and \`/voice swap\` trades them. \`/voice add <name>\` saves a voice — on OpenRouter use the model's own voice name (e.g. \`voice_3150\` for Voxtral TTS 3), for ElevenLabs add its voice ID too, e.g. \`/voice add Rachel 21m00Tcm4TlvDq8ikWAM\` — and \`/voice remove <name>\` deletes one. Also in Settings → Audio Voices.
- \`/star\` — stars or un-stars this notebook (pinned order on the homepage).
- \`/details [on|off]\` — shows or hides the token counts and cost under each AI reply (e.g. "9.8k in · 637 out · $0.0042"). The cost is what OpenRouter billed; other providers show an estimate marked "~". Also in Settings → Appearance.
- \`/ground\` — toggles **source grounding** for this notebook. Off = free-form answers from the model's own knowledge (no sources sent, no citations, cheaper); @mention a source anytime to pull it into one answer. The state shows in the composer footer and sticks per notebook.
- \`/new\` — starts a fresh chat; the current conversation stays saved in the Chats panel.
- \`/clone "<title>" [yes|no]\` — makes an exact, independent copy of this whole notebook (sources, chats, studio work). **The title must be in quotes.** \`/clone "My copy"\` or \`/clone "My copy" no\` keeps you here; \`/clone "My copy" yes\` takes you there. Because the title is quoted, a *yes* or *no* inside it can't be confused for the flag — \`/clone "Project yes" no\` clones "Project yes" and stays put. For a sources-only starter copy, use **Use as template** on the homepage cards.
- \`/remove <sources|chats|studios> [type]\` — bulk delete. \`/remove sources\` wipes every source; \`/remove chats\` deletes all chat threads and starts fresh; \`/remove studios\` clears the Studio. Narrow it with a type, e.g. \`/remove sources links\` (text, links, pdf, images, audio, files) or \`/remove studios audios\` (flashcards, quizzes, mindmaps, audios, reports, research, drawings).
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
- \`/audio [deep-dive|brief|debate|critique] [short|standard|long] [focus]\` — two-host podcast, e.g. \`/audio debate short\`. Short ≈ 5 minutes, Standard ≈ 10, Long ≈ 20; longer episodes are planned first and written part by part, so they take a little longer to make.
- \`/report [summary|study-guide|briefing|faq|timeline|analysis|custom <instructions>]\` — grounded markdown documents.
- \`/research <topic>\` — plans searches, reads the web, writes a cited report (imported pages become sources).
- \`/search <query>\` — one-shot web answer, right here in chat, with numbered source links. Your provider bills web searches per query, so this only runs when you ask; for a deep multi-source dossier use \`/research\` instead.
- \`/image [ratio] <prompt>\` — generates a picture with your **Image model** (Settings → AI Model), e.g. \`/image 16:9 a watercolor fox in snow\`. Only your prompt is sent — no sources or chat history — so you pay just for the image (about $0.03 with the default model). Needs an OpenRouter key. Later chat turns see a one-line description of the image, never the pixels. If your selected model is itself an image model (e.g. via \`/model qwen/qwen-image-2.1-turbo\`), \`/image\` uses it, and plain messages generate images too — a message right after a picture edits that picture (start with \`/image\` for a fresh one).
- \`/edit <change>\` — changes the latest picture, e.g. \`/edit make the sky stormy\`. \`/remix <idea>\` makes a new picture inspired by it, and \`/more\` reruns its prompt for another take. Hover any generated picture for **Edit**, **Remix** and **More like this** on that specific one. Only that single picture (downscaled) and your words are sent — never the chat or sources. Editing needs an image model that accepts a reference picture; BrewLM tells you if yours can't.
AI Studio results are saved as artifacts in the Studio panel (right) — reopen, download, or add them back as sources from there. No arguments = the same defaults as clicking the tool card. Queued AI actions consume tokens when they run.

## Privacy
API keys, sources, chats and artifacts all live in a local database on your machine. No account, no cloud sync. Organizing works offline; only AI calls need a network.`;


/**
 * Assemble the system prompt. Section order is deliberate: constitution and
 * rules first, the (large, stable) sources block next, and the per-message
 * @-mentions last — keeping the expensive prefix byte-identical across turns
 * so provider prompt caching (explicit on Anthropic, automatic on OpenAI)
 * actually hits.
 *
 * When `retrieved` chunks are supplied (rag.ts), the sources block contains
 * the most relevant slices of ALL sources for this message instead of a blind
 * first-N-characters prefix of the first few sources — this is what lets a
 * 400-page PDF or a notebook full of files fit the context budget meaningfully
 * (30k chars on cloud models, sized to the context window on local ones).
 */
export function buildSystemPrompt(
  sources: Source[],
  mentioned: MentionItem[] = [],
  retrieved?: RetrievedChunk[],
  opts: { grounded?: boolean; budget?: ContextBudget } = {}
): string {
  const grounded = opts.grounded !== false;
  const budgetCaps = opts.budget ?? CLOUD_BUDGET;
  const constitutions = sources.filter(
    (s) => s.type === "context" && s.content.trim()
  );
  // Mentioned sources move into the priority section — don't include twice.
  const mentionedSourceIds = new Set(
    mentioned.filter((m) => m.group === "source").map((m) => m.id)
  );
  // Ungrounded: no source material is ever sent — zero source tokens, zero
  // retrieval cost; @-mentions (below) remain as the user's explicit override.
  const knowledge = grounded
    ? sources.filter(
        (s) => isRetrievable(s) && !mentionedSourceIds.has(s.id)
      )
    : [];

  const parts: string[] = ["You are BrewLM, a thoughtful study assistant."];

  // Constitution: the notebook's governing document. It may override defaults.
  if (constitutions.length > 0) {
    const body = constitutions
      .map((c) =>
        c.content.length > budgetCaps.constitution
          ? c.content.slice(0, budgetCaps.constitution) + "\n[…constitution truncated]"
          : c.content
      )
      .join("\n\n");
    parts.push(`# Notebook constitution\n${body}\n\nThe constitution above governs how you behave in this notebook — follow it strictly. Where it conflicts with the default rules below, the constitution wins.`);
  }

  const formatRules = `Write math in LaTeX notation — $...$ or \\(...\\) inline, $$...$$ or \\[...\\] for display equations (integrals, fractions, matrices…). The app renders it; never spell formulas out in plaintext.\n- Visuals the app renders inline when you emit them: fenced svg diagrams, fenced mermaid flowcharts/graphs, and image embeds ![alt](https://image-url). Use them when they'd clarify a concept.\n- Be concise and clear. Use markdown formatting (lists, headers, bold) where it improves readability.`;
  parts.push(
    grounded
      ? `# Default rules\n- Base answers on the user's sources first; say when something isn't covered.\n- Cite sources by title in parentheses, e.g. (Source: Week 4 lecture.pdf).\n- When a message references @Title, the user is pointing at that material — center the answer on it.\n- ${formatRules}`
      : `# Default rules\n- Source grounding is OFF in this notebook: answer from your own knowledge. None of the user's documents were sent with this conversation — do not claim to have read or cite specific sources.\n- Only if a message references @Title has the user handed you material — then center the answer on it and cite it.\n- ${formatRules}`
  );

  // Sources block: retrieval-ranked chunks when available, legacy prefix
  // truncation otherwise. Either way the section is capped by the sources budget
  // and ends with an honest coverage line so the model knows what it can't see.
  if (knowledge.length > 0) {
    const omitted: string[] = [];
    let section = "";

    if (retrieved && retrieved.length > 0) {
      const covered = new Set<string>();
      let budget = budgetCaps.sources;
      const blocks: string[] = [];
      let headerSource = "";
      for (const c of retrieved) {
        if (budget <= 0) break;
        const line = c.page ? `[p. ${c.page}] ${c.text}` : c.text;
        const header =
          c.sourceId !== headerSource ? `### ${c.sourceTitle} (${c.sourceType})\n` : "";
        const cost = header.length + line.length + 1;
        if (blocks.length > 0 && cost > budget) break;
        blocks.push(header + line);
        headerSource = c.sourceId;
        covered.add(c.sourceId);
        budget -= cost;
      }
      for (const s of knowledge) if (!covered.has(s.id)) omitted.push(s.title);
      const coverage =
        omitted.length === 0
          ? "Relevant excerpts from every source are included here."
          : `Excerpts from ${covered.size} of ${knowledge.length} sources are included, chosen for relevance to the latest message. Not covered here: ${listTitles(omitted)} — if the answer needs them, say so rather than guessing.`;
      section = `# Source excerpts (retrieved by relevance)\nThese are the most relevant passages from the user's sources for the latest message; other passages exist but aren't shown.\n\n${blocks.join("\n\n")}\n\n[Coverage: ${coverage}]`;
    } else {
      let budget = budgetCaps.sources;
      const sections: string[] = [];
      const included = new Set<string>();
      for (const s of knowledge) {
        if (budget <= 0) break;
        const cap = Math.min(budgetCaps.perSource, budget);
        const body = sourceText(s);
        const trimmed =
          body.length > cap
            ? body.slice(0, cap) +
              `\n[…truncated — only the first ${cap} of ${body.length} characters shown; other parts of this source exist]`
            : body;
        sections.push(`### ${s.title} (${s.type})\n${trimmed}`);
        included.add(s.id);
        budget -= trimmed.length;
      }
      for (const s of knowledge) if (!included.has(s.id)) omitted.push(s.title);
      if (omitted.length > 0) {
        sections.push(
          `[Coverage: only ${included.size} of ${knowledge.length} sources fit. Not in context: ${listTitles(omitted)} — if the answer needs them, say so rather than guessing.]`
        );
      }
      section = `# Sources\n${sections.join("\n\n---\n\n")}`;
    }
    parts.push(section);
  }

  // @-mentions tail the prompt: they vary per message, and anything before
  // them stays byte-stable for provider prompt caching.
  if (mentioned.length > 0) {
    let budget = budgetCaps.mentions;
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

  if (grounded && knowledge.length === 0 && mentioned.length === 0) {
    parts.push(
      "The user has not added any knowledge sources yet — encourage them to add sources, or answer simple questions generally."
    );
  }

  return parts.join("\n\n");
}

/** Comma-joined titles, capped so the coverage note itself stays cheap. */
function listTitles(titles: string[], max = 10): string {
  const shown = titles.slice(0, max);
  const rest = titles.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

/**
 * Pick the messages that fit the conversation-history budget: newest first,
 * at most HISTORY_LIMIT turns and ~maxChars total, always including
 * the latest message.
 */
export function selectChatHistory(all: ChatMessage[], maxChars = CLOUD_BUDGET.history): ChatMessage[] {
  const capped = all.slice(-HISTORY_LIMIT);
  const kept: ChatMessage[] = [];
  let budget = maxChars;
  for (let i = capped.length - 1; i >= 0; i--) {
    const m = capped[i];
    // Measure what the model will actually receive: image embeds are stripped
    // before sending, so their base64 must not eat the budget.
    const size = stripHistoryImages(m.content).length;
    if (kept.length > 0 && size > budget) break;
    kept.unshift(m);
    budget -= size;
  }
  return kept;
}

/** Grow the textarea with its content, up to ~20 lines.
 *  Keep overflow hidden whenever the content fits: WebKit counts textarea
 *  padding as scrollable overflow, so `auto` leaves the box wiggle-scrollable
 *  (phantom scrollbars, both axes) even when empty. Flip on scrolling only
 *  past the cap (scrollbar glyphs stay hidden via the className). */
function autoSize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const capped = Math.min(el.scrollHeight, 320);
  el.style.height = capped + "px";
  el.style.overflowY = el.scrollHeight > 320 ? "auto" : "hidden";
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
  notebookGrounded,
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
  /** /note command and a reply's "Save to Sources" — NotebookView saves the text as a source. */
  onAddNote: (text: string, title?: string) => Promise<Source>;
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
  /** Live grounding flag (SQLite boolean, default 1) so /ground can toggle it. */
  notebookGrounded?: number;
  /** Data-URL image behind the chat area ("" = none). */
  chatBg: string;
  /** Readability scrim over chatBg: 0–80 (percent). */
  chatBgDim: number;
  /** Set/clear (bg="") the chat background and/or its dim strength. */
  onChatBgChange: (bg: string, dim: number) => void | Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  /** Picture a hover Edit/Remix picked for the /edit or /remix being typed. */
  const [imageTarget, setImageTarget] = useState<{ id: string; alt: string } | null>(null);
  // The pick lasts only while the draft is still that command.
  useEffect(() => {
    if (imageTarget && !/^\/(edit|remix)(\s|$)/i.test(draft)) setImageTarget(null);
  }, [draft, imageTarget]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const streamingHtml = useMemo(() => (streaming ? renderMarkdown(streaming) : ""), [streaming]);
  const [error, setError] = useState<string | null>(null);
  /** Provider-reported token usage per assistant message (this session only). */
  const [usageByMsg, setUsageByMsg] = useState<Record<string, ReplyUsage>>({});
  // Mirror of settings.showDetails so /details flips the usage lines instantly.
  const [showDetails, setShowDetails] = useState(settings.showDetails);
  useEffect(() => setShowDetails(settings.showDetails), [settings.showDetails]);
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState<{ query: string; active: number } | null>(null);
  const [moveQuery, setMoveQuery] = useState<{ query: string; active: number } | null>(null);
  const [themeQuery, setThemeQuery] = useState<{ query: string; active: number } | null>(null);
  const [fontQuery, setFontQuery] = useState<{ query: string; active: number } | null>(null);
  /** `remove` = the picker feeds `… remove` instead of switching; `kind` = which list. */
  const [modelQuery, setModelQuery] = useState<{
    query: string;
    active: number;
    remove?: boolean;
    kind: PickerKind;
  } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // Mirror of settings.theme so "/theme" updates the "current" marker instantly.
  const [theme, setTheme] = useState(settings.theme);
  useEffect(() => setTheme(settings.theme), [settings.theme]);
  // Mirror of settings.font so "/font" updates the "current" marker instantly.
  const [font, setFont] = useState(settings.font);
  useEffect(() => setFont(settings.font), [settings.font]);
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
  /** Text sources' bodies — a reply already saved to Sources shows as saved. */
  const savedTexts = useMemo(
    () => new Set(sources.filter((s) => s.type === "text").map((s) => s.content)),
    [sources]
  );
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
      if (c.autocomplete === "font") setFontQuery({ query: "", active: 0 });
      if (c.autocomplete === "model")
        setModelQuery({
          query: "",
          active: 0,
          remove: c.cmd.endsWith(" remove"),
          kind: PICKER_KIND[c.cmd.slice(1).split(" ")[0]],
        });
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

  /* --------------- /model, /imagemodel, /researchmodel, /voice… --------------- */

  // Mirrors of the persisted choices so the pickers mark "current" instantly.
  const [model, setModel] = useState(settings.model);
  useEffect(() => setModel(settings.model), [settings.model]);
  const [imageModel, setImageModel] = useState(settings.imageModel);
  useEffect(() => setImageModel(settings.imageModel), [settings.imageModel]);
  const [researchModel, setResearchModel] = useState(settings.researchModels[settings.provider] ?? "");
  useEffect(
    () => setResearchModel(settings.researchModels[settings.provider] ?? ""),
    [settings.researchModels, settings.provider]
  );
  const [hostVoices, setHostVoices] = useState<Record<Host, string>>({
    Alex: hostVoice(settings, "Alex"),
    Sam: hostVoice(settings, "Sam"),
  });
  useEffect(
    () => setHostVoices({ Alex: hostVoice(settings, "Alex"), Sam: hostVoice(settings, "Sam") }),
    [settings]
  );
  const voiceProvider: VoiceProvider | null = settings.ttsProvider === "system" ? null : settings.ttsProvider;

  /**
   * `/model gpt`, `/imagemodel remove flux`, `/voicehost rach`, `/voice remove adam`…
   * at the start of the draft. `… add` gets no picker: it's for ids that
   * aren't in the list yet. Plain `/voice` takes subcommands, so only
   * `/voice remove` gets one.
   */
  const detectModel = (value: string): { query: string; remove: boolean; kind: PickerKind } | null => {
    const v = value.trim();
    const cmd = /^\/(model|imagemodel|researchmodel|voicehost|voicecohost|voice)(?=\s|$)/i.exec(v);
    if (!cmd) return null;
    const kind = PICKER_KIND[cmd[1].toLowerCase()];
    const rest = v.slice(cmd[0].length);
    if (/^\s+add(\s|$)/i.test(rest)) return null;
    const rm = /^\s+remove(?:\s+("?)([^\n"]*)\1?)?$/i.exec(rest);
    if (rm && kind !== "voicehost" && kind !== "voicecohost") return { query: rm[2] ?? "", remove: true, kind };
    if (kind === "voice") return null;
    const m = /^(?:\s+("?)([^\n"]*)\1?)?$/i.exec(rest);
    if (!m) return null;
    return { query: m[2] ?? "", remove: false, kind };
  };

  const modelHits = useMemo(() => {
    if (modelQuery === null) return [];
    const q = modelQuery.query.trim().toLowerCase();
    const hits = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
    return hits.slice(0, 8);
  }, [modelQuery, models]);
  const modelActiveIdx = Math.min(modelQuery?.active ?? 0, Math.max(modelHits.length - 1, 0));

  /** Picker entries: model ids, or saved voice names. */
  const loadPickerItems = async (kind: PickerKind): Promise<string[]> => {
    if (kind === "image") return loadImageModelList();
    if (kind === "research") return loadResearchModelList(settings.provider);
    if (kind === "chat") return loadModelList(settings.provider);
    return voiceProvider ? (await loadVoiceList(voiceProvider)).map((v) => v.name) : [];
  };
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (modelQuery === null) return;
    void loadPickerItems(modelQuery.kind).then(setModels);
    if (voiceProvider && modelQuery.kind.startsWith("voice"))
      void loadVoiceList(voiceProvider).then((l) => setVoiceNames(Object.fromEntries(l.map((v) => [v.name, v.id]))));
  }, [modelQuery, settings.provider, voiceProvider]);

  /** The picker's "current" entry for its kind. */
  const pickerCurrent = (kind: PickerKind, item: string): boolean => {
    if (kind === "chat") return item === model;
    if (kind === "image") return item === imageModel;
    if (kind === "research") return item === researchModel;
    if (kind === "voicehost") return voiceNames[item] === hostVoices.Alex;
    if (kind === "voicecohost") return voiceNames[item] === hostVoices.Sam;
    return false;
  };

  const acceptModel = (id: string) => {
    const cmd = PICKER_CMD[modelQuery?.kind ?? "chat"];
    setDraft(modelQuery?.remove ? `${cmd} remove "${id}" ` : `${cmd} "${id}" `);
    setModelQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
    });
  };

  const say = async (reply: string) => {
    const replyMsg = await addMessage(chatId as string, notebookId, "assistant", reply);
    setMsgs((prev) => [...prev, replyMsg]);
  };
  const codeList = (list: string[]) => list.map((x) => `\`${x}\``).join(", ") || "none";

  /** What differs between the /model, /imagemodel and /researchmodel lists. */
  const modelListSpec = (kind: "chat" | "image" | "research") => {
    const provider = settings.provider;
    const label = PROVIDER_LABELS[provider];
    if (kind === "image")
      return {
        cmd: "/imagemodel",
        noun: "image models",
        example: "openai/gpt-image-2",
        load: loadImageModelList,
        save: saveImageModelList,
        check: checkImageModel,
        missing: "image model",
        current: imageModel,
        keptActive: (id: string) =>
          `Removed \`${id}\` from your image models. \`/image\` keeps using it until you switch with \`/imagemodel <id>\`.`,
      };
    if (kind === "research")
      return {
        cmd: "/researchmodel",
        noun: `${label} research models`,
        example: "anthropic/claude-sonnet-4.5",
        load: () => loadResearchModelList(provider),
        save: (l: string[]) => saveResearchModelList(provider, l),
        check: provider === "openrouter" ? checkOpenRouterModel : undefined,
        missing: "model",
        current: researchModel,
        keptActive: (id: string) =>
          `Removed \`${id}\` from your research models. Research keeps using it until you switch with \`/researchmodel <id>\` (or \`/researchmodel main\`).`,
      };
    return {
      cmd: "/model",
      noun: `${label} models`,
      example: "anthropic/claude-haiku-5.5",
      load: () => loadModelList(provider),
      save: (l: string[]) => saveModelList(provider, l),
      check: provider === "openrouter" ? checkOpenRouterModel : undefined,
      missing: "model",
      current: model,
      keptActive: (id: string) =>
        `Removed \`${id}\` from your list. It's still the active model until you switch with \`/model <id>\`.`,
    };
  };

  /** /model|/imagemodel|/researchmodel add|remove — edit a list without switching. */
  const runModelListCommand = async (
    kind: "chat" | "image" | "research",
    action: "add" | "remove",
    raw: string
  ): Promise<string> => {
    const spec = modelListSpec(kind);
    const id = normalizeModelId(raw);
    const list = await spec.load();
    if (!id) {
      return action === "add"
        ? `Which ${spec.missing}? Paste its id or link from openrouter.ai, e.g. \`${spec.cmd} add ${spec.example}\`.`
        : `Which ${spec.missing}? e.g. \`${spec.cmd} remove ${list[0] ?? spec.example}\`. Your ${spec.noun}: ${codeList(list)}.`;
    }
    if (action === "remove") {
      const hit = list.find((x) => x.toLowerCase() === id.toLowerCase());
      if (!hit) return `\`${id}\` isn't in your ${spec.noun}. Your ${spec.noun}: ${codeList(list)}.`;
      const next = list.filter((x) => x !== hit);
      await spec.save(next);
      setModels(next);
      onSettingsChanged();
      return hit === spec.current ? spec.keptActive(hit) : `Removed \`${hit}\` from your ${spec.noun}.`;
    }
    if (/\s/.test(id)) return `\`${id}\` doesn't look like a model id — ids have no spaces, e.g. \`${spec.example}\`.`;
    if (list.includes(id)) return `\`${id}\` is already in your ${spec.noun}. Switch to it with \`${spec.cmd} ${id}\`.`;
    let note = "";
    if (spec.check) {
      const check = await spec.check(id);
      if (check.status === "unknown") {
        const alts = check.suggestions.map((x) => `\`${x}\``).join(", ");
        return `OpenRouter has no ${spec.missing} \`${id}\`, so I didn't add it.${alts ? ` Did you mean ${alts}?` : ""} Copy the exact id from the model's page on openrouter.ai.`;
      }
      if (check.status === "unverified") note = " (couldn't reach OpenRouter to double-check the id)";
    }
    const next = [...list, id];
    await spec.save(next);
    setModels(next);
    onSettingsChanged();
    return `Added \`${id}\` to your ${spec.noun}${note}. Switch to it with \`${spec.cmd} ${id}\`.`;
  };

  /** A genuinely new id also joins the editable Settings list. */
  const rememberModel = async (kind: "chat" | "image" | "research", id: string) => {
    const spec = modelListSpec(kind);
    const list = await spec.load();
    if (list.includes(id)) return;
    const next = [...list, id];
    await spec.save(next);
    setModels(next);
  };

  /** Execute /model locally (no LLM) — swap the model and persist it. */
  const runModelCommand = async (text: string): Promise<void> => {
    const sub = /^\/model\s+(add|remove)(?:\s+([\s\S]*))?$/i.exec(text);
    if (sub) return say(await runModelListCommand("chat", sub[1].toLowerCase() as "add" | "remove", sub[2] ?? ""));
    const m = /^\/model(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
    const raw = (m?.[2] ?? "").trim();
    if (!raw) {
      const list = await loadModelList(settings.provider);
      return say(`Current model: \`${model}\`. Your ${settings.provider} models: ${codeList(list)}.`);
    }
    await setSetting("model", raw);
    setModel(raw);
    await rememberModel("chat", raw);
    onSettingsChanged();
    await say(`Model set to \`${raw}\`.`);
  };

  /** /imagemodel — show, switch or edit the model /image draws with (no LLM). */
  const runImageModelCommand = async (text: string): Promise<void> => {
    const sub = /^\/imagemodel\s+(add|remove)(?:\s+([\s\S]*))?$/i.exec(text);
    if (sub) return say(await runModelListCommand("image", sub[1].toLowerCase() as "add" | "remove", sub[2] ?? ""));
    const raw = normalizeModelId(text.replace(/^\/imagemodel\s*/i, ""));
    if (!raw) {
      const list = await loadImageModelList();
      return say(`Current image model: \`${imageModel}\`. Your image models: ${codeList(list)}.`);
    }
    await setSetting("imageModel", raw);
    setImageModel(raw);
    await rememberModel("image", raw);
    onSettingsChanged();
    await say(
      settings.provider === "openrouter" && (await isImageApiModel(model))
        ? `Image model set to \`${raw}\`. Your active model \`${model}\` is itself an image model, so \`/image\` keeps using that one until you switch it with \`/model <id>\`.`
        : `Image model set to \`${raw}\`.`
    );
  };

  /** /researchmodel — show, switch or edit the model /research and /search run on. */
  const runResearchModelCommand = async (text: string): Promise<void> => {
    const provider = settings.provider;
    if (provider === "local")
      return say("Research and `/search` need web search, which local models can't do — switch to OpenRouter, OpenAI or Anthropic in Settings → AI Model to pick a research model.");
    const sub = /^\/researchmodel\s+(add|remove)(?:\s+([\s\S]*))?$/i.exec(text);
    if (sub) return say(await runModelListCommand("research", sub[1].toLowerCase() as "add" | "remove", sub[2] ?? ""));
    const raw = normalizeModelId(text.replace(/^\/researchmodel\s*/i, ""));
    if (!raw) {
      const list = await loadResearchModelList(provider);
      const now = researchModel ? `\`${researchModel}\`` : `same as your main model (\`${model}\`)`;
      return say(`Research model: ${now}. Your ${PROVIDER_LABELS[provider]} research models: ${codeList(list)}. Use \`/researchmodel main\` to go back to your main model.`);
    }
    const toMain = /^(main|default|same)$/i.test(raw);
    const fresh = await loadSettings();
    await patchSettings({ researchModels: { ...fresh.researchModels, [provider]: toMain ? "" : raw } });
    setResearchModel(toMain ? "" : raw);
    if (!toMain) await rememberModel("research", raw);
    onSettingsChanged();
    await say(
      toMain
        ? `Research now uses your main model (\`${model}\`).`
        : `Research model set to \`${raw}\` — \`/research\` and \`/search\` use it from now on.${provider === "openai" ? " (On OpenAI the web search itself still runs on gpt-4o-mini-search-preview.)" : ""}`
    );
  };

  /** /voice, /voice add|remove|swap, /voicehost, /voicecohost — no LLM. */
  const runVoiceCommand = async (text: string): Promise<void> => {
    if (!voiceProvider)
      return say("Your audio uses **System voices**, which your computer picks automatically. Choose OpenAI, OpenRouter or ElevenLabs in Settings → Audio Voices to pick the hosts' voices.");
    const p = voiceProvider;
    const providerLabel = TTS_PROVIDER_LABELS[p];
    const builtIn = builtInVoices(p);
    const list = await loadVoiceList(p);
    const fresh = await loadSettings();
    const now: Record<Host, string> = { Alex: hostVoice(fresh, "Alex"), Sam: hostVoice(fresh, "Sam") };
    const label = (id: string) => (id ? `**${voiceLabel(list, id)}**` : "not set");
    const yours = list.map((v) => v.name).join(", ") || "none";
    const setHost = async (host: Host, id: string) => {
      await patchSettings(host === "Alex" ? { ttsVoiceAlex: id } : { ttsVoiceSam: id });
      setHostVoices((h) => ({ ...h, [host]: id }));
      onSettingsChanged();
    };
    const saveList = async (next: SavedVoice[]) => {
      await saveVoiceList(p, next);
      setModels(next.map((v) => v.name));
    };

    const hostCmd = /^\/voice(host|cohost)(?:\s+([\s\S]*))?$/i.exec(text);
    if (hostCmd) {
      const host: Host = hostCmd[1].toLowerCase() === "host" ? "Alex" : "Sam";
      const role = host === "Alex" ? "Host" : "Co-Host";
      const cmd = host === "Alex" ? "/voicehost" : "/voicecohost";
      const raw = stripOuterQuotes((hostCmd[2] ?? "").trim());
      if (!raw) return say(`${role} voice: ${label(now[host])} (${providerLabel}). Your voices: ${yours}. Switch with \`${cmd} <name>\`.`);
      const saved = findVoice(list, raw);
      if (saved) {
        await setHost(host, saved.id);
        return say(`${role} now speaks with **${saved.name}**.`);
      }
      if (builtIn) {
        const match = builtIn.find((v) => v.toLowerCase() === raw.toLowerCase());
        if (!match) return say(`${providerLabel} has no voice “${raw}”. Its voices: ${builtIn.join(", ")}.`);
        await saveList([...list, { name: match, id: match }]);
        await setHost(host, match);
        return say(`${role} now speaks with **${match}** (added back to your voices).`);
      }
      if (!voicesNeedIds(p)) {
        // OpenRouter: voices belong to the TTS model, so any name is taken as-is.
        if (/\s/.test(raw)) return say(`Voice names have no spaces — use the exact value from the model's OpenRouter page, e.g. \`${cmd} voice_3150\`.`);
        await saveList([...list, { name: raw, id: raw }]);
        await setHost(host, raw);
        return say(`${role} now speaks with **${raw}** (added to your voices). If the TTS model doesn't know that voice, the audio overview will say so.`);
      }
      if (/^[A-Za-z0-9]{10,40}$/.test(raw)) {
        await setHost(host, raw);
        return say(`${role} now uses voice ID \`${raw}\`. Give it a name with \`/voice add <name> ${raw}\` so it autocompletes next time.`);
      }
      return say(`“${raw}” isn't one of your saved voices. Your voices: ${yours}. Add a new one with \`/voice add <name> <voice ID>\`.`);
    }

    const sub = /^\/voice(?:\s+(add|remove|swap)\b)?(?:\s+([\s\S]*))?$/i.exec(text);
    const action = sub?.[1]?.toLowerCase();
    const arg = (sub?.[2] ?? "").trim();
    if (!action) {
      return say(
        `Host: ${label(now.Alex)} · Co-Host: ${label(now.Sam)} — ${providerLabel}.\n\nYour voices: ${yours}.\n\nSwitch with \`/voicehost <name>\` or \`/voicecohost <name>\`, trade them with \`/voice swap\`, and edit the list with \`/voice add\` / \`/voice remove\`.`
      );
    }
    if (action === "swap") {
      await patchSettings({ ttsVoiceAlex: now.Sam, ttsVoiceSam: now.Alex });
      setHostVoices({ Alex: now.Sam, Sam: now.Alex });
      onSettingsChanged();
      return say(`Swapped — Host: ${label(now.Sam)} · Co-Host: ${label(now.Alex)}.`);
    }
    if (action === "remove") {
      const name = stripOuterQuotes(arg);
      if (!name) return say(`Which voice? e.g. \`/voice remove ${list[0]?.name ?? "Rachel"}\`. Your voices: ${yours}.`);
      const hit = findVoice(list, name);
      if (!hit) return say(`“${name}” isn't in your ${providerLabel} voices. Your voices: ${yours}.`);
      await saveList(list.filter((v) => v !== hit));
      const using = (Object.keys(now) as Host[]).filter((h) => now[h] === hit.id);
      return say(
        using.length
          ? `Removed **${hit.name}** from your voices. The ${using.map((h) => (h === "Alex" ? "Host" : "Co-Host")).join(" and ")} keeps using it until you switch.`
          : `Removed **${hit.name}** from your voices.`
      );
    }
    // add
    if (builtIn) {
      const name = stripOuterQuotes(arg);
      const match = builtIn.find((v) => v.toLowerCase() === name.toLowerCase());
      if (!match) return say(`${name ? `${providerLabel} has no voice “${name}”. ` : ""}${providerLabel} voices: ${builtIn.join(", ")} — e.g. \`/voice add coral\`.`);
      if (findVoice(list, match)) return say(`**${match}** is already in your voices. Use it with \`/voicehost ${match}\`.`);
      await saveList([...list, { name: match, id: match }]);
      return say(`Added **${match}** to your voices. Use it with \`/voicehost ${match}\` or \`/voicecohost ${match}\`.`);
    }
    if (!voicesNeedIds(p)) {
      // OpenRouter: the voice's own name is what the model expects.
      const name = stripOuterQuotes(arg);
      if (!name || /\s/.test(name))
        return say("Give the voice exactly as the TTS model names it, e.g. `/voice add voice_3150` for Voxtral TTS 3 or `/voice add nova` for gpt-audio. The names are on the model's OpenRouter page.");
      if (findVoice(list, name)) return say(`**${name}** is already in your voices. Use it with \`/voicehost ${name}\`.`);
      await saveList([...list, { name, id: name }]);
      return say(`Added **${name}** to your OpenRouter voices. Use it with \`/voicehost ${name}\` or \`/voicecohost ${name}\`.`);
    }
    // ElevenLabs: a name (quote it if it has spaces) then the voice ID.
    const parsed = /^(?:"([^"]+)"|(.+?))\s+(\S+)$/.exec(arg);
    const name = (parsed?.[1] ?? parsed?.[2] ?? "").trim();
    const id = parsed?.[3] ?? "";
    if (!name || !id)
      return say("Give the voice a name and its ElevenLabs voice ID, e.g. `/voice add Rachel 21m00Tcm4TlvDq8ikWAM` (quote names with spaces). The ID is on the voice's page at elevenlabs.io.");
    if (list.some((v) => v.name.toLowerCase() === name.toLowerCase()))
      return say(`You already have a voice named **${name}**. Remove it first with \`/voice remove ${name}\`.`);
    await saveList([...list, { name, id }]);
    await say(`Added **${name}** (\`${id}\`) to your ElevenLabs voices. Use it with \`/voicehost ${name.includes(" ") ? `"${name}"` : name}\`.`);
  };

  /* ----------------------------- /theme command ----------------------------- */

  /** `/theme`, `/themes`, `/theme wine` at the start of the draft. */
  const detectTheme = (value: string): string | null => {
    const m = /^\/themes?(?:\s+("?)([^\n"]*)\1?)?$/i.exec(value.trim());
    if (!m) return null;
    return m[2] ?? "";
  };

  const themeHits = useMemo(() => {
    if (themeQuery === null) return [];
    const q = themeQuery.query.trim().toLowerCase();
    // No cap: all themes are listed (the popup scrolls when it gets tall).
    return q ? THEMES.filter((t) => t.name.toLowerCase().includes(q)) : THEMES;
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
    const m = /^\/themes?(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
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

  /* ----------------------------- /font command ------------------------------ */

  /** `/font`, `/fonts`, `/font typewriter` at the start of the draft. */
  const detectFont = (value: string): string | null => {
    const m = /^\/fonts?(?:\s+("?)([^\n"]*)\1?)?$/i.exec(value.trim());
    if (!m) return null;
    return m[2] ?? "";
  };

  const fontHits = useMemo(() => {
    if (fontQuery === null) return [];
    const q = fontQuery.query.trim().toLowerCase();
    return q ? FONTS.filter((f) => f.name.toLowerCase().includes(q)) : FONTS;
  }, [fontQuery]);
  const fontActiveIdx = Math.min(fontQuery?.active ?? 0, Math.max(fontHits.length - 1, 0));

  const acceptFont = (name: string) => {
    setDraft(`/font "${name}" `);
    setFontQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
    });
  };

  /** Execute /font locally (no LLM). Returns true when `text` was a command. */
  const runFontCommand = async (text: string): Promise<boolean> => {
    const m = /^\/fonts?(?:\s+("?)([^\n"]+)\1?)?$/i.exec(text);
    if (!m) return false;
    const raw = (m[2] ?? "").trim();
    let reply: string;
    if (!raw) {
      reply = `Current font: **${FONTS.find((f) => f.id === font)?.name ?? font}**. Pick one: ${FONTS.map((f) => `\`/font ${f.name}\``).join(" · ")}`;
    } else {
      const hit = FONTS.find(
        (f) => f.name.toLowerCase() === raw.toLowerCase() || f.id === raw.toLowerCase()
      );
      if (hit) {
        await chooseFont(hit.id);
        setFont(hit.id);
        reply = `Font set to **${hit.name}**.`;
      } else {
        reply = `No font named “${raw}”. Available: ${FONTS.map((f) => f.name).join(", ")}.`;
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
      setUsageByMsg({});
      return;
    }
    let cancelled = false;
    setUsageByMsg({});
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

  // Images finish loading after layout; keep the view pinned to the bottom if
  // it was there (load doesn't bubble, so listen in the capture phase).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onLoad = (e: Event) => {
      if ((e.target as HTMLElement).tagName !== "IMG") return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
  }, []);

  const keyed = activeKey(settings);

  /**
   * Send one payload end-to-end (command or chat message). The /queue drain
   * loop calls this in sequence; `streamingRef` mirrors the LLM busy state
   * synchronously so a chained runSend never hits a stale-closure block.
   */
  const runSend = async (text: string, opts?: { imageId?: string }): Promise<void> => {
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
    if (/^\/themes?(\s|$)/i.test(text)) {
      await runThemeCommand(text);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /font is a local app command — switch the interface font, no LLM call.
    if (/^\/fonts?(\s|$)/i.test(text)) {
      await runFontCommand(text);
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

    // Model and voice pickers are local app commands — no LLM call.
    const pickerCmd = /^\/(model|imagemodel|researchmodel|voice|voicehost|voicecohost)(?=\s|$)/i.exec(text)?.[1].toLowerCase();
    if (pickerCmd) {
      if (pickerCmd === "imagemodel") await runImageModelCommand(text);
      else if (pickerCmd === "researchmodel") await runResearchModelCommand(text);
      else if (pickerCmd.startsWith("voice")) await runVoiceCommand(text);
      else await runModelCommand(text);
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

    // /details [on|off] — show/hide the usage line under AI replies (app-wide).
    if (/^\/details(\s|$)/i.test(text)) {
      const arg = text.replace(/^\/details\s*/i, "").trim().toLowerCase();
      const next = arg === "on" ? true : arg === "off" ? false : !showDetails;
      await setSetting("showDetails", next ? "1" : "0");
      setShowDetails(next);
      onSettingsChanged();
      const replyMsg = await addMessage(
        chatId,
        notebookId,
        "assistant",
        next
          ? "Response details **on**: token counts and cost show under each AI reply. (`/details` toggles this.)"
          : "Response details **off**: replies show just the answer. (`/details` toggles this.)"
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /ground — toggle source grounding for this notebook.
    if (/^\/ground(\s|$)/i.test(text)) {
      const next = (notebookGrounded ?? 1) === 0;
      await setNotebookGrounded(notebookId, next);
      onNotebookMoved();
      const replyMsg = await addMessage(
        chatId,
        notebookId,
        "assistant",
        next
          ? `📚 Grounding **on** — answers will be grounded in your sources and cite them. (\`/ground\` toggles this.)`
          : `🌐 Grounding **off** — I'll answer from my own knowledge and skip your sources entirely (cheaper and faster — no retrieval runs). @mention a source anytime to pull it into a single answer. (\`/ground\` toggles this.)`
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // Image API turns, each carrying ONLY the prompt (no sources, no history):
    // /image draws fresh; /edit and /remix add the single picture being
    // changed as a reference; /more reruns a picture's stored prompt. Every
    // picture costs just the image, and later chat turns see a one-line
    // description of it, never the pixels. With an image model selected as
    // the active model, plain messages work the same way — and a message
    // right after a picture edits that picture.
    const activeIsImageModel =
      settings.provider === "openrouter" && (await isImageApiModel(settings.model));
    const imgCmd = /^\/(image|img|edit|remix|more)(?=\s|$)/i.exec(text)?.[1].toLowerCase();
    if (imgCmd || (activeIsImageModel && !text.startsWith("/"))) {
      let prompt = imgCmd ? text.replace(/^\/\w+\s*/, "").trim() : text;
      let ratio: string | undefined;
      const rm = /^(\d+(?:\.\d+)?:\d+(?:\.\d+)?)(\s+|$)/.exec(prompt);
      if (rm) {
        ratio = rm[1];
        prompt = prompt.slice(rm[0].length).trim();
      }
      const say = async (body: string) => {
        const replyMsg = await addMessage(chatId, notebookId, "assistant", body);
        setMsgs((prev) => [...prev, replyMsg]);
      };
      // The selected model wins when it is an image model; otherwise the
      // dedicated Image model setting.
      let model = activeIsImageModel ? settings.model : settings.imageModel;
      let mode: "new" | "edit" | "remix" | "more" =
        imgCmd === "edit" || imgCmd === "remix" || imgCmd === "more" ? imgCmd : "new";
      // Target: the picture a hover action picked, else the chat's latest one.
      let targetId: string | undefined;
      if (mode !== "new") {
        targetId = opts?.imageId;
        for (let i = history.length - 1; !targetId && i >= 0; i--) {
          if (history[i].role === "assistant") targetId = imageIdsIn(history[i].content).pop();
        }
      }
      // Plain message right after a picture → edit that picture (when the
      // model can take a reference; otherwise it simply draws fresh).
      let followUp = false;
      const prev = history[history.length - 2];
      if (!imgCmd && prev?.role === "assistant" && (await maxInputReferences(model)) > 0) {
        const prevId = imageIdsIn(prev.content).pop();
        if (prevId) {
          mode = "edit";
          targetId = prevId;
          followUp = true;
        }
      }
      const source = targetId ? await getImage(targetId) : null;
      if (followUp && !source) {
        mode = "new"; // picture above is gone — just draw fresh
        followUp = false;
      }

      if (!settings.openrouterKey) {
        await say(
          "Pictures use OpenRouter's image models. Add an OpenRouter API key in **Settings → AI Model** (select OpenRouter to enter it — you can switch your chat provider back afterwards)."
        );
      } else if (mode === "new" && !prompt) {
        await say(
          "What should I draw? e.g. `/image a watercolor fox in snow`, or add a shape first: `/image 16:9 a misty mountain lake at dawn`."
        );
      } else if (mode !== "new" && !targetId) {
        await say("There's no picture in this chat yet — make one first with `/image <prompt>`.");
      } else if (mode !== "new" && !source) {
        await say("That picture is no longer in the image library, so there's nothing to work from.");
      } else if ((mode === "edit" || mode === "remix") && !prompt) {
        await say(
          mode === "edit"
            ? "What should I change? e.g. `/edit make the sky stormy` or `/edit remove the text`."
            : "What should the remix be? e.g. `/remix same style, but a city at night`."
        );
      } else {
        // "More like this" stays on the model that drew the original.
        if (mode === "more" && source && source.model !== model && (await isImageApiModel(source.model))) {
          model = source.model;
        }
        const canReference = (await maxInputReferences(model)) > 0;
        if ((mode === "edit" || mode === "remix") && !canReference) {
          const alts = (await editCapableModels()).map((m) => `\`${m}\``).join(", ");
          await say(
            `**${model}** can't edit pictures — it doesn't accept a reference image. ${
              alts ? `Models that can: ${alts}. ` : ""
            }Pick one under **Settings → AI Model → Image model**${
              activeIsImageModel ? " or switch with `/model <id>`" : ""
            }.`
          );
        } else {
          streamingRef.current = true;
          setStreaming("");
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          try {
            // The one picture sent as a reference: the target for edit/remix;
            // for "more", whatever the original itself was made from.
            const refId =
              mode === "edit" || mode === "remix" ? source!.id : mode === "more" && canReference ? source!.parent_id : "";
            const refUri = refId ? await libraryImageAsReference(refId) : null;
            const apiPrompt =
              mode === "more"
                ? source!.prompt
                : mode === "remix"
                  ? `Create a new image inspired by the reference image (keep its style and mood): ${prompt}`
                  : prompt;
            // Keep the original's shape unless the user named one.
            if (!ratio && source && source.width > 0 && source.height > 0) {
              const want = source.width / source.height;
              const best = (await supportedAspectRatios(model))
                ?.map((r) => {
                  const [w, h] = r.split(":").map(Number);
                  return { r, diff: Math.abs(w / h - want) / want };
                })
                .filter((x) => Number.isFinite(x.diff))
                .sort((a, b) => a.diff - b.diff)[0];
              if (best && best.diff < 0.05) ratio = best.r;
            }
            const result = await generateImages({
              apiKey: settings.openrouterKey,
              model,
              prompt: apiPrompt,
              aspectRatio: ratio,
              references: refUri ? [refUri] : undefined,
              n: mode === "more" ? Math.min(2, await maxImagesPerRequest(model)) : 1,
              signal: ctrl.signal,
            });
            if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
            void recordUsage("image", "openrouter", model, result.usage);
            // Alt text is the description later chat turns see.
            const alt =
              mode === "edit"
                ? `${prompt} (edit of: ${source!.prompt})`
                : mode === "remix"
                  ? `${prompt} (remix of: ${source!.prompt})`
                  : apiPrompt;
            const refs: string[] = [];
            for (const uri of result.images) {
              const id = await saveImageToLibrary(uri, {
                notebookId,
                chatId,
                prompt: apiPrompt,
                model,
                parentId: refUri ? refId : undefined,
              });
              refs.push(imageRef(id, alt));
            }
            const cost = result.usage.costUsd;
            const label = { new: null, edit: "edit", remix: "remix", more: "more like this" }[mode];
            const caption = [label, model, result.aspectRatio, cost != null ? `$${cost.toFixed(3)}` : null]
              .filter(Boolean)
              .join(" · ");
            const unsupported =
              ratio && !result.aspectRatio && rm ? ` — ${ratio} isn't available on this model, so it used its default shape` : "";
            const hint = followUp ? " — edited the picture above; start with `/image` for a fresh one" : "";
            await say(`${refs.join("\n\n")}\n\n*${caption}${unsupported}*${hint}`);
          } catch (e) {
            if (!(isAbortError(e) || ctrl.signal.aborted)) {
              setError(e instanceof Error ? e.message : String(e));
            }
          } finally {
            abortRef.current = null;
            streamingRef.current = false;
            setStreaming(null);
          }
        }
      }
      onChatActivity?.(chatId, isFirst ? `Image: ${imageAlt(prompt || source?.prompt || "…")}` : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /search <query> — one-shot web answer with cited links (provider search,
    // billed per query — that's why it's a command, not a background toggle).
    if (/^\/search(\s|$)/i.test(text)) {
      const query = text.replace(/^\/search\s*/i, "").trim();
      if (!query) {
        const replyMsg = await addMessage(
          chatId,
          notebookId,
          "assistant",
          "What should I look up? e.g. `/search best budget e-ink tablets 2026`. For a deep multi-source dossier saved to Studio, use `/research <topic>` instead."
        );
        setMsgs((prev) => [...prev, replyMsg]);
        onChatActivity?.(chatId, isFirst ? text : undefined);
        textareaRef.current?.focus();
        return;
      }
      streamingRef.current = true;
      setStreaming("");
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const groundedNow = (notebookGrounded ?? 1) !== 0;
        const mentionedNow = resolveMentions(query, catalog);
        // Same grounding as chat — web results can weave into notebook context.
        let retrieved: RetrievedChunk[] | undefined;
        if (groundedNow) {
          try {
            await ensureIndexed(sources, settings);
            const ranked = await rankChunks(sources, query, settings, contextBudget(settings).sources);
            if (ranked.length > 0) retrieved = ranked;
          } catch {
            /* search proceeds without notebook context */
          }
        }
        const { text: answer, hits } = await webAnswer({
          query,
          settings,
          system: buildSystemPrompt(sources, mentionedNow, retrieved, { grounded: groundedNow, budget: contextBudget(settings) }),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        let body = answer || "(no answer came back — try rephrasing)";
        if (hits.length > 0) {
          body += `\n\n---\n\n##### Sources from the web\n${hits
            .map((h, i) => `${i + 1}. [${h.title}](${h.url})`)
            .join("\n")}`;
        }
        const replyMsg = await addMessage(chatId, notebookId, "assistant", body);
        setMsgs((prev) => [...prev, replyMsg]);
      } catch (e) {
        if (!(isAbortError(e) || ctrl.signal.aborted)) {
          setError(e instanceof Error ? e.message : String(e));
        }
        // aborted → nothing saved (user pressed stop)
      } finally {
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(null);
        textareaRef.current?.focus();
      }
      onChatActivity?.(chatId, isFirst ? `Search: ${query}` : undefined);
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
      const parsed = parseStudioCommand(text, settings);
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

    // Retrieval: index any unindexed sources, then fill the context budget
    // with the chunks most relevant to this message. Skipped entirely when
    // grounding is off (no embedding calls, no source tokens, no delay).
    // Any failure falls back to legacy truncation inside buildSystemPrompt.
    const groundedNow = (notebookGrounded ?? 1) !== 0;
    let retrieved: RetrievedChunk[] | undefined;
    if (groundedNow) {
      try {
        await ensureIndexed(sources, settings);
        const ranked = await rankChunks(sources, text, settings, contextBudget(settings).sources);
        const mentionedIds = new Set(
          mentioned.filter((m) => m.group === "source").map((m) => m.id)
        );
        const filtered = ranked.filter((r) => !mentionedIds.has(r.sourceId));
        if (filtered.length > 0) retrieved = filtered;
      } catch (e) {
        console.warn("rag: retrieval skipped", e);
      }
    }

    const llmMessages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(sources, mentioned, retrieved, { grounded: groundedNow, budget: contextBudget(settings) }) },
      ...selectChatHistory(history, contextBudget(settings).history).map((m, i, arr) => ({
        role: m.role,
        // Image embeds in past turns stay on screen but leave the context
        // (multi-hundred-KB base64 re-sent per turn = silent token burn).
        // The visible bubble says "/summarize"; the model gets the real prompt.
        content: stripHistoryImages(
          isSummarize && i === arr.length - 1 && m.role === "user"
            ? `Write a clear, well-structured summary of this whole notebook: the core ideas, why they matter, and the key details worth remembering. Cover every source.`
            : m.content
        ),
      })),
    ];

    let acc = "";
    let usage: StreamUsage | null = null;
    try {
      for await (const delta of streamChat({
        provider: settings.provider,
        apiKey: keyed,
        model: settings.model,
        messages: llmMessages,
        temperature: settings.temperature ?? undefined,
        signal: ctrl.signal,
        onUsage: (u) => {
          usage = u;
          void recordUsage("chat", settings.provider, settings.model, u);
        },
      })) {
        acc += delta;
        setStreaming(acc);
      }
      // Cancelled right at the tail? Discard rather than save a cut-off answer.
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
      // Generated images move into the image library; the message keeps a reference.
      const savedText = acc
        ? await storeGeneratedImages(acc, { notebookId, chatId, prompt: text, model: settings.model })
        : acc;
      const assistantMsg = await addMessage(chatId, notebookId, "assistant", savedText || "(no response)");
      if (usage) {
        const u: StreamUsage = usage;
        const cost = replyCostUsd(settings.provider, settings.model, u);
        setUsageByMsg((prev) => ({
          ...prev,
          [assistantMsg.id]: { ...u, costUsd: cost?.usd, estimated: cost?.estimated },
        }));
      }
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
    const target = /^\/(edit|remix)(\s|$)/i.test(text) ? imageTarget?.id : undefined;
    setImageTarget(null);
    await runSend(text, { imageId: target });
    void drainQueue();
  };

  /** Hover actions on a generated picture in a bubble. */
  const onImageAction = (action: string, id: string, alt: string) => {
    if (action === "more") {
      if (streamingRef.current) return;
      void runSend("/more", { imageId: id }).then(() => drainQueue());
      return;
    }
    const cmd = action === "remix" ? "/remix " : "/edit ";
    setDraft(cmd);
    setImageTarget({ id, alt });
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(cmd.length, cmd.length);
    });
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
        // Own compositing layer: messages scroll over it without repainting the photo.
        <div className="absolute inset-0 transform-gpu" aria-hidden>
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
              <Settings2 size={11} /> {settings.provider === "local" ? "Set up local server" : "Add API key"}
            </button>
          )}
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
      <div ref={scrollRef} className="@container relative z-10 flex-1 overflow-y-auto">
        {messages.length === 0 && streaming === null ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent">
              <BrewIcon size={18} strokeWidth={1.8} className="text-accent-ink" />
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
              <Bubble
                key={m.id}
                role={m.role}
                content={m.content}
                items={catalog}
                usage={showDetails ? usageByMsg[m.id] : undefined}
                onImageAction={streaming === null ? onImageAction : undefined}
                savedToSources={savedTexts.has(m.content)}
                onSaveToSources={
                  m.role === "assistant" && m.content.trim()
                    ? () => onAddNote(m.content, replySourceTitle(m.content)).then(() => {})
                    : undefined
                }
              />
            ))}
            {streaming !== null && (
              <div
                className={`anim-fade-up mb-5 flex justify-start ${streamingHtml.includes("<table") ? WIDE_REPLY : ""}`}
              >
                <div
                  className={`${streamingHtml.includes("<table") ? "w-full" : "max-w-[85%]"} min-w-0 rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed`}
                >
                  {streaming ? (
                    <div
                      className="md"
                      dangerouslySetInnerHTML={{ __html: streamingHtml }}
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
          {imageTarget && (
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11.5px] text-ink-3">
              <ImagePlus size={12} strokeWidth={1.8} className="shrink-0" />
              <span className="min-w-0 truncate">
                {/^\/remix/i.test(draft) ? "Remixing" : "Editing"}: {imageTarget.alt}
              </span>
              <button
                onClick={() => setImageTarget(null)}
                className="shrink-0 text-ink-3 transition-colors hover:text-ink"
                title="Use the latest picture instead"
              >
                ×
              </button>
            </div>
          )}
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
                    {(() => {
                      const Icon =
                        modelQuery.kind === "image"
                          ? Image
                          : modelQuery.kind === "research"
                            ? Telescope
                            : modelQuery.kind === "chat"
                              ? Settings2
                              : AudioLines;
                      return <Icon size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />;
                    })()}
                    <span
                      className={`min-w-0 flex-1 truncate text-[12.5px] ${modelQuery.kind.startsWith("voice") ? "" : "font-mono"}`}
                    >
                      {m}
                    </span>
                    {!modelQuery.remove && pickerCurrent(modelQuery.kind, m) && (
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                        current
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                {modelQuery.remove
                  ? `↑↓ navigate · Enter to pick the ${modelQuery.kind === "voice" ? "voice" : "model"} to remove · Esc to dismiss`
                  : modelQuery.kind.startsWith("voice")
                    ? "↑↓ navigate · Enter to pick · Esc to dismiss · /voice swap · /voice add <name> · /voice remove <name>"
                    : `↑↓ navigate · Enter to pick · Esc to dismiss · ${PICKER_CMD[modelQuery.kind]} add <id> · ${PICKER_CMD[modelQuery.kind]} remove <id>`}
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
          {/* /font suggestions */}
          {fontQuery !== null && fontHits.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {fontHits.map((f, i) => (
                  <button
                    key={f.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptFont(f.name);
                    }}
                    onMouseEnter={() => setFontQuery((q) => (q ? { ...q, active: i } : q))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      i === fontActiveIdx ? "bg-hover" : ""
                    }`}
                  >
                    <span className="shrink-0 text-[13px] font-medium" style={{ fontFamily: f.stack }}>
                      {f.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" style={{ fontFamily: f.stack }}>
                      The quick brown fox jumps over the lazy dog
                    </span>
                    {font === f.id && (
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
                // Theme/font match exact `/theme(s)` / `/font(s)` (+ args), so they
                // take priority over the generic palette — bare tokens open their
                // full pickers (all themes / all fonts) immediately.
                const th = mv === null ? detectTheme(e.target.value) : null;
                const ft = mv === null && th === null ? detectFont(e.target.value) : null;
                const cmd = mv === null && th === null && ft === null ? detectCommand(e.target.value) : null;
                const md = mv === null && th === null && ft === null && cmd === null ? detectModel(e.target.value) : null;
                setCmdQuery(null);
                setMoveQuery(null);
                setThemeQuery(null);
                setFontQuery(null);
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
                } else if (ft !== null) {
                  setFontQuery({ query: ft, active: 0 });
                  setMention(null);
                } else if (md !== null) {
                  setModelQuery({ query: md.query, active: 0, remove: md.remove, kind: md.kind });
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
                if (fontQuery !== null) {
                  const count = fontHits.length;
                  if (e.key === "ArrowDown" && count > 0) {
                    e.preventDefault();
                    setFontQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) + 1) % count });
                    return;
                  }
                  if (e.key === "ArrowUp" && count > 0) {
                    e.preventDefault();
                    setFontQuery((q) => q && { ...q, active: (Math.min(q.active, count - 1) - 1 + count) % count });
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && count > 0) {
                    e.preventDefault();
                    acceptFont(fontHits[fontActiveIdx].name);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setFontQuery(null);
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
              className="max-h-80 flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-[14px] outline-none placeholder:text-ink-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            {model} · {settings.provider === "local" ? "on your computer" : `via ${settings.provider === "openrouter" ? "OpenRouter" : settings.provider}`}
            {(notebookGrounded ?? 1) === 0 && (
              <span className="text-warn"> · grounding off</span>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

/** Usage line data: token counts plus the reply's cost (estimated = price table). */
type ReplyUsage = StreamUsage & { estimated?: boolean };

/** Token counts rendered compactly: 1234 → "1.2k". */
function fmtTokens(n: number | undefined): string | null {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * A reply holding a table is centred on the chat column but may grow past it,
 * up to 60rem or the panel's width (minus its side padding), whichever is less.
 */
const WIDE_REPLY = "relative left-1/2 w-[min(60rem,calc(100cqw-2.5rem))] -translate-x-1/2";

/** Source title for a saved reply: its first heading or line, markdown stripped. */
function replySourceTitle(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? "";
  const flat = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^(#{1,6}|[-*+>]|\d+\.)\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "Chat reply";
  return flat.length > 60 ? flat.slice(0, 60).trimEnd() + "…" : flat;
}

function Bubble({
  role,
  content,
  items,
  usage,
  onImageAction,
  savedToSources,
  onSaveToSources,
}: {
  role: "user" | "assistant";
  content: string;
  items: MentionItem[];
  usage?: ReplyUsage;
  /** Edit / Remix / More like this on a library picture (absent while busy). */
  onImageAction?: (action: string, id: string, alt: string) => void;
  /** This reply's text is already a source in the notebook. */
  savedToSources?: boolean;
  /** Save this reply as a text source (assistant replies only). */
  onSaveToSources?: () => Promise<void>;
}) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const segments = useMemo(
    () => (role === "user" ? segmentMentions(content, items) : []),
    [role, content, items]
  );
  // Library image URLs resolve async; bump re-renders once they're known.
  const [imgTick, setImgTick] = useState(0);
  useEffect(() => {
    const pending = unresolvedImageIds(content);
    if (pending.length === 0) return;
    let live = true;
    Promise.all(pending.map(libraryImageUrl)).then(() => live && setImgTick((t) => t + 1));
    return () => {
      live = false;
    };
  }, [content]);
  const html = useMemo(
    () => (role === "assistant" ? withLibraryImages(renderMarkdown(content)) : ""),
    [role, content, imgTick] // imgTick: re-run once library URLs resolve
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
  const hasTable = html.includes("<table");
  const save = async () => {
    if (!onSaveToSources || savedToSources || saveState === "saving") return;
    setSaveState("saving");
    try {
      await onSaveToSources();
      setSaveState("idle");
    } catch {
      setSaveState("error");
    }
  };
  return (
    <div className={`anim-fade-up group mb-5 flex flex-col items-start ${hasTable ? WIDE_REPLY : ""}`}>
      {/* Tables spread past the chat column; other replies keep the 85% bubble. */}
      <div
        className={`${hasTable ? "w-full" : "max-w-[85%]"} min-w-0 rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed`}
      >
        <div
          className={`md${onImageAction ? "" : " img-actions-off"}`}
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-img-action]");
            if (!btn || !onImageAction) return;
            const id = btn.dataset.imgId!;
            const alt = btn.closest(".brewimg-wrap")?.querySelector("img")?.getAttribute("alt") ?? "";
            onImageAction(btn.dataset.imgAction!, id, alt);
          }}
        />
        {usage && (
          <div className="mt-2 border-t border-edge-soft pt-1.5 text-[10.5px] text-ink-3">
            {[
              fmtTokens(usage.input) && `${fmtTokens(usage.input)} in`,
              fmtTokens(usage.output) && `${fmtTokens(usage.output)} out`,
              fmtTokens(usage.cachedRead) && `${fmtTokens(usage.cachedRead)} cache hit`,
              usage.costUsd != null && `${usage.estimated ? "~" : ""}${fmtReplyCost(usage.costUsd)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
      {onSaveToSources && (
        <button
          onClick={save}
          disabled={savedToSources || saveState === "saving"}
          title={
            savedToSources
              ? "Saved in your Sources"
              : saveState === "error"
                ? "Couldn't save — click to try again"
                : "Save this reply to Sources"
          }
          aria-label={savedToSources ? "Saved to Sources" : "Save to Sources"}
          className={`mt-1 ml-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-all ${
            savedToSources
              ? "text-ok"
              : saveState === "error"
                ? "text-danger"
                : "text-ink-3 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          }`}
        >
          {savedToSources ? (
            <Check size={12} strokeWidth={2.2} />
          ) : saveState === "saving" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <FilePlus2 size={12} strokeWidth={1.8} />
          )}
          {savedToSources ? "Saved to Sources" : saveState === "error" ? "Couldn't save" : "Save to Sources"}
        </button>
      )}
    </div>
  );
}
