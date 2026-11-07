import {
  AlignLeft,
  Anchor,
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  ArrowUpFromLine,
  AudioLines,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderClosed,
  Globe,
  GraduationCap,
  Image,
  ImagePlus,
  Info,
  Landmark,
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
  Route,
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addMessage,
  listFolders,
  listReasoning,
  renameChat,
  setNotebookConstitutionOn,
  setNotebookGrounded,
  setMessageReasoning,
  setNotebookStarred,
  setSetting,
  sourceText,
} from "../lib/db";
import { mediaSrc } from "../lib/blobs";
import { onRemoteChanges } from "../lib/sync";
import { setChatStreaming } from "../lib/busy";
import type { IngestResult } from "../lib/ingest";
import { renderMarkdown } from "../lib/markdown";
import { hydrateMermaid } from "../lib/mermaid";
import {
  buildMentionCatalog,
  resolveMentions,
  segmentMentions,
  type MentionItem,
} from "../lib/mentions";
import { canPrewarm, isAbortError, prewarmCache, streamChat, type LlmMessage, type StreamUsage } from "../lib/llm";
import { aiBlock, AI_TIERS, brewlmModelLabel, costLabel, costVsFast, loadAiConfig, TIER_DESCRIPTIONS } from "../lib/brewlmAi";
import { AiBlockedNotice } from "./settings/BrewLmAi";
import { CLOUD_BUDGET, contextBudget, type ContextBudget } from "../lib/local";
import {
  imageAlt,
  libraryImageUrl,
  storeGeneratedImages,
  stripHistoryImages,
  unresolvedImageIds,
  withLibraryImages,
} from "../lib/genImage";
import { isImageApiModel } from "../lib/imageApi";
import { ensureIndexed, inDocumentOrder, isRetrievable, rankChunks, wholeNotebookFits, type RetrievedChunk } from "../lib/rag";
import { ensureMediaText } from "../lib/media";
import {
  cloneReply,
  constitutionTurn,
  fetchTurn,
  groundReply,
  imageTurn,
  isImageTurn,
  moveTurn,
  parseClone,
  searchTurn,
  starReply,
  stripOuterQuotes,
  SUMMARIZE_PROMPT,
  SUMMARIZE_RE,
} from "../lib/chatTurns";
import {
  parseFetchMessage,
  siteOf,
  stripFetchMarker,
  urlKey,
  type FetchList,
} from "../lib/fetchList";
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
  THINKING_LABELS,
  TTS_PROVIDER_LABELS,
  voiceLabel,
  type Host,
  type SavedVoice,
  type VoiceProvider,
  voicesNeedIds,
} from "../lib/settings";
import { platform } from "../platform";
import { ACCEPT_STRING, fileToCoverDataUrl } from "../lib/source";
import { parseStudioCommand, type StudioCommand } from "../lib/studioCommands";
import { fmtUsageLine, recordUsage, replyCostUsd } from "../lib/usage";
import { runProviderCommand } from "../lib/providerCommand";
import { BrewIcon } from "./BrewIcon";
import { THEMES, chooseTheme } from "../lib/themes";
import { FONTS, chooseFont } from "../lib/fonts";
import type { Artifact, ChatMessage, Folder, Settings, Source, Thinking } from "../lib/types";
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
    desc: "Show or hide token counts and cost on AI replies and Studio outputs",
    icon: Info,
    takesArgs: false,
  },
  ...(["show", "hide"] as const).map((mode) => ({
    cmd: `/thinking ${mode}`,
    usage: `/thinking ${mode}`,
    desc: mode === "show" ? "Open each reply's reasoning by default" : "Keep each reply's reasoning folded",
    icon: Brain,
    takesArgs: false,
  })),
  {
    cmd: "/provider",
    usage: "/provider",
    desc: "Show how OpenRouter picks the provider that runs your model",
    icon: Route,
    takesArgs: false,
  },
  ...(
    [
      ["default", "OpenRouter's default mix, mostly the cheapest provider that's up"],
      ["cheapest", "Cheapest provider first"],
      ["fastest", "Provider that writes fastest first"],
      ["quickest", "Provider that starts answering soonest first"],
      ["private", "Skip providers that may train on your prompts (toggles)"],
      ["zdr", "Zero-data-retention providers only (toggles)"],
      ["unpin", "Clear this model's pinned providers"],
      ["off", "Back to OpenRouter's default routing for this model"],
    ] as const
  ).map(([sub, desc]) => ({ cmd: `/provider ${sub}`, usage: `/provider ${sub}`, desc, icon: Route, takesArgs: false })),
  {
    cmd: "/provider pin",
    usage: "/provider pin <provider>[, <provider>…]",
    desc: "Try these providers first for this model, in order",
    icon: Route,
    takesArgs: true,
  },
  {
    cmd: "/provider only",
    usage: "/provider only <provider>[, <provider>…]",
    desc: "Use only these providers for this model, no fallback",
    icon: Route,
    takesArgs: true,
  },
  {
    cmd: "/provider block",
    usage: "/provider block <provider>",
    desc: "Never use a provider, for any model (/provider unblock undoes)",
    icon: Route,
    takesArgs: true,
  },
  {
    cmd: "/ground",
    usage: "/ground",
    desc: "Toggle source grounding on/off for this notebook",
    icon: Anchor,
    takesArgs: false,
  },
  {
    cmd: "/constitution",
    usage: "/constitution [on|off]",
    desc: "Turn this notebook's constitution on or off (keeps the text)",
    icon: Landmark,
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
    cmd: "/fetch",
    usage: "/fetch <what you want to learn>",
    desc: "Find web sources to learn from — open them, add the ones you want",
    icon: Globe,
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
The **constitution** button adds a persona document — pick a template (Professor, Tutor, Critic…) and edit its text before adding, or choose **Custom** to paste your own. Edit that source anytime — it changes how the AI behaves in this notebook's chat (Studio tools ignore it; they have their own Customize settings) — and use \`/constitution off\` to pause it without deleting it.

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
| Mind map | Interactive map of the key ideas, with definitions — zoom, expand and edit it |
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
- \`/details [on|off]\` — shows or hides the token counts and cost under each AI reply and at the foot of each Studio output (e.g. "9.8k in · 637 out · $0.0042"). The cost is what OpenRouter billed; other providers show an estimate marked "~". Also in Settings → Appearance.
- **Thinking effort** — the brain button beside Send in the chat box picks how hard reasoning models think before answering, app-wide: Auto (each model's own default), Low (faster and cheaper), Medium, or High (slower, better on hard questions). Models that don't reason ignore it, and local models don't show it. When it isn't Auto the button shows the level. Also in Settings → AI Model.
- \`/thinking show\` / \`/thinking hide\` — opens or folds the **Reasoning** above each reply by default (click it to open one either way). Local reasoning models show their full reasoning, Claude and some OpenRouter models a summary; OpenAI's own API shares none. Reasoning stays on this computer: it isn't synced and isn't sent back to the model. Also in Settings → Appearance.
- \`/provider\` — OpenRouter only: shows which providers may run your model and which one answered last. \`/provider cheapest\`, \`fastest\`, \`quickest\` or \`default\` sets the priority for every model; \`/provider private\` skips providers that may train on your prompts and \`/provider zdr\` keeps to zero-data-retention ones (each toggles); \`/provider block <provider>\` never uses one (\`/provider unblock\` undoes). \`/provider pin groq, deepinfra\` tries those first for the current model, \`/provider only groq\` allows nothing else for it, and \`/provider unpin\` clears that. \`/provider off\` goes back to OpenRouter's default for the current model. Also in Settings → AI Model → Provider routing; rules in your OpenRouter account apply too.
- \`/ground\` — toggles **source grounding** for this notebook. Off = free-form answers from the model's own knowledge (no sources sent, no citations, cheaper); @mention a source anytime to pull it into one answer. The state shows in the composer footer and sticks per notebook.
- \`/constitution [on|off]\` — turns this notebook's **constitution** on or off without deleting it. Off = chat replies ignore it until you turn it back on; your text stays in the Sources panel. No argument flips it. Only works once the notebook has a constitution.
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
- \`/mindmap [focus]\` — interactive map of the key ideas.
- \`/audio [deep-dive|brief|debate|critique] [short|standard|long] [focus]\` — two-host podcast, e.g. \`/audio debate short\`. Short ≈ 5 minutes, Standard ≈ 10, Long ≈ 20; longer episodes are planned first and written part by part, so they take a little longer to make.
- \`/report [summary|study-guide|briefing|faq|timeline|analysis|custom <instructions>]\` — grounded markdown documents.
- \`/research <topic>\` — plans searches, reads the web, writes a cited report (imported pages become sources).
- \`/fetch <what you want to learn>\` — searches the web for sources to learn from and lists them as cards, e.g. \`/fetch "Attention Is All You Need"\`. Click a title to open it in your browser, **Add** to save it to Sources (or **Add all**); anything you don't add is ignored. Uses your Research model's web search, billed per query.
- \`/search <query>\` — one-shot web answer, right here in chat, with numbered source links. Your provider bills web searches per query, so this only runs when you ask; for a deep multi-source dossier use \`/research\` instead.
- \`/image [ratio] <prompt>\` — generates a picture with your **Image model** (Settings → AI Model), e.g. \`/image 16:9 a watercolor fox in snow\`. Only your prompt is sent — no sources or chat history — so you pay just for the image (about $0.03 with the default model). Needs an OpenRouter key. Later chat turns see a one-line description of the image, never the pixels. If your selected model is itself an image model (e.g. via \`/model qwen/qwen-image-2.1-turbo\`), \`/image\` uses it, and plain messages generate images too — a message right after a picture edits that picture (start with \`/image\` for a fresh one).
- \`/edit <change>\` — changes the latest picture, e.g. \`/edit make the sky stormy\`. \`/remix <idea>\` makes a new picture inspired by it, and \`/more\` reruns its prompt for another take. Hover any generated picture for **Edit**, **Remix** and **More like this** on that specific one. Only that single picture (downscaled) and your words are sent — never the chat or sources. Editing needs an image model that accepts a reference picture; BrewLM tells you if yours can't.
AI Studio results are saved as artifacts in the Studio panel (right) — reopen, download, or add them back as sources from there. No arguments = the same defaults as clicking the tool card. Queued AI actions consume tokens when they run.

## Privacy
API keys, sources, chats and artifacts all live in a local database on your machine. No account, no cloud sync. Organizing works offline; only AI calls need a network.`;


/* ------------------------------ cache warming ------------------------------ */

/** Below this, a stable prompt is too small for a cold read to be noticeably slow. */
const PREWARM_MIN_CHARS = 8000;
/** The provider cache lives 5 minutes from a request's start; re-warm a little before. */
const WARM_FOR_MS = 4.5 * 60_000;
/** When a stable prompt last went to the provider (warm-up or real), by provider, model and content. */
const warmedAt = new Map<string, number>();

function warmKey(s: Pick<Settings, "provider" | "model">, stable: string): string {
  // FNV-1a: a fingerprint of the prompt, cheap even for a 200k-character notebook.
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) h = Math.imul(h ^ stable.charCodeAt(i), 0x01000193);
  return `${s.provider}:${s.model}:${stable.length}:${(h >>> 0).toString(36)}`;
}

/** A real request just sent this prompt, which warms (or refreshes) the cache too. */
function markWarm(s: Pick<Settings, "provider" | "model">, stable: string) {
  warmedAt.set(warmKey(s, stable), Date.now());
}

/** True (and recorded) when this prompt hasn't been sent in the cache's lifetime. */
function claimWarm(s: Pick<Settings, "provider" | "model">, stable: string): boolean {
  const key = warmKey(s, stable);
  const last = warmedAt.get(key);
  if (last !== undefined && Date.now() - last < WARM_FOR_MS) return false;
  warmedAt.set(key, Date.now());
  return true;
}

interface SystemPromptOpts {
  grounded?: boolean;
  constitution?: boolean;
  budget?: ContextBudget;
  /**
   * The whole notebook fits the sources budget (rag.wholeNotebookFits): send
   * every source's full text, oldest first, instead of `retrieved` excerpts.
   */
  whole?: boolean;
}

/** The system prompt as one string (one-off requests: /search, Studio). */
export function buildSystemPrompt(
  sources: Source[],
  mentioned: MentionItem[] = [],
  retrieved?: RetrievedChunk[],
  opts: SystemPromptOpts = {}
): string {
  const { stable, volatile } = buildSystemParts(sources, mentioned, retrieved, opts);
  return volatile ? `${stable}\n\n${volatile}` : stable;
}

/**
 * Assemble the system prompt in two parts, for provider prompt caching.
 * `stable` (persona, constitution, rules, and the sources when they don't
 * depend on the message) is byte-identical across turns and new chats as long
 * as the notebook doesn't change; it carries the cache breakpoint. `volatile`
 * (per-message excerpts, @-mentions) follows it, so it never invalidates the
 * expensive prefix.
 *
 * Sources: with `opts.whole`, the full text of every source. Otherwise, when
 * `retrieved` chunks are supplied (rag.ts), the most relevant slices of ALL
 * sources for this message — this is what lets a 400-page PDF or a notebook
 * full of files fit the context budget meaningfully (200k chars on cloud
 * models, sized to the context window on local ones). With neither, a
 * first-N-characters prefix of each source.
 */
export function buildSystemParts(
  sources: Source[],
  mentioned: MentionItem[] = [],
  retrieved?: RetrievedChunk[],
  opts: SystemPromptOpts = {}
): { stable: string; volatile: string } {
  const grounded = opts.grounded !== false;
  const whole = grounded && opts.whole === true;
  const budgetCaps = opts.budget ?? CLOUD_BUDGET;
  // /constitution off: the source stays in the notebook, but no prompt sees it.
  const constitutions = opts.constitution === false
    ? []
    : sources.filter((s) => s.type === "context" && s.content.trim());
  // Mentioned sources move into the priority section — don't include twice.
  const mentionedSourceIds = new Set(
    mentioned.filter((m) => m.group === "source").map((m) => m.id)
  );
  // Ungrounded: no source material is ever sent — zero source tokens, zero
  // retrieval cost; @-mentions (below) remain as the user's explicit override.
  // Whole notebook: mentioned sources stay in the stable block (their text is
  // already there; pulling them out would change the cached prefix).
  const knowledge = grounded
    ? sources.filter(
        (s) => isRetrievable(s) && (whole || !mentionedSourceIds.has(s.id))
      )
    : [];
  const inKnowledge = new Set(knowledge.map((s) => s.id));

  const parts: string[] = ["You are BrewLM, a thoughtful study assistant."];
  /** Per-message sections, after the cache breakpoint. */
  const tail: string[] = [];

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
    /** Excerpts depend on the message, so they go after the breakpoint. */
    let perMessage = false;

    if (whole) {
      const sections = inDocumentOrder(knowledge).map((s) => `### ${s.title} (${s.type})\n${sourceText(s)}`);
      section = `# Sources (complete)\nThe full text of every source in this notebook, oldest first.\n\n${sections.join("\n\n---\n\n")}\n\n[Coverage: the full text of every source is included here.]`;
    } else if (retrieved && retrieved.length > 0) {
      perMessage = true;
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
    // Where each link source came from, so "what does the link point to?"
    // has an answer even when none of that page's text was picked.
    const links = knowledge.filter((s) => s.type === "link" && s.mime).slice(0, 20);
    let linkList = "";
    if (links.length > 0) {
      const line = (s: Source) => {
        const t = s.title.replace(/\s+/g, " ").trim();
        return `- ${t.length > 100 ? t.slice(0, 100) + "…" : t} — ${s.mime}`;
      };
      linkList = `[Link sources and their addresses:\n${links.map(line).join("\n")}]`;
    }
    if (perMessage) {
      if (linkList) parts.push(linkList);
      tail.push(section);
    } else {
      parts.push(linkList ? `${section}\n\n${linkList}` : section);
    }
  }

  // @-mentions tail the prompt: they vary per message, and anything before
  // them stays byte-stable for provider prompt caching.
  if (mentioned.length > 0) {
    let budget = budgetCaps.mentions;
    const sections: string[] = [];
    for (const m of mentioned) {
      if (budget <= 0) break;
      const cap = Math.min(MAX_MENTION_CHARS, budget);
      // Its full text is already in the sources above: point at it, don't repeat it.
      const body = whole && m.group === "source" && inKnowledge.has(m.id)
        ? "[Its full text is in the Sources section above.]"
        : m.text
        ? m.text.length > cap
          ? m.text.slice(0, cap) + "\n[…truncated]"
          : m.text
        : "[No readable text — this is a binary/media file; acknowledge it by title, but don't invent its contents.]";
      sections.push(
        `### @${m.title} (${m.group === "source" ? "Source" : "Output"} · ${m.type})\n${body}`
      );
      budget -= body.length;
    }
    tail.push(
      `# @-mentioned materials — PRIORITY\nThe user pointed at these with @, so focus on them and cite them by title:\n\n${sections.join("\n\n")}`
    );
  }

  if (grounded && knowledge.length === 0 && mentioned.length === 0) {
    parts.push(
      "The user has not added any knowledge sources yet — encourage them to add sources, or answer simple questions generally."
    );
  }

  return { stable: parts.join("\n\n"), volatile: tail.join("\n\n") };
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
    const size = stripFetchMarker(stripHistoryImages(m.content)).length;
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
  notebookConstitutionOn,
  chatBg,
  chatBgDim,
  onChatBgChange,
  onShowChats,
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
  /** Live /constitution flag (SQLite boolean, default 1); 0 = constitution kept but ignored. */
  notebookConstitutionOn?: number;
  /** Data-URL image behind the chat area ("" = none). */
  chatBg: string;
  /** Readability scrim over chatBg: 0–80 (percent). */
  chatBgDim: number;
  /** Set/clear (bg="") the chat background and/or its dim strength. */
  onChatBgChange: (bg: string, dim: number) => void | Promise<void>;
  /** Phones: the chat list is a sheet; the title opens it and a new-chat button sits beside it. */
  onShowChats?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  /** Picture a hover Edit/Remix picked for the /edit or /remix being typed. */
  const [imageTarget, setImageTarget] = useState<{ id: string; alt: string } | null>(null);
  // The pick lasts only while the draft is still that command.
  useEffect(() => {
    if (imageTarget && !/^\/(edit|remix)(\s|$)/i.test(draft)) setImageTarget(null);
  }, [draft, imageTarget]);
  /** The chat on screen now; closures from an earlier render compare their own chatId to it. */
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  /** Live reply text per chat: a reply keeps streaming into its own thread after the user switches away. */
  const [streams, setStreams] = useState<Record<string, string>>({});
  const streaming = chatId ? (streams[chatId] ?? null) : null;
  /** Bound to this render's chat, so a send started in one thread never shows up in another. */
  const setStreaming = (text: string | null) => {
    if (!chatId) return;
    const id = chatId;
    setStreams((prev) => {
      const { [id]: _, ...rest } = prev;
      return text === null ? rest : { ...rest, [id]: text };
    });
  };
  /** Live reasoning per chat, beside `streams` ("" = none yet). */
  const [thoughts, setThoughts] = useState<Record<string, string>>({});
  const streamingReasoning = chatId ? (thoughts[chatId] ?? "") : "";
  const setStreamingReasoning = (text: string) => {
    if (!chatId) return;
    const id = chatId;
    setThoughts((prev) => {
      const { [id]: _, ...rest } = prev;
      return text ? { ...rest, [id]: text } : rest;
    });
  };
  const anyStreaming = Object.keys(streams).length > 0;
  // The tab strip's busy dot; a closed tab stops counting.
  useEffect(() => setChatStreaming(notebookId, anyStreaming), [notebookId, anyStreaming]);
  useEffect(() => () => setChatStreaming(notebookId, false), [notebookId]);
  const [error, setErrorState] = useState<string | null>(null);
  /** Errors from a send in another chat stay out of the open one. */
  const setError = (e: string | null) => {
    if (chatId === chatIdRef.current) setErrorState(e);
  };
  /** Provider-reported token usage per assistant message (this session only). */
  const [usageByMsg, setUsageByMsg] = useState<Record<string, ReplyUsage>>({});
  // Mirror of settings.showDetails so /details flips the usage lines instantly.
  const [showDetails, setShowDetails] = useState(settings.showDetails);
  useEffect(() => setShowDetails(settings.showDetails), [settings.showDetails]);
  /** Reasoning saved with each reply of the open chat, by message id. */
  const [reasoningByMsg, setReasoningByMsg] = useState<Record<string, string>>({});
  // Mirror of settings.showReasoning so /thinking show|hide applies instantly.
  const [showReasoning, setShowReasoning] = useState(settings.showReasoning);
  useEffect(() => setShowReasoning(settings.showReasoning), [settings.showReasoning]);
  // Mirror of settings.thinking so the composer's brain button updates instantly.
  const [thinking, setThinking] = useState(settings.thinking);
  useEffect(() => setThinking(settings.thinking), [settings.thinking]);
  // Phone-width screens get a short placeholder so it fits on one line
  // (a wrapped placeholder makes the empty chat box two lines tall).
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  /** The composer's thinking-effort menu is open. */
  const [thinkingMenu, setThinkingMenu] = useState(false);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thinkingMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!thinkingMenuRef.current?.contains(e.target as Node)) setThinkingMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThinkingMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [thinkingMenu]);
  const pickThinking = async (level: Thinking) => {
    setThinkingMenu(false);
    setThinking(level);
    await setSetting("thinking", level);
    onSettingsChanged();
    textareaRef.current?.focus();
  };
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
      const picked = await platform.pickFile({
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
      });
      if (!picked) return;
      const file = new File([picked.bytes as BlobPart], picked.name, { type: "image/*" });
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

  // Re-fit the composer whenever the draft changes from anywhere — notably
  // setDraft("") on send, which otherwise leaves the box at its old height.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta) autoSize(ta);
  }, [draft]);

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

  /** Pasted images (screenshots, "Copy image") ride the same path as dropped files. */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    // Office/Pages copies carry the text plus a rendered picture of it — paste the text.
    // Finder copies carry the file names as text, which still counts as an image paste.
    const text = e.clipboardData.getData("text/plain").trim();
    if (text && !images.some((f) => text.includes(f.name))) return;
    e.preventDefault();
    // Clipboard images all arrive as "image.png" — give each a distinct, mentionable title.
    const stamp = new Date().toLocaleString("sv-SE").replace(/:/g, ".");
    const named = images.map((f, i) => {
      if (!/^image\.\w+$/i.test(f.name)) return f;
      const ext = f.name.split(".").pop();
      const suffix = images.length > 1 ? ` (${i + 1})` : "";
      return new File([f], `Pasted image ${stamp}${suffix}.${ext}`, { type: f.type });
    });
    handleFiles(named);
  };

  const catalog = useMemo(() => buildMentionCatalog(sources, artifacts), [sources, artifacts]);
  /** Text sources' bodies — a reply already saved to Sources shows as saved. */
  const savedTexts = useMemo(
    () => new Set(sources.filter((s) => s.type === "text").map((s) => s.content)),
    [sources]
  );
  /** Link sources' URLs (stored in `mime`) — a /fetch card already added shows as added. */
  const linkKeys = useMemo(
    () => new Set(sources.filter((s) => s.type === "link" && s.mime).map((s) => urlKey(s.mime!))),
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

  /** /thinking show|hide — open or fold the reasoning above replies (app-wide, no LLM). Effort lives on the composer's brain button. */
  const runThinkingCommand = async (text: string): Promise<void> => {
    const arg = text.replace(/^\/thinking\s*/i, "").trim().toLowerCase();
    if (arg === "show" || arg === "hide") {
      const on = arg === "show";
      await setSetting("showReasoning", on ? "1" : "0");
      setShowReasoning(on);
      onSettingsChanged();
      const shared = {
        local: "",
        brewlm: "Claude shares a summary of its thinking, not the full reasoning.",
        anthropic: "Claude shares a summary of its thinking, not the full reasoning.",
        openrouter: "On OpenRouter, models that share their reasoning show it; some, like OpenAI's, send only a summary or nothing.",
        openai: "OpenAI's API doesn't share its models' reasoning, so replies from it won't have any.",
      }[settings.provider];
      return say(
        on
          ? `Reasoning now opens above each reply.${shared ? ` ${shared}` : ""}`
          : "Reasoning now stays folded above each reply; click **Reasoning** to open one."
      );
    }
    const effort = settings.provider === "local" ? "" : ` Thinking effort is **${THINKING_LABELS[thinking]}**; change it with the brain button beside Send.`;
    return say(
      `Reasoning above replies is ${showReasoning ? "open (\`/thinking hide\` folds it)" : "folded (\`/thinking show\` opens it)"}.${effort}`
    );
  };

  /** Execute /model locally (no LLM) — swap the model and persist it. */
  const runModelCommand = async (text: string): Promise<void> => {
    if (settings.provider === "brewlm") return say(await brewlmModelCommand(text));
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

  /** BrewLM AI's /model: its three tiers, by name. */
  const brewlmModelCommand = async (text: string): Promise<string> => {
    const c = await loadAiConfig();
    const arg = text.replace(/^\/model\s*/i, "").trim().toLowerCase();
    const tiers = AI_TIERS.map((t) => `\`${t}\``).join(", ");
    const more = c.more ?? [];
    if (!arg)
      return `BrewLM AI is on **${brewlmModelLabel(model)}**. Switch with \`/model fast\`, \`/model smart\` or \`/model best\`${
        more.length ? `, or a model from Settings → AI Model → More models (${more.map((m) => m.label).join(", ")})` : ""
      }.`;
    const tier = AI_TIERS.find((t) => t === arg || c.tiers[t].label.toLowerCase() === arg || c.tiers[t].model === arg);
    const extra = tier ? null : more.find((m) => m.label.toLowerCase() === arg || m.model === arg);
    if (!tier && !extra)
      return `BrewLM AI runs ${tiers}${more.length ? " and the models under Settings → AI Model → More models" : ""}. To use any other model, pick OpenRouter, OpenAI or Anthropic with your own key in **Settings → AI Model**.`;
    const id = tier ? c.tiers[tier].model : extra!.model;
    await setSetting("model", id);
    setModel(id);
    onSettingsChanged();
    // Warn when a model eats the allowance much faster than Fast.
    const ratio = await costVsFast(id);
    const cost = ratio && ratio >= 1.5 ? ` Each chat uses ${costLabel(ratio).replace(/ Fast$/, "")} as much of your allowance as one on Fast.` : "";
    return `BrewLM AI switched to **${brewlmModelLabel(id)}**.${tier ? ` ${TIER_DESCRIPTIONS[tier]}` : ""}${cost}`;
  };

  /** /imagemodel — show, switch or edit the model /image draws with (no LLM). */
  const runImageModelCommand = async (text: string): Promise<void> => {
    if (settings.provider === "brewlm")
      return say("BrewLM AI draws pictures with its own image model. To pick one yourself, use your own OpenRouter key in **Settings → AI Model**.");
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
    if (provider === "brewlm")
      return say("BrewLM AI runs research on its own research model, whatever chat uses. To pick one yourself, use your own key in **Settings → AI Model**.");
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
    const r = await moveTurn(text, { id: notebookId, title: notebookTitle, folderId: notebookFolderId });
    if (!r) return false;
    if (r.moved) onNotebookMoved();
    const replyMsg = await addMessage(chatId as string, notebookId, "assistant", r.reply);
    setMsgs((prev) => [...prev, replyMsg]);
    return true;
  };

  // Messages pulled from another device (BrewLM Sync) — never mid-reply.
  useEffect(() => {
    if (!chatId || streaming !== null) return;
    return onRemoteChanges((c) => {
      if (!c.tables.has("messages") || !c.chatIds.has(chatId)) return;
      void import("../lib/db").then(({ listMessages }) => listMessages(chatId).then(setMsgs));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, streaming]);

  useEffect(() => {
    if (!chatId) {
      setMsgs([]);
      setUsageByMsg({});
      setReasoningByMsg({});
      return;
    }
    let cancelled = false;
    setUsageByMsg({});
    setReasoningByMsg({});
    import("../lib/db").then(({ listMessages }) =>
      // setMsgs matters, not setMessages: messagesRef must follow the switch,
      // or the next send resurrects the previous chat's history.
      listMessages(chatId).then((ms) => {
        if (!cancelled) setMsgs(ms);
      })
    );
    listReasoning(chatId).then((r) => {
      if (!cancelled) setReasoningByMsg(r);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /* ------------------------------ /queue state ------------------------------ */

  /** FIFO of queued prompts/commands. Ref mirrors state for drain loops. */
  const queueRef = useRef<string[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  /** Chats with a reply in flight — mirrors `streams` synchronously so chained sends aren't blocked by a stale closure. */
  const streamingRef = useRef(new Set<string>());
  /** Chats whose queue is draining. */
  const drainingRef = useRef(new Set<string>());
  /** Controllers for in-flight LLM streams, by chat; the stop button aborts the open chat's. */
  const abortRef = useRef(new Map<string, AbortController>());
  /** Latest messages — drainQueue needs fresh history, not the stale render closure. */
  const messagesRef = useRef<ChatMessage[]>([]);

  /**
   * Update messages state AND the ref atomically (value or updater form).
   * A reply landing after the user switched chats is dropped here: it's
   * already saved, and its thread loads it from the database on return.
   */
  const setMsgs = (
    next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
  ) => {
    if (chatId !== chatIdRef.current) return;
    messagesRef.current =
      typeof next === "function" ? next(messagesRef.current) : next;
    setMessages(messagesRef.current);
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

  /* ------------------------------ scroll follow ------------------------------ */

  /** Follow new output only while the reader sits at the bottom; any scroll up lets go. */
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  /** The thread's content box: its size changes drive the follow. */
  const threadRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  const hasThread = messages.length > 0 || streaming !== null;
  /** Replies that were streamed in: they replace the live text without an entrance fade. */
  const streamedIdsRef = useRef(new Set<string>());

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const onScroll = () => {
      const g = gap();
      const top = el.scrollTop;
      // Moving up lets go; reaching (or heading down into) the bottom re-pins.
      if (g < 2) stickRef.current = true;
      else if (top < lastTopRef.current - 1) stickRef.current = false;
      else if (g < 24) stickRef.current = true;
      lastTopRef.current = top;
      setShowJump(g > 240);
    };
    // Intent arrives before the scroll lands — let go now, or the next token's
    // follow would undo it (the "locked" feeling while a reply streams).
    const release = () => {
      stickRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") release();
    };
    // A press on the scroller itself is its scrollbar.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === el) release();
    };
    const onPointerUp = () => {
      if (gap() < 2) stickRef.current = true;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  // Streaming text, images loading, mermaid hydrating, the composer growing:
  // whatever changes the layout, stay at the bottom if that's where the reader is.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const thread = threadRef.current;
    if (!el || !thread) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) {
        el.scrollTop = el.scrollHeight;
        lastTopRef.current = el.scrollTop;
      }
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
    });
    ro.observe(thread);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasThread]);

  // Sending (or opening another chat) jumps to the latest, even from far up.
  const seenRef = useRef<{ chatId: string | null; count: number }>({ chatId: null, count: 0 });
  useLayoutEffect(() => {
    const seen = seenRef.current;
    const added = messages.length > seen.count && messages[messages.length - 1]?.role === "user";
    if (seen.chatId !== chatId || added) scrollToBottom();
    seenRef.current = { chatId, count: messages.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chatId]);

  // Render ```mermaid diagrams once streaming settles (mid-stream they stay code).
  useEffect(() => {
    if (streaming === null) void hydrateMermaid(scrollRef.current);
  }, [streaming, messages]);

  const keyed = activeKey(settings);

  /**
   * The user started typing: write the notebook's stable prompt (rules and
   * every source) into the provider's prompt cache now, so the reply starts
   * without first reading the whole notebook. Only for notebooks that go whole
   * (the prompt can't depend on the message), on providers with explicit
   * caches, and at most once per cache lifetime; a real message refreshes it too.
   */
  const prewarmCheckedAt = useRef(0);
  const prewarm = (text: string) => {
    if (!text.trim() || text.trimStart().startsWith("/") || !keyed) return;
    if (!canPrewarm(settings.provider, settings.model)) return;
    // Building and fingerprinting a big notebook's prompt isn't free: not on every keystroke.
    if (Date.now() - prewarmCheckedAt.current < 15_000) return;
    prewarmCheckedAt.current = Date.now();
    const grounded = (notebookGrounded ?? 1) !== 0;
    if (!grounded || !wholeNotebookFits(sources, contextBudget(settings).sources)) return;
    const { stable } = buildSystemParts(sources, [], undefined, {
      grounded,
      constitution: (notebookConstitutionOn ?? 1) !== 0,
      budget: contextBudget(settings),
      whole: true,
    });
    if (stable.length < PREWARM_MIN_CHARS || !claimWarm(settings, stable)) return;
    const { provider, model } = settings;
    void prewarmCache({
      provider,
      apiKey: keyed,
      model,
      messages: [{ role: "system", content: stable }],
      temperature: settings.temperature ?? undefined,
      thinking: settings.thinking,
      maxOutput: settings.maxOutput,
      cacheKey: notebookId,
    }).then((u) => {
      if (!u) return;
      void recordUsage("chat", provider, model, u);
      console.info(`[chat timing] cache warmed: write ${u.cachedWrite ?? 0}, read ${u.cachedRead ?? 0} tokens`);
    });
  };

  /**
   * Send one payload end-to-end (command or chat message). The /queue drain
   * loop calls this in sequence; `streamingRef` mirrors the LLM busy state
   * synchronously so a chained runSend never hits a stale-closure block.
   */
  const runSend = async (text: string, opts?: { imageId?: string }): Promise<void> => {
    if (!text || !chatId || streamingRef.current.has(chatId)) return;
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
      const parsed = parseClone(text);
      let reply: string;
      if (typeof parsed === "string") {
        reply = parsed;
      } else {
        try {
          const name = await onCloneNotebook(parsed.title, parsed.jump);
          reply = cloneReply(notebookTitle, name, parsed.jump);
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
        starReply(notebookTitle, !!notebookStarred)
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
          ? "Response details **on**: token counts and cost show under each AI reply and on Studio outputs. (`/details` toggles this.)"
          : "Response details **off**: replies and Studio outputs show just the content. (`/details` toggles this.)"
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /thinking show|hide — open or fold reasoning above replies (app-wide).
    if (/^\/thinking(\s|$)/i.test(text)) {
      await runThinkingCommand(text);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /provider … — OpenRouter provider routing (app-wide; pins are per model).
    if (/^\/provider(\s|$)/i.test(text)) {
      await say(
        settings.provider === "openrouter"
          ? await runProviderCommand(text, model)
          : `Provider routing is an OpenRouter feature: it picks which company runs a model there. You're on ${PROVIDER_LABELS[settings.provider]}, which runs its own models.`
      );
      onSettingsChanged();
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
        groundReply(next)
      );
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /constitution [on|off] — use or ignore this notebook's constitution (it stays put).
    if (/^\/constitution(\s|$)/i.test(text)) {
      const isOn = (notebookConstitutionOn ?? 1) !== 0;
      const { reply, next } = constitutionTurn(
        text.replace(/^\/constitution\s*/i, ""),
        isOn,
        sources.some((s) => s.type === "context")
      );
      if (next !== null) {
        await setNotebookConstitutionOn(notebookId, next);
        onNotebookMoved();
      }
      const replyMsg = await addMessage(chatId, notebookId, "assistant", reply);
      setMsgs((prev) => [...prev, replyMsg]);
      onChatActivity?.(chatId, isFirst ? text : undefined);
      textareaRef.current?.focus();
      return;
    }

    // Pictures (/image /edit /remix /more, or plain text on an image model):
    // shared with phone chats — see chatTurns.ts.
    if (await isImageTurn(text, settings)) {
      streamingRef.current.add(chatId);
      setStreaming("");
      const ctrl = new AbortController();
      abortRef.current.set(chatId, ctrl);
      try {
        const reply = await imageTurn({ text, history, settings, notebookId, chatId, imageId: opts?.imageId, signal: ctrl.signal });
        await say(reply);
      } catch (e) {
        if (!(isAbortError(e) || ctrl.signal.aborted)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        abortRef.current.delete(chatId);
        streamingRef.current.delete(chatId);
        setStreaming(null);
      }
      const shown = text.replace(/^\/(image|img|edit|remix|more)(?=\s|$)\s*/i, "").replace(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?(\s+|$)/, "");
      onChatActivity?.(chatId, isFirst ? `Image: ${imageAlt(shown || "…")}` : undefined);
      textareaRef.current?.focus();
      return;
    }

    // /fetch <request> — find web sources to learn from; the reply is a list of
    // cards the user opens and adds one by one (provider search, billed per query).
    if (/^\/fetch(\s|$)/i.test(text)) {
      const request = stripOuterQuotes(text.replace(/^\/fetch\s*/i, "").trim());
      streamingRef.current.add(chatId);
      setStreaming("");
      const ctrl = new AbortController();
      abortRef.current.set(chatId, ctrl);
      try {
        await say(await fetchTurn({ request, settings, signal: ctrl.signal }));
      } catch (e) {
        if (!(isAbortError(e) || ctrl.signal.aborted)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        abortRef.current.delete(chatId);
        streamingRef.current.delete(chatId);
        setStreaming(null);
        textareaRef.current?.focus();
      }
      onChatActivity?.(chatId, isFirst ? (request ? `Fetch: ${request}` : text) : undefined);
      return;
    }

    // /search <query> — one-shot web answer with cited links (provider search,
    // billed per query — that's why it's a command, not a background toggle).
    if (/^\/search(\s|$)/i.test(text)) {
      const query = text.replace(/^\/search\s*/i, "").trim();
      streamingRef.current.add(chatId);
      setStreaming("");
      const ctrl = new AbortController();
      abortRef.current.set(chatId, ctrl);
      try {
        await say(
          await searchTurn({
            query,
            settings,
            sources,
            mentioned: resolveMentions(query, catalog),
            grounded: (notebookGrounded ?? 1) !== 0,
            constitution: (notebookConstitutionOn ?? 1) !== 0,
            signal: ctrl.signal,
          })
        );
      } catch (e) {
        if (!(isAbortError(e) || ctrl.signal.aborted)) {
          setError(e instanceof Error ? e.message : String(e));
        }
        // aborted → nothing saved (user pressed stop)
      } finally {
        abortRef.current.delete(chatId);
        streamingRef.current.delete(chatId);
        setStreaming(null);
        textareaRef.current?.focus();
      }
      onChatActivity?.(chatId, isFirst ? (query ? `Search: ${query}` : text) : undefined);
      return;
    }

    // /clear — delete this thread entirely (unlike /new, which saves it).
    if (/^\/clear(\s|$)/i.test(text)) {
      await onClearChat();
      return;
    }

    // /return — exit to the homepage; the chat stays saved in the Chats panel.
    if (/^\/return(\s|$)/i.test(text)) {
      for (const c of abortRef.current.values()) c.abort(); // stop any in-flight generation on the way out
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
    const isSummarize = SUMMARIZE_RE.test(text);

    streamingRef.current.add(chatId);
    setStreaming("");
    const ctrl = new AbortController();
    abortRef.current.set(chatId, ctrl);

    // Mentions from recent user turns keep their priority across follow-ups.
    const mentioned = resolveMentions(
      history
        .filter((m) => m.role === "user")
        .slice(-8)
        .map((m) => m.content)
        .join("\n"),
      catalog
    );

    // Sources. A notebook that fits the budget goes whole (no ranking, and a
    // prompt that stays identical, so it's served from the prompt cache).
    // Otherwise: index any unindexed sources, then fill the budget with the
    // chunks most relevant to this message. Skipped entirely when grounding is
    // off (no embedding calls, no source tokens, no delay). Any failure falls
    // back to legacy truncation inside buildSystemParts.
    const t0 = performance.now();
    const groundedNow = (notebookGrounded ?? 1) !== 0;
    let retrieved: RetrievedChunk[] | undefined;
    let whole = false;
    if (groundedNow) {
      try {
        // Media still lacking a transcript/description gets one first (usually a no-op).
        await ensureMediaText(sources, settings);
        whole = wholeNotebookFits(sources, contextBudget(settings).sources);
        if (whole) {
          // Keep the index current for when the notebook outgrows the budget.
          void ensureIndexed(sources, settings).catch(() => {});
        } else {
          await ensureIndexed(sources, settings);
          const ranked = await rankChunks(sources, text, settings, contextBudget(settings).sources);
          const mentionedIds = new Set(
            mentioned.filter((m) => m.group === "source").map((m) => m.id)
          );
          const filtered = ranked.filter((r) => !mentionedIds.has(r.sourceId));
          if (filtered.length > 0) retrieved = filtered;
        }
      } catch (e) {
        console.warn("rag: retrieval skipped", e);
      }
    }
    const tSources = performance.now();

    const system = buildSystemParts(sources, mentioned, retrieved, { grounded: groundedNow, constitution: (notebookConstitutionOn ?? 1) !== 0, budget: contextBudget(settings), whole });
    markWarm(settings, system.stable);
    const llmMessages: LlmMessage[] = [
      { role: "system", content: system.stable },
      ...(system.volatile ? [{ role: "system" as const, content: system.volatile }] : []),
      ...selectChatHistory(history, contextBudget(settings).history).map((m, i, arr) => ({
        role: m.role,
        // Image embeds in past turns stay on screen but leave the context
        // (multi-hundred-KB base64 re-sent per turn = silent token burn).
        // The visible bubble says "/summarize"; the model gets the real prompt.
        content: stripFetchMarker(stripHistoryImages(
          isSummarize && i === arr.length - 1 && m.role === "user"
            ? SUMMARIZE_PROMPT
            : m.content
        )),
      })),
    ];

    let acc = "";
    let thought = "";
    let usage: StreamUsage | null = null;
    /** When the first answer text arrived (reasoning comes before it). */
    let firstToken: number | null = null;
    /** Keep the reply's reasoning beside it (never in the message, so it isn't sent back). */
    const keepReasoning = async (messageId: string) => {
      if (!thought.trim()) return;
      const text = thought.trim();
      await setMessageReasoning(messageId, text);
      setReasoningByMsg((prev) => ({ ...prev, [messageId]: text }));
    };
    try {
      for await (const delta of streamChat({
        provider: settings.provider,
        apiKey: keyed,
        model: settings.model,
        messages: llmMessages,
        temperature: settings.temperature ?? undefined,
        thinking: settings.thinking,
        maxOutput: settings.maxOutput,
        signal: ctrl.signal,
        cacheKey: notebookId,
        // Per-message excerpts sit before the history and change every turn, so
        // a history breakpoint would never be read back, only pay the write
        // premium on the whole prompt (seen on an 80k-token notebook).
        cacheHistory: !retrieved,
        onUsage: (u) => {
          usage = u;
          void recordUsage("chat", settings.provider, settings.model, u);
          const ms = (t: number) => Math.round(t);
          console.info(
            `[chat timing] sources ${ms(tSources - t0)}ms (${whole ? "whole notebook" : retrieved ? `${retrieved.length} excerpts` : "no excerpts"}), ` +
              `first token ${firstToken === null ? "-" : `${ms(firstToken - tSources)}ms`}, total ${ms(performance.now() - tSources)}ms · ` +
              `input ${u.input ?? "?"} tokens, cache read ${u.cachedRead ?? 0}, cache write ${u.cachedWrite ?? 0}`
          );
        },
        onReasoning: (r) => {
          thought = r;
          setStreamingReasoning(r);
        },
      })) {
        if (firstToken === null) firstToken = performance.now();
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
      await keepReasoning(assistantMsg.id);
      streamedIdsRef.current.add(assistantMsg.id);
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
          await keepReasoning(assistantMsg.id);
          streamedIdsRef.current.add(assistantMsg.id);
          setMsgs((prev) => [...prev, assistantMsg]);
        }
      }
      // aborted → discard the partial answer entirely (user pressed stop)
    } finally {
      abortRef.current.delete(chatId);
      streamingRef.current.delete(chatId);
      setStreaming(null);
      setStreamingReasoning("");
      textareaRef.current?.focus();
    }
    onChatActivity?.(chatId, isFirst ? (isSummarize ? "Notebook summary" : text) : undefined);
  };

  /** Drain the FIFO queue — one payload at a time, continuing after LLM streams. */
  const drainQueue = async () => {
    if (!chatId || drainingRef.current.has(chatId)) return;
    drainingRef.current.add(chatId);
    try {
      // The queue belongs to the open chat; a drain from a chat left behind stops.
      while (chatIdRef.current === chatId && queueRef.current.length > 0 && !streamingRef.current.has(chatId)) {
        const next = queueRef.current.shift()!;
        setQueue([...queueRef.current]);
        // runSend resets streamingRef synchronously when an LLM stream starts,
        // so the loop naturally waits for it before the next item.
        await runSend(next);
      }
    } finally {
      drainingRef.current.delete(chatId);
    }
  };

  /** Stop the open chat's in-flight LLM generation; the partial answer is discarded. */
  const stopGenerating = () => {
    if (chatId) abortRef.current.get(chatId)?.abort();
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
        `Queued **${payload.length > 60 ? payload.slice(0, 60).trimEnd() + "…" : payload}** (position ${pos}).${streamingRef.current.has(chatId) ? " I'll run it when the current task finishes." : ""}`
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
      if (chatId && streamingRef.current.has(chatId)) return;
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
      className="anim-panel-center relative flex h-full min-w-0 flex-1 flex-col bg-canvas"
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
          <img src={mediaSrc(chatBg)} alt="" className="h-full w-full object-cover" />
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
        {onShowChats ? (
          <button
            onClick={onShowChats}
            className="-ml-2 flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-ink-2 active:bg-hover-soft"
            aria-label="Switch chat"
          >
            <span className="truncate">{chatTitle || "Chat"}</span>
            <ChevronDown size={14} className="shrink-0 text-ink-3" />
          </button>
        ) : (
          <span className="truncate text-[12px] font-semibold uppercase tracking-wide text-ink-3">
            Chat{chatTitle ? ` · ${chatTitle}` : ""}
          </span>
        )}
        <div className="flex items-center gap-1">
          {onShowChats && (
            <IconButton onClick={onNewChat} label="New chat">
              <MessageSquarePlus size={15} strokeWidth={1.8} />
            </IconButton>
          )}
          {!keyed && (
            <button
              onClick={onOpenSettings}
              className="mr-1 flex items-center gap-1.5 rounded-full border border-warn-edge bg-warn-bg px-2.5 py-1 text-[11.5px] font-medium text-warn transition-colors hover:opacity-80"
            >
              <Settings2 size={11} /> {settings.provider === "local" ? "Set up local server" : settings.provider === "brewlm" ? "Sign in for BrewLM AI" : "Add API key"}
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
                <div className="anim-menu absolute right-0 z-20 mt-1.5 w-64 rounded-xl border border-edge bg-panel p-3 shadow-lg">
                  <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                    Chat background
                  </p>
                  {chatBg && (
                    <img
                      src={mediaSrc(chatBg)}
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
      {/* No container query on the scroller: WebKit resets its scroll to the top
          when an outside style flips (the composer's placeholder / send button). */}
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto">
        {!hasThread ? (
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
          <div ref={threadRef} className="mx-auto max-w-2xl px-5 py-6">
            {messages.map((m) => (
              <Bubble
                key={m.id}
                animate={!streamedIdsRef.current.has(m.id)}
                role={m.role}
                content={m.content}
                items={catalog}
                usage={showDetails ? usageByMsg[m.id] : undefined}
                reasoning={reasoningByMsg[m.id]}
                reasoningOpen={showReasoning}
                onImageAction={streaming === null ? onImageAction : undefined}
                savedToSources={savedTexts.has(m.content)}
                linkKeys={linkKeys}
                onAddLink={onAddLink}
                onSaveToSources={
                  m.role === "assistant" && m.content.trim()
                    ? () => onAddNote(m.content, replySourceTitle(m.content)).then(() => {})
                    : undefined
                }
              />
            ))}
            {streaming !== null && (
              <div className="anim-fade-up mb-5 w-full min-w-0 text-[13.5px] leading-relaxed">
                {streamingReasoning && (
                  <Reasoning text={streamingReasoning} live={!streaming} defaultOpen={showReasoning} />
                )}
                {streaming ? <StreamingReply text={streaming} /> : !streamingReasoning && <BrewingStatus />}
              </div>
            )}
          </div>
        )}
      </div>

      {error &&
        (aiBlock(error) ? (
          <div className="relative z-10 shrink-0 border-t border-warn-edge bg-warn-bg px-5 py-3">
            <AiBlockedNotice message={error} onOpenSettings={onOpenSettings} />
          </div>
        ) : (
          <div className="relative z-10 shrink-0 border-t border-danger-edge bg-danger-bg px-5 py-2.5 text-[12px] leading-snug text-danger">
            {error}
          </div>
        ))}

      {/* input */}
      <div className="relative z-10 shrink-0 px-5 pb-5 pt-2">
        {/* jump to the latest, shown once the reader has scrolled well up */}
        {showJump && hasThread && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex justify-center">
            <button
              onClick={() => scrollToBottom(true)}
              className="anim-pop pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel text-ink-2 shadow-md transition-colors hover:bg-hover hover:text-ink"
              aria-label="Scroll to latest message"
              title="Scroll to bottom"
            >
              <ArrowDown size={15} strokeWidth={2} />
            </button>
          </div>
        )}
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
                      ref={i === cmdActiveIdx ? keepInView : undefined}
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
                    ref={i === modelActiveIdx ? keepInView : undefined}
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
                    ref={i === themeActiveIdx ? keepInView : undefined}
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
                    ref={i === fontActiveIdx ? keepInView : undefined}
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
                    ref={moveActiveIdx === 0 ? keepInView : undefined}
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
                      ref={idx === moveActiveIdx ? keepInView : undefined}
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
                    ref={i === activeIdx ? keepInView : undefined}
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
              onPaste={handlePaste}
              onChange={(e) => {
                setDraft(e.target.value);
                autoSize(e.target);
                prewarm(e.target.value);
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
                  ? narrow
                    ? "Ask about your sources…"
                    : "Ask about your sources… (@ to reference · / for commands)"
                  : narrow
                    ? "Ask anything…"
                    : "Ask anything… (type / for commands)"
              }
              className="max-h-80 flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-[14px] outline-none placeholder:text-ink-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            />
            {settings.provider !== "local" && (
              <div ref={thinkingMenuRef} className="relative shrink-0">
                <button
                  onClick={() => setThinkingMenu((o) => !o)}
                  className={`flex h-8 items-center gap-1 rounded-full transition-colors hover:bg-hover ${
                    thinking === "auto" ? "w-8 justify-center text-ink-3 hover:text-ink" : "px-2.5 text-ink-2 hover:text-ink"
                  } ${thinkingMenu ? "bg-hover text-ink" : ""}`}
                  aria-label={`Thinking effort: ${THINKING_LABELS[thinking]}`}
                  aria-haspopup="menu"
                  aria-expanded={thinkingMenu}
                  title={`Thinking effort: ${THINKING_LABELS[thinking]}`}
                >
                  <Brain size={16} strokeWidth={1.9} />
                  {thinking !== "auto" && <span className="text-[12px] font-medium">{THINKING_LABELS[thinking]}</span>}
                </button>
                {thinkingMenu && (
                  <div
                    role="menu"
                    className="absolute bottom-full right-0 z-30 mb-2 w-60 overflow-hidden rounded-xl border border-edge bg-panel py-1 shadow-lg"
                  >
                    <p className="px-3 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
                      Thinking effort
                    </p>
                    {(Object.keys(THINKING_LABELS) as Thinking[]).map((level) => (
                      <button
                        key={level}
                        role="menuitemradio"
                        aria-checked={thinking === level}
                        onClick={() => pickThinking(level)}
                        className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover ${
                          thinking === level ? "text-ink" : "text-ink-2"
                        }`}
                      >
                        <span className="mt-0.5 flex w-3.5 shrink-0 justify-center">
                          {thinking === level && <Check size={13} strokeWidth={2.4} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium">{THINKING_LABELS[level]}</span>
                          <span className="block text-[11.5px] text-ink-3">
                            {
                              {
                                auto: "Each model's own default",
                                low: "Brief — faster and cheaper",
                                medium: "Balanced",
                                high: "Longest — best for hard questions",
                              }[level]
                            }
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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
            {settings.provider === "brewlm"
              ? `BrewLM AI · ${brewlmModelLabel(model)}`
              : `${model || "no model picked"} · ${settings.provider === "local" ? "on your computer" : `via ${settings.provider === "openrouter" ? "OpenRouter" : settings.provider}`}`}
            {(notebookGrounded ?? 1) === 0 && (
              <span className="text-warn"> · grounding off</span>
            )}
            {(notebookConstitutionOn ?? 1) === 0 && sources.some((s) => s.type === "context") && (
              <span className="text-warn"> · constitution off</span>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

/** Usage line data: token counts plus the reply's cost (estimated = price table). */
type ReplyUsage = StreamUsage & { estimated?: boolean };

/** How long a newly reached block of a streaming reply takes to fade in. */
const STREAM_FADE_MS = 450;

/**
 * The reply as it streams in. Chunks arrive in bursts; this reveals them a few
 * characters per frame (faster the further behind it is, so it never lags far)
 * and patches only the blocks that changed — earlier paragraphs stay put
 * (selectable mid-stream) and each new block fades in.
 */
function StreamingReply({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const targetRef = useRef(text);
  targetRef.current = text;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let shown = 0;
    let keys: string[] = []; // markup of each top-level node, to spot what changed
    let starts: number[] = []; // when each block first appeared (its fade clock)
    let raf = 0;

    const patch = (html: string) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const next = Array.from(tpl.content.childNodes);
      const nextKeys = next.map((n) => (n instanceof Element ? n.outerHTML : (n.textContent ?? "")));
      let same = 0;
      while (same < keys.length && same < nextKeys.length && keys[same] === nextKeys[same]) same++;
      while (el.childNodes.length > same) el.lastChild!.remove();
      const now = performance.now();
      const nextStarts = starts.slice(0, same);
      for (let i = same; i < next.length; i++) {
        // A block that grew keeps its fade clock, so the fade runs once, unbroken.
        const start = starts[i] ?? now;
        nextStarts.push(start);
        const node = next[i];
        if (!instant && node instanceof HTMLElement && now - start < STREAM_FADE_MS) {
          node.classList.add("stream-in");
          node.style.animationDelay = `${start - now}ms`;
        }
        el.appendChild(node);
      }
      keys = nextKeys;
      starts = nextStarts;
    };

    const tick = () => {
      const target = targetRef.current;
      const backlog = target.length - shown;
      if (backlog > 0) {
        shown += instant ? backlog : Math.max(2, Math.ceil(backlog / 10));
        // Never split a surrogate pair (emoji) across frames.
        const c = target.charCodeAt(shown - 1);
        if (c >= 0xd800 && c <= 0xdbff && shown < target.length) shown++;
        patch(renderMarkdown(target.slice(0, shown)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={ref} className="md" />;
}

/**
 * A reply's reasoning, folded above it. Live while the model is still
 * thinking: the header is the brewing animation and the open view follows
 * the newest lines.
 */
function Reasoning({ text, live = false, defaultOpen }: { text: string; live?: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // /thinking show|hide applies to replies already on screen too.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (live && el) el.scrollTop = el.scrollHeight;
  }, [text, live, open]);
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Hide reasoning" : "Show reasoning"}
        className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] font-medium text-ink-3 transition-colors hover:text-ink-2"
      >
        {live ? (
          <BrewingStatus />
        ) : (
          <>
            <Brain size={11} strokeWidth={1.8} />
            Reasoning
          </>
        )}
        <ChevronRight size={11} strokeWidth={2} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-edge pl-3 text-[12px] leading-relaxed text-ink-3"
        >
          {text.trim()}
        </div>
      )}
    </div>
  );
}

/**
 * Ref for the highlighted row of a composer list: keeps it in view as ↑↓
 * move the highlight past the list's visible part. Scrolls only the list,
 * never the page around it.
 */
function keepInView(row: HTMLElement | null) {
  const list = row?.parentElement;
  if (!row || !list) return;
  const r = row.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  if (r.top < l.top) list.scrollTop -= l.top - r.top;
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
}

/** Source title for a saved reply: its first heading or line, markdown stripped. */
export function replySourceTitle(content: string): string {
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
  animate = true,
  role,
  content,
  items,
  usage,
  reasoning,
  reasoningOpen = false,
  onImageAction,
  savedToSources,
  linkKeys,
  onAddLink,
  onSaveToSources,
}: {
  /** Entrance fade; off for a reply that just finished streaming in place. */
  animate?: boolean;
  role: "user" | "assistant";
  content: string;
  items: MentionItem[];
  usage?: ReplyUsage;
  /** The model's reasoning for this reply, shown folded above it. */
  reasoning?: string;
  /** Start the reasoning open (/thinking show). */
  reasoningOpen?: boolean;
  /** Edit / Remix / More like this on a library picture (absent while busy). */
  onImageAction?: (action: string, id: string, alt: string) => void;
  /** This reply's text is already a source in the notebook. */
  savedToSources?: boolean;
  /** urlKey of every link source in the notebook, so /fetch cards show what's added. */
  linkKeys?: Set<string>;
  /** Save a page as a link source (/fetch cards). */
  onAddLink?: (url: string) => Promise<Source>;
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
  const fetchList = useMemo(() => (role === "assistant" ? parseFetchMessage(content) : null), [role, content]);
  if (fetchList) {
    return (
      <div className={`${animate ? "anim-fade-up " : ""}mb-5 w-full min-w-0`}>
        <FetchResults list={fetchList} linkKeys={linkKeys} onAddLink={onAddLink} />
      </div>
    );
  }
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
    <div className={`${animate ? "anim-fade-up " : ""}group mb-5 flex flex-col items-start`}>
      {/* Replies sit on the page, no bubble, always the full column width
          (wide tables and code scroll sideways inside it). */}
      <div className="w-full min-w-0 text-[13.5px] leading-relaxed">
        {reasoning && <Reasoning text={reasoning} defaultOpen={reasoningOpen} />}
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
            {fmtUsageLine(usage)}
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
          className={`mt-1 -ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-all ${
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

type FetchAddState = "adding" | "added" | { error: string };

/** A /fetch reply: source cards to open in the browser and add to the notebook. */
function FetchResults({
  list,
  linkKeys,
  onAddLink,
}: {
  list: FetchList;
  linkKeys?: Set<string>;
  onAddLink?: (url: string) => Promise<Source>;
}) {
  const [state, setState] = useState<Record<string, FetchAddState>>({});
  const [addingAll, setAddingAll] = useState(false);
  const isAdded = (url: string) => state[url] === "added" || !!linkKeys?.has(urlKey(url));
  const add = async (url: string) => {
    if (!onAddLink || isAdded(url) || state[url] === "adding") return;
    setState((p) => ({ ...p, [url]: "adding" }));
    try {
      await onAddLink(url);
      setState((p) => ({ ...p, [url]: "added" }));
    } catch (e) {
      setState((p) => ({ ...p, [url]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const remaining = list.items.filter((it) => !isAdded(it.url));
  const addAll = async () => {
    if (addingAll) return;
    setAddingAll(true);
    const queue = remaining.map((it) => it.url);
    // A few pages at a time: quicker than one by one, gentle on slow sites.
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let url = queue.shift(); url; url = queue.shift()) await add(url);
      })
    );
    setAddingAll(false);
  };
  const open = (url: string) => void platform.openUrl(url).catch(() => {});
  const addedCount = list.items.length - remaining.length;

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3.5 py-2.5">
        <Globe size={14} strokeWidth={1.8} className="shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold" title={list.query}>
            Sources for “{list.query}”
          </div>
          <div className="text-[11px] text-ink-3">
            {list.items.length} found{addedCount > 0 ? ` · ${addedCount} added` : ""}
          </div>
        </div>
        {onAddLink && remaining.length > 1 && (
          <button
            onClick={addAll}
            disabled={addingAll}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-edge px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-60"
          >
            {addingAll ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} strokeWidth={2} />}
            Add all
          </button>
        )}
      </div>
      <ul className="divide-y divide-edge-soft">
        {list.items.map((it) => {
          const st = state[it.url];
          const added = isAdded(it.url);
          const err = typeof st === "object" ? st.error : null;
          return (
            <li key={it.url} className="flex items-start gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => open(it.url)}
                  title={`Open ${it.url}`}
                  className="group/link flex max-w-full items-start gap-1 text-left text-[13px] font-medium leading-snug hover:underline"
                >
                  <span className="min-w-0 break-words">{it.title}</span>
                  <ExternalLink
                    size={11}
                    strokeWidth={2}
                    className="mt-[3px] shrink-0 text-ink-3 opacity-60 group-hover/link:opacity-100"
                  />
                </button>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-3">
                  <span className="truncate">{siteOf(it.url)}</span>
                  {it.kind !== "other" && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="capitalize">{it.kind}</span>
                    </>
                  )}
                </div>
                {it.why && <p className="mt-1 text-[12px] leading-snug text-ink-2">{it.why}</p>}
                {err && <p className="mt-1 text-[11px] leading-snug text-danger">Couldn't add: {err}</p>}
              </div>
              {onAddLink && (
                <button
                  onClick={() => add(it.url)}
                  disabled={added || st === "adding"}
                  aria-label={added ? "Added to Sources" : "Add to Sources"}
                  className={`mt-0.5 flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    added
                      ? "text-ok"
                      : err
                        ? "border border-danger-edge text-danger hover:bg-hover"
                        : "border border-edge text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-60"
                  }`}
                >
                  {added ? (
                    <Check size={12} strokeWidth={2.2} />
                  ) : st === "adding" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Plus size={12} strokeWidth={2} />
                  )}
                  {added ? "Added" : st === "adding" ? "Adding" : err ? "Retry" : "Add"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
