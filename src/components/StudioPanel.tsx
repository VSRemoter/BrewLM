import {
  AudioLines,
  FileText,
  GraduationCap,
  Layers,
  Loader2,
  MonitorPlay,
  Network,
  Pencil,
  PenLine,
  Pin,
  SlidersHorizontal,
  StickyNote,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { mediaExt } from "../lib/blobs";
import { addArtifact, addSource, deleteArtifact, renameArtifact, setArtifactPinned, sourceText, updateArtifact } from "../lib/db";
import { complete, extractJson, isAbortError, type StreamUsage } from "../lib/llm";
import {
  condenseNotebook,
  condensedSystemPrompt,
  ensureIndexed,
  indexSource,
  isRetrievable,
  MAP_REDUCE_THRESHOLD,
  rankChunks,
} from "../lib/rag";
import { cancelStudioJob, startStudioJob, throwIfCancelled, useStudioJobs } from "../lib/studioJobs";
import { reviseOutput } from "../lib/revise";
import { deepResearch } from "../lib/research";
import { activeKey, noKeyMessage } from "../lib/settings";
import { aiBlock } from "../lib/brewlmAi";
import { AiBlockedNotice } from "./settings/BrewLmAi";
import { contextBudget } from "../lib/local";
import {
  addOutputUsage,
  meterTotal,
  meterUsage,
  newUsageMeter,
  parseOutputUsage,
  recordUsage,
  type UsageMeter,
} from "../lib/usage";
import { formatTime } from "../lib/source";
import {
  REPORT_FORMATS,
  REPORT_TYPE_LABELS,
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  type AudioOptions,
  type ReportOptions,
} from "../lib/studio";
import type { StudioCommand } from "../lib/studioCommands";
import {
  hasFocus,
  interactivePrior,
  pickAngle,
  pickFormat,
  shuffleQuizOptions,
  varietyNote,
  withVariety,
} from "../lib/studioVariety";
import {
  INTERACTIVE_REVISE_FORMAT,
  buildPagePrompt,
  PAGE_SYSTEM,
  buildStoryboardPrompt,
  parseInteractive,
  writePage,
  type InteractiveOptions,
} from "../lib/interactive";
import { writeAudioScript } from "../lib/audioScript";
import { synthesizeScript } from "../lib/tts";
import type { Artifact, ArtifactKind, Settings, Source } from "../lib/types";
import ArtifactView from "./ArtifactView";
import { confirmAction } from "./ConfirmDialog";
import DrawingView from "./DrawingView";
import { isDarkTheme } from "../lib/themes";
import { buildSystemPrompt } from "./ChatPanel";
import {
  AudioModal,
  FlashcardsModal,
  InteractiveModal,
  MindmapModal,
  QuizModal,
  ReportModal,
} from "./StudioCustomize";
import { FormField, GhostButton, inputClass, Modal, PrimaryButton, Spinner, textareaClass } from "./ui";
import { Toggle } from "./settings/controls";

const TOOLS: {
  kind: ArtifactKind;
  name: string;
  desc: string;
  icon: typeof Layers;
  prompt: string;
}[] = [
  {
    kind: "flashcards",
    name: "Flashcards",
    desc: "Active-recall card deck",
    icon: Layers,
    prompt: `Create 12 flashcards covering the most important concepts in my sources.
Return ONLY a JSON array, no commentary, shaped exactly like:
[{"front": "question or term", "back": "concise answer"}]`,
  },
  {
    kind: "quiz",
    name: "Quiz",
    desc: "Multiple-choice questions",
    icon: GraduationCap,
    prompt: `Create an 8-question multiple-choice quiz covering the most important concepts in my sources.
Return ONLY a JSON array, no commentary, shaped exactly like:
[{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why the answer is correct"}]`,
  },
  {
    kind: "mindmap",
    name: "Mind map",
    desc: "Interactive map of the key ideas",
    icon: Network,
    prompt: buildMindmapPrompt(""),
  },
];

const KIND_ICON: Record<ArtifactKind, typeof Layers> = {
  flashcards: Layers,
  quiz: GraduationCap,
  mindmap: Network,
  notes: StickyNote,
  report: FileText,
  audio: AudioLines,
  research: Telescope,
  drawing: PenLine,
  interactive: MonitorPlay,
};

/* ---------------------------------- Audio --------------------------------- */

/** Tools with a customize modal (deep research already opens its own). */
type CustomizeKind = "flashcards" | "quiz" | "mindmap" | "audio" | "report";

/** Imperative API for chat-side Studio commands (exposed via ref). */
export interface StudioPanelHandle {
  run: (cmd: StudioCommand) => Promise<string>;
}

const StudioPanel = forwardRef<
  StudioPanelHandle,
  {
    notebookId: string;
    width?: number | string;
    sources: Source[];
    artifacts: Artifact[];
    settings: Settings;
    onArtifactsChanged: () => void;
    onSourcesChanged?: () => void;
    onOpenSettings: () => void;
    /** An output is open (true) or minimized (false) — the layout widens the panel for reading. */
    onReadingChange?: (reading: boolean) => void;
    /** A notebook shared with you: outputs can be opened, not made, revised or deleted. */
    readOnly?: boolean;
  }
>(function StudioPanel({
  notebookId,
  width = 288,
  sources,
  artifacts,
  settings,
  onArtifactsChanged,
  onSourcesChanged,
  onOpenSettings,
  onReadingChange,
  readOnly = false,
}, ref) {
  /** This notebook's generations in flight — several can run at once. */
  const jobs = useStudioJobs(notebookId);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Artifact | null>(null);
  /** The drawing open in the sketchpad (takes over the panel like `viewing`). */
  const [drawing, setDrawing] = useState<Artifact | null>(null);
  // Tell the layout when an output is open so it can widen the panel for reading.
  const reading = viewing !== null || drawing !== null;
  useEffect(() => onReadingChange?.(reading), [reading, onReadingChange]);
  const [reportOpen, setReportOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [customizing, setCustomizing] = useState<CustomizeKind | null>(null);
  /** Quick-generation naming step: prefilled default + what to run on confirm. */
  const [naming, setNaming] = useState<{
    defaultTitle: string;
    run: (title: string) => void;
  } | null>(null);
  /** Revise flow: the artifact being edited in the pencil modal. */
  const [revising, setRevising] = useState<Artifact | null>(null);
  const [reviseNote, setReviseNote] = useState("");
  /** Editable title in the revise modal — auto-saves, no Replace/Copy needed. */
  const [reviseTitle, setReviseTitle] = useState("");
  /** Debounce handle for the title auto-save. */
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Audio-only toggle in the revise modal: re-run TTS on the revised script. */
  const [reviseAudio, setReviseAudio] = useState(false);
  /** Which modal action is busy (disables both buttons; shows the spinner). */
  const [reviseBusy, setReviseBusy] = useState<"new" | "replace" | null>(null);
  /** Aborts the running revision (the modal's Cancel button). */
  const reviseCtrlRef = useRef<AbortController | null>(null);
  // A job ending (saved, failed or cancelled) refreshes the lists — also when
  // it was started before the user left this notebook and came back.
  const jobIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const ids = jobs.map((j) => j.id);
    if (jobIdsRef.current.some((id) => !ids.includes(id))) {
      onArtifactsChanged();
      onSourcesChanged?.();
    }
    jobIdsRef.current = ids;
  }, [jobs, onArtifactsChanged, onSourcesChanged]);

  /** Abort-aware catch: user cancels are quiet, real errors go to the panel. */
  const failMsg = (e: unknown, prefix: string, signal: AbortSignal): string => {
    if (isAbortError(e) || signal.aborted) return "Cancelled — nothing was saved.";
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    return `${prefix} failed: ${msg}`;
  };

  const isTextSource = isRetrievable;

  const textSources = sources.filter(isTextSource);

  /**
   * Shared grounding: index the scoped sources if needed, then fill the
   * context budget with the chunks most relevant to `query` (the tool's
   * prompt). With `exhaustive` on a notebook too big for any context window,
   * run the cached whole-notebook condensation instead — the expensive
   * map-reduce pass is computed once, shared by every Studio tool, and
   * recomputed only when the sources change.
   */
  const groundedSystem = async (
    scoped: Source[],
    query: string,
    opts: { exhaustive?: boolean; onPhase?: (phase: string) => void; signal?: AbortSignal } = {}
  ): Promise<string> => {
    await ensureIndexed(scoped, settings);
    if (opts.exhaustive && sourceChars(scoped) > MAP_REDUCE_THRESHOLD) {
      const notes = await condenseNotebook(notebookId, scoped, settings, opts.onPhase, opts.signal);
      return condensedSystemPrompt(notes);
    }
    const budget = contextBudget(settings);
    const retrieved = await rankChunks(scoped, query, settings, budget.sources);
    return buildSystemPrompt(scoped, [], retrieved.length ? retrieved : undefined, { budget });
  };

  /** Prompt-usable source text; over the threshold, reports condense exhaustively. */
  const sourceChars = (scoped: Source[]) =>
    scoped.filter(isTextSource).reduce((n, s) => n + sourceText(s).length, 0);

  /**
   * Sources to ground a generation on. When the customize modal scopes to
   * specific sources, only those are used. No ids (undefined or []) = every
   * source — one-click and slash-command runs pass [], and the modal can't
   * submit an empty pick.
   */
  const scopedSources = (sourceIds?: string[]): Source[] =>
    sourceIds?.length ? sources.filter((s) => sourceIds.includes(s.id)) : sources;

  /** Small spinner on a tool card while any of its jobs is running. */
  const runningSpinner = (kind: ArtifactKind) =>
    jobs.some((j) => j.kind === kind) && (
      <Loader2 size={11} strokeWidth={2.2} className="animate-spin text-accent" aria-label="Running" />
    );

  /** Hover icon on every tool card — opens its customize modal. */
  const customizeIcon = (kind: CustomizeKind, label: string) => (
    <span
      role="button"
      aria-label={`Customize ${label}`}
      title={`Customize ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        setCustomizing(kind);
      }}
      className="absolute right-2 top-2 rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-hover-soft hover:text-ink group-hover:opacity-100"
    >
      <SlidersHorizontal size={13} strokeWidth={1.8} />
    </span>
  );

  const generate = async (
    tool: (typeof TOOLS)[number],
    opts?: { sourceIds?: string[]; prompt?: string; title?: string }
  ): Promise<string> => {
    setError(null);
    if (!activeKey(settings)) {
      onOpenSettings();
      return noKeyMessage(settings, true);
    }
    const usedSources = scopedSources(opts?.sourceIds);
    if (!usedSources.some(isTextSource)) {
      const msg = "Select at least one text-based source (PDF, text, or link) first.";
      setError(msg);
      return msg;
    }
    const title = opts?.title?.trim() || tool.name;
    const job = startStudioJob(notebookId, tool.kind, title, "Generating…");
    const meter = newUsageMeter();
    try {
      const base = opts?.prompt ?? tool.prompt;
      // Variety: what this notebook already has of this kind, plus a random
      // angle when the user gave no focus — otherwise every run looks alike.
      const prompt = withVariety(
        base,
        varietyNote(tool.kind as "flashcards" | "quiz" | "mindmap", artifacts, { focused: hasFocus(base) })
      );
      const raw = await complete({
        ...llmRequest(job.signal, meter),
        messages: [
          { role: "system", content: await groundedSystem(usedSources, base, { exhaustive: true, onPhase: job.setPhase, signal: job.signal }) },
          { role: "user", content: prompt },
        ],
      });

      let data: string;
      let count = 0;
      if (tool.kind === "mindmap") {
        // strip code fences the model may add
        data = raw
          .replace(/```(?:markdown|md)?\s*\n?/g, "")
          .replace(/```$/gm, "")
          .trim();
        if (!/^\s*[-*]\s+\S/m.test(data))
          throw new Error("The mind map came back empty or without an outline — try again.");
      } else {
        const parsed = JSON.parse(extractJson(raw));
        if (!Array.isArray(parsed) || parsed.length === 0)
          throw new Error("The model returned an unexpected format. Try again.");
        data = JSON.stringify(tool.kind === "quiz" ? shuffleQuizOptions(parsed) : parsed);
        count = parsed.length;
      }

      throwIfCancelled(job.signal);
      await addArtifact(notebookId, tool.kind, title, data, meterTotal(meter));
      return tool.kind === "flashcards"
        ? `Saved ${count} flashcards to Studio as “${title}”.`
        : tool.kind === "quiz"
          ? `Saved a ${count}-question quiz to Studio as “${title}”.`
          : `Saved a mind map to Studio as “${title}”.`;
    } catch (e) {
      return failMsg(e, tool.name, job.signal);
    } finally {
      job.finish();
    }
  };

  const canGenerate = (): string | null => {
    if (!activeKey(settings)) {
      onOpenSettings();
      return "no-key";
    }
    if (textSources.length === 0) {
      return "Add at least one text-based source (PDF, text, or link) first.";
    }
    return null;
  };

  /** Customized report: named type (incl. Thorough Analysis) or user's own prompt. */
  const genCustomReport = (opts: ReportOptions) => {
    const title =
      opts.title?.trim() ||
      (opts.type === "custom" ? "Custom report" : REPORT_TYPE_LABELS[opts.type]);
    return runReport(
      title,
      buildReportPrompt(opts.type, opts.customPrompt),
      opts.sourceIds
    );
  };

  const runReport = async (label: string, prompt: string, sourceIds?: string[]): Promise<string> => {
    setReportOpen(false);
    setError(null);
    const blocked = canGenerate();
    if (blocked) {
      const msg = blocked === "no-key"
        ? noKeyMessage(settings, true)
        : blocked;
      if (blocked !== "no-key") setError(msg);
      return msg;
    }
    const job = startStudioJob(notebookId, "report", label, `Writing ${label.toLowerCase()}…`);
    const meter = newUsageMeter();
    try {
      const scoped = scopedSources(sourceIds);
      // Bigger than a context window: groundedSystem runs the cached
      // whole-notebook condensation so the report covers EVERY source.
      const system = await groundedSystem(scoped, prompt, { exhaustive: true, onPhase: job.setPhase, signal: job.signal });
      job.setPhase(`Writing ${label.toLowerCase()}…`);
      const raw = await complete({
        ...llmRequest(job.signal, meter),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      const doc = raw.trim();
      if (doc.length < 30) throw new Error("The report came back empty — try again.");
      throwIfCancelled(job.signal);
      await addArtifact(notebookId, "report", label, doc, meterTotal(meter));
      return `Saved report “${label}” to Studio.`;
    } catch (e) {
      return failMsg(e, "Report", job.signal);
    } finally {
      job.finish();
    }
  };

  /**
   * The chosen model and its Settings → AI Model tuning, for one Studio request.
   * Usage goes to the ledger and to `meter`, the output's own running total.
   */
  const llmRequest = (signal: AbortSignal, meter: UsageMeter) => ({
    provider: settings.provider,
    apiKey: activeKey(settings),
    model: settings.model,
    thinking: settings.thinking,
    maxOutput: settings.maxOutput,
    temperature: settings.temperature ?? undefined,
    signal,
    onUsage: (u: StreamUsage) => {
      void recordUsage("studio", settings.provider, settings.model, u);
      meterUsage(meter, settings.provider, settings.model, u);
    },
  });

  /** Progress for a page build, e.g. "Building the page… 14 KB written". */
  const pageProgress = (label: string, setPhase: (p: string) => void) => (chars: number) =>
    setPhase(`${label}… ${Math.max(1, Math.round(chars / 1024))} KB written`);

  /**
   * Interactive: a storyboard grounded in the sources, then a self-contained
   * HTML page built from the storyboard alone (the long, expensive pass skips
   * re-reading the sources).
   */
  const genInteractive = async (opts: InteractiveOptions): Promise<string> => {
    setInteractiveOpen(false);
    setError(null);
    const blocked = canGenerate();
    if (blocked) {
      const msg = blocked === "no-key"
        ? noKeyMessage(settings, true)
        : blocked;
      if (blocked !== "no-key") setError(msg);
      return msg;
    }
    const title = opts.title?.trim() || "Interactive";
    const job = startStudioJob(notebookId, "interactive", title, "Planning the storyboard…");
    const meter = newUsageMeter();
    try {
      // No topic: draw an angle and a format so blank runs don't all pick the same idea.
      const lens = opts.topic.trim() ? {} : { angle: pickAngle(), format: pickFormat() };
      const prompt = buildStoryboardPrompt(opts, { ...lens, prior: interactivePrior(artifacts) });
      const system = await groundedSystem(scopedSources(opts.sourceIds), opts.topic || buildStoryboardPrompt(opts, lens), {
        exhaustive: true,
        onPhase: job.setPhase,
        signal: job.signal,
      });
      job.setPhase("Planning the storyboard…");
      const storyboard = (
        await complete({
          ...llmRequest(job.signal, meter),
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        })
      ).trim();
      if (storyboard.length < 100) throw new Error("The storyboard came back empty — try again.");
      job.setPhase("Building the page…");
      const html = await writePage({
        ...llmRequest(job.signal, meter),
        messages: [
          { role: "system", content: PAGE_SYSTEM },
          { role: "user", content: buildPagePrompt(storyboard) },
        ],
        onProgress: pageProgress("Building the page", job.setPhase),
      });
      throwIfCancelled(job.signal);
      await addArtifact(
        notebookId,
        "interactive",
        title,
        JSON.stringify({ html, storyboard }),
        meterTotal(meter)
      );
      return `Saved interactive “${title}” to Studio.`;
    } catch (e) {
      return failMsg(e, "Interactive", job.signal);
    } finally {
      job.finish();
    }
  };

  /** One repair pass on an interactive page that failed at runtime; updates it in place. Returns an error message, or null. */
  const fixInteractive = async (a: Artifact, problem: string): Promise<string | null> => {
    const page = parseInteractive(a.data);
    if (!page) return "This page's data looks malformed.";
    if (!activeKey(settings)) {
      onOpenSettings();
      return noKeyMessage(settings);
    }
    const job = startStudioJob(notebookId, "interactive", a.title, "Fixing the page…");
    const meter = newUsageMeter();
    try {
      const html = await writePage({
        ...llmRequest(job.signal, meter),
        messages: [
          { role: "system", content: PAGE_SYSTEM },
          {
            role: "user",
            content: `This page fails when it runs:\n\n${problem}\n\nFind and fix the cause, and any similar bugs. Change nothing else.\n\n${page.html}\n\n${INTERACTIVE_REVISE_FORMAT}`,
          },
        ],
        onProgress: pageProgress("Fixing the page", job.setPhase),
      });
      throwIfCancelled(job.signal);
      await updateArtifact(
        a.id,
        JSON.stringify({ ...page, html }),
        addOutputUsage(parseOutputUsage(a.usage), meterTotal(meter))
      );
      return null;
    } catch (e) {
      return failMsg(e, "Fix", job.signal);
    } finally {
      job.finish();
    }
  };

  /**
   * Audio overview: chat model writes a two-host podcast script; the TTS
   * provider chosen in Settings → Audio voices (OpenAI / ElevenLabs /
   * system voices) decides how it's synthesized.
   */
  const genAudio = async (opts?: AudioOptions, saveTitle?: string): Promise<string> => {
    setError(null);
    const blocked = canGenerate();
    if (blocked) {
      const msg = blocked === "no-key"
        ? noKeyMessage(settings, true)
        : blocked;
      if (blocked !== "no-key") setError(msg);
      return msg;
    }
    const title = saveTitle?.trim() || opts?.title?.trim() || "Audio overview";
    const job = startStudioJob(notebookId, "audio", title, "Writing script…");
    const meter = newUsageMeter();
    try {
      const picked = opts ?? oneClickAudio();
      const o: AudioOptions = {
        ...picked,
        variety: varietyNote("audio", artifacts, { focused: picked.description.trim() !== "" }),
      };
      const scoped = scopedSources(o.sourceIds);
      const turns = await writeAudioScript(
        o,
        async (prompt, focus) =>
          complete({
            ...llmRequest(job.signal, meter),
            messages: [
              { role: "system", content: await groundedSystem(scoped, focus, { exhaustive: true, onPhase: job.setPhase, signal: job.signal }) },
              { role: "user", content: prompt },
            ],
          }),
        job.setPhase
      );
      if (turns.length < 4)
        throw new Error("Couldn't produce a usable script — try again.");

      let audio: string | null = null;
      let note: string | undefined;
      try {
        const result = await synthesizeScript(turns, settings, {
          signal: job.signal,
          onProgress: (i, total) => job.setPhase(`Synthesizing audio ${i + 1}/${total}…`),
        });
        audio = result.audio;
        note = result.note;
      } catch (e) {
        if (isAbortError(e) || job.signal.aborted) throw e;
        note = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
      }

      throwIfCancelled(job.signal);
      await addArtifact(
        notebookId,
        "audio",
        title,
        JSON.stringify({ audio, script: turns, note }),
        meterTotal(meter)
      );
      return `Saved an audio overview to Studio as “${title}” — ${turns.length} turns${audio ? " · mp3 ready" : ""}${note ? ` · ${note}` : ""}.`;
    } catch (e) {
      return failMsg(e, "Audio overview", job.signal);
    } finally {
      job.finish();
    }
  };

  /**
   * Deep research: the LLM plans web searches, the provider's search access
   * finds pages, the app reads them directly, and a cited report is written.
   * Read pages are also imported as notebook sources for grounding.
   */
  const genResearch = async (title: string, description: string): Promise<string> => {
    setResearchOpen(false);
    setError(null);
    if (!activeKey(settings)) {
      onOpenSettings();
      return noKeyMessage(settings, true);
    }
    const job = startStudioJob(notebookId, "research", title, "Planning searches…");
    const meter = newUsageMeter();
    try {
      const outcome = await deepResearch({
        settings,
        title,
        description,
        signal: job.signal,
        onPhase: job.setPhase,
        onUsage: (provider, model, u) => meterUsage(meter, provider, model, u),
      });

      throwIfCancelled(job.signal);
      await addArtifact(
        notebookId,
        "research",
        title,
        JSON.stringify({
          md: outcome.markdown,
          sources: (outcome.pages.length > 0 ? outcome.pages : outcome.hits.slice(0, 12)).map(
            (s) => ({ title: s.title, url: s.url })
          ),
        }),
        meterTotal(meter)
      );

      // ground future chats: import the read pages as link sources
      job.setPhase("Saving sources…");
      for (const p of outcome.pages) {
        const src = await addSource(notebookId, "link", p.title, p.text, p.url);
        void indexSource(src, settings);
      }
      return `Saved research “${title}” to Studio — ${outcome.pages.length} pages read & imported as sources.`;
    } catch (e) {
      return failMsg(e, "Deep research", job.signal);
    } finally {
      job.finish();
    }
  };

  /* ------------------------------- revise ------------------------------- */

  /**
   * One LLM pass over an artifact with the user's revision instructions,
   * grounded in the notebook sources. replace=false saves a "(revised)" copy.
   */
  const reviseArtifact = async (
    a: Artifact,
    note: string,
    replace: boolean,
    reAudio: boolean
  ) => {
    setReviseBusy(replace ? "replace" : "new");
    setError(null);
    const ctrl = new AbortController();
    reviseCtrlRef.current = ctrl;
    const meter = newUsageMeter();
    try {
      const data = await reviseOutput({
        a,
        note,
        reAudio,
        settings,
        system: await groundedSystem(sources, note),
        request: llmRequest(ctrl.signal, meter),
      });

      const title = replace ? a.title : `${a.title} (revised)`;
      throwIfCancelled(ctrl.signal);
      if (replace) {
        await updateArtifact(a.id, data, addOutputUsage(parseOutputUsage(a.usage), meterTotal(meter)));
      } else {
        await addArtifact(notebookId, a.kind, title, data, meterTotal(meter));
      }
      onArtifactsChanged();
      setRevising(null);
      setReviseNote("");
    } catch (e) {
      // Cancelled: quiet, and the modal stays open with the instruction kept.
      if (!isAbortError(e) && !ctrl.signal.aborted)
        setError(`Revision failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (reviseCtrlRef.current === ctrl) reviseCtrlRef.current = null;
      setReviseBusy(null);
    }
  };

  /** Persist a rename from the revise modal (skips empty/unchanged titles). */
  const flushRename = async (a: Artifact, rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title || title === a.title) return;
    await renameArtifact(a.id, title);
    setRevising((cur) => (cur && cur.id === a.id ? { ...cur, title } : cur));
    onArtifactsChanged();
  };

  /** Title edits save on a short debounce — no Replace/Save-as-copy required. */
  const queueTitleRename = (a: Artifact, title: string) => {
    setReviseTitle(title);
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    renameTimerRef.current = setTimeout(() => {
      renameTimerRef.current = null;
      void flushRename(a, title);
    }, 500);
  };

  /** Cancel any pending debounce and save now. Returns the final title. */
  /**
   * One-click generation honors Settings → Studio Defaults, exactly like the
   * customize modals and slash commands: flashcards/quiz get amount +
   * difficulty, audio gets mode/format/length.
   */
  const oneClickPrompt = (kind: ArtifactKind): string | undefined => {
    if (kind === "flashcards")
      return buildFlashcardsPrompt({
        amount: settings.defFlashcardsAmount,
        difficulty: settings.defFlashcardsDifficulty,
        sourceIds: [],
        description: "",
      });
    if (kind === "quiz")
      return buildQuizPrompt({
        amount: settings.defQuizAmount,
        difficulty: settings.defQuizDifficulty,
        sourceIds: [],
        description: "",
      });
    return undefined; // mindmap has no configurable defaults
  };

  const oneClickAudio = (): AudioOptions => ({
    format: settings.defAudioFormat,
    length: settings.defAudioLength,
    mode: settings.defAudioMode,
    sourceIds: [],
    description: "",
  });

  const settleRename = async (a: Artifact, rawTitle: string): Promise<string> => {
    if (renameTimerRef.current) {
      clearTimeout(renameTimerRef.current);
      renameTimerRef.current = null;
    }
    await flushRename(a, rawTitle);
    return rawTitle.trim() || a.title;
  };

  const openRevise = (a: Artifact) => {
    setRevising(a);
    setReviseTitle(a.title);
    setReviseNote("");
    setReviseAudio(false);
  };

  /* ------------------- imperative run() for chat commands ------------------- */

  useImperativeHandle(
    ref,
    (): StudioPanelHandle => ({
      run: async (cmd) => {
        switch (cmd.tool) {
          case "flashcards": {
            const tool = TOOLS.find((t) => t.kind === "flashcards");
            if (!tool) return "Flashcards tool is unavailable.";
            return generate(tool, { prompt: cmd.prompt });
          }
          case "quiz": {
            const tool = TOOLS.find((t) => t.kind === "quiz");
            if (!tool) return "Quiz tool is unavailable.";
            return generate(tool, { prompt: cmd.prompt });
          }
          case "mindmap": {
            const tool = TOOLS.find((t) => t.kind === "mindmap");
            if (!tool) return "Mind map tool is unavailable.";
            return generate(tool, { prompt: cmd.prompt });
          }
          case "report":
            return runReport(cmd.label, cmd.prompt);
          case "audio":
            return genAudio(
              cmd.opts
                ? { ...cmd.opts, sourceIds: []}
                : oneClickAudio()
            );
          case "research":
            return genResearch(cmd.title, "");
        }
      },
    })
  );

  const viewArtifact = (a: Artifact) => {
    // kind-specific data already stored; reopen latest copy from props
    if (a.kind === "drawing") {
      setViewing(null);
      setDrawing(a);
    } else {
      setDrawing(null);
      setViewing(a);
    }
  };

  /** Drawings: name it, save an empty canvas, open the sketchpad. */
  const newDrawing = async (title: string) => {
    const a = await addArtifact(notebookId, "drawing", title.trim() || "Drawing", JSON.stringify({ elements: [], files: {} }));
    onArtifactsChanged();
    setViewing(null);
    setDrawing(a);
  };

  return (
    <aside
      className="anim-panel-right flex h-full shrink-0 flex-col border-l border-edge-soft bg-panel"
      style={{ width }}
    >
      {/* An opened output takes over the panel; Minimize brings the tools back. */}
      {viewing ? (
        <ArtifactView
          key={viewing.id}
          artifact={artifacts.find((x) => x.id === viewing.id) ?? viewing}
          onClose={() => setViewing(null)}
          onSourcesChanged={onSourcesChanged}
          onArtifactChanged={onArtifactsChanged}
          running={jobs.length}
          dark={isDarkTheme(settings.theme)}
          showDetails={settings.showDetails}
          onFixInteractive={(problem) => fixInteractive(artifacts.find((x) => x.id === viewing.id) ?? viewing, problem)}
        />
      ) : drawing ? (
        <DrawingView
          key={drawing.id}
          artifact={artifacts.find((x) => x.id === drawing.id) ?? drawing}
          dark={isDarkTheme(settings.theme)}
          onClose={() => {
            setDrawing(null);
            onArtifactsChanged();
          }}
        />
      ) : (
        <>
        <div className="flex h-11 shrink-0 items-center border-b border-edge-soft px-3.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">
            Studio
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {/* generation grid */}
          <div className={`stagger grid grid-cols-2 gap-2 ${readOnly ? "hidden" : ""}`}>
            {TOOLS.map((t) => (
              <div
                key={t.kind}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setNaming({ defaultTitle: t.name, run: (title) => void generate(t, { title, prompt: oneClickPrompt(t.kind) }) })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    setNaming({ defaultTitle: t.name, run: (title) => void generate(t, { title, prompt: oneClickPrompt(t.kind) }) });
                }}
                className="lift group relative flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
              >
                {customizeIcon(t.kind as CustomizeKind, t.name)}
                <t.icon size={16} strokeWidth={1.8} className="text-ink" />
                <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-none">
                  {t.name}
                  {runningSpinner(t.kind)}
                </span>
                <span className="text-[11px] leading-tight text-ink-3">{t.desc}</span>
              </div>
            ))}
            {/* Audio overview */}
            <div
              role="button"
              tabIndex={0}
              onClick={() =>
                setNaming({ defaultTitle: "Audio overview", run: (title) => void genAudio(oneClickAudio(), title) })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  setNaming({ defaultTitle: "Audio overview", run: (title) => void genAudio(oneClickAudio(), title) });
              }}
              className="lift group relative flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
            >
              {customizeIcon("audio", "Audio overview")}
              <AudioLines size={16} strokeWidth={1.8} className="text-ink" />
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-none">
                Audio overview
                {runningSpinner("audio")}
              </span>
              <span className="text-[11px] leading-tight text-ink-3">
                Podcast-style conversation
              </span>
            </div>
            {/* Report */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setReportOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setReportOpen(true);
              }}
              className="lift group relative flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
            >
              {customizeIcon("report", "Report")}
              <FileText size={16} strokeWidth={1.8} className="text-ink" />
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-none">
                Report
                {runningSpinner("report")}
              </span>
              <span className="text-[11px] leading-tight text-ink-3">
                Study guide, summary, FAQ…
              </span>
            </div>
            {/* Drawings — the user's own sketchpad; never sent to the AI */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setNaming({ defaultTitle: "Drawing", run: (title) => void newDrawing(title) })}
              onKeyDown={(e) => {
                if (e.key === "Enter") setNaming({ defaultTitle: "Drawing", run: (title) => void newDrawing(title) });
              }}
              className="lift group relative flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
            >
              <PenLine size={16} strokeWidth={1.8} className="text-ink" />
              <span className="text-[12.5px] font-semibold leading-none">Drawings</span>
              <span className="text-[11px] leading-tight text-ink-3">Sketch, write &amp; work problems</span>
            </div>
            {/* Interactive — an AI-built web page: app, animation, game, simulation… */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setInteractiveOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setInteractiveOpen(true);
              }}
              className="lift group relative col-span-2 flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
            >
              <MonitorPlay size={16} strokeWidth={1.8} className="text-ink" />
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-none">
                Interactive
                {runningSpinner("interactive")}
              </span>
              <span className="text-[11px] leading-tight text-ink-3">
                Generate web apps, animations, games, simulations and more
              </span>
            </div>
            {/* Deep research */}
            <button
              onClick={() => setResearchOpen(true)}
              className="lift col-span-2 flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-ink-3"
            >
              <Telescope size={16} strokeWidth={1.8} className="text-ink" />
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-none">
                Deep research
                {runningSpinner("research")}
              </span>
              <span className="text-[11px] leading-tight text-ink-3">
                Web-powered analysis with cited sources
              </span>
            </button>
          </div>

          {error &&
            (aiBlock(error) ? (
              <div className="mt-3 rounded-lg border border-warn-edge bg-warn-bg px-3 py-2.5">
                <AiBlockedNotice message={error} onOpenSettings={onOpenSettings} />
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-danger-edge bg-danger-bg px-3 py-2 text-[12px] leading-snug text-danger">
                {error}
              </p>
            ))}

          {/* saved artifacts */}
          <div className={readOnly ? "" : "mt-5"}>
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Saved
            </p>
            {artifacts.length === 0 && jobs.length === 0 ? (
              <p className="px-1 text-[12px] leading-relaxed text-ink-3">
                {readOnly ? "No Studio outputs were shared." : "Generated study materials will appear here."}
              </p>
            ) : (
              <div className="stagger flex flex-col gap-1">
                {/* In progress: live phase + cancel (saves nothing). */}
                {jobs.map((j) => (
                  <div
                    key={j.id}
                    className="anim-fade-up flex w-full items-center gap-2.5 rounded-lg bg-hover-soft px-2 py-2"
                    aria-busy="true"
                  >
                    <Loader2 size={15} strokeWidth={1.8} className="shrink-0 animate-spin text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{j.title}</span>
                      <span className="block truncate text-[11px] text-ink-3" title={j.phase}>
                        {j.phase}
                      </span>
                    </span>
                    <button
                      onClick={() => cancelStudioJob(j.id)}
                      className="shrink-0 rounded p-1 text-ink-3 transition-colors hover:text-danger"
                      title="Cancel and remove"
                      aria-label={`Cancel ${j.title}`}
                    >
                      <X size={13} strokeWidth={2.2} />
                    </button>
                  </div>
                ))}
                {/* Pinned first; stable sort keeps the rest newest-first. */}
                {[...artifacts].sort((x, y) => y.pinned - x.pinned).map((a) => {
                  const Icon = KIND_ICON[a.kind] ?? StickyNote;
                  let subtitle = "";
                  try {
                    if (a.kind === "flashcards")
                      subtitle = `${JSON.parse(a.data).length} cards`;
                    else if (a.kind === "quiz")
                      subtitle = `${JSON.parse(a.data).length} questions`;
                    else if (a.kind === "audio") {
                      const d = JSON.parse(a.data);
                      subtitle = `${d.script?.length ?? 0} turns${d.audio ? ` · ${mediaExt(d.audio)}` : ""}`;
                    } else if (a.kind === "research") {
                      const d = JSON.parse(a.data);
                      subtitle = `${d.sources?.length ?? 0} sources read`;
                    } else if (a.kind === "drawing") subtitle = `Drawing · ${formatTime(a.created_at)}`;
                    else if (a.kind === "interactive") subtitle = `Interactive · ${formatTime(a.created_at)}`;
                    else subtitle = formatTime(a.created_at);
                  } catch {
                    subtitle = formatTime(a.created_at);
                  }
                  return (
                    <div
                      key={a.id}
                      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-hover-soft"
                    >
                      <button
                        onClick={() => viewArtifact(a)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <Icon size={15} strokeWidth={1.8} className="shrink-0 text-ink-2" />
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-medium">
                            {a.title}
                          </span>
                          <span className="block text-[11px] text-ink-3">{subtitle}</span>
                        </span>
                      </button>
                      <button
                        onClick={async () => {
                          await setArtifactPinned(a.id, !a.pinned);
                          onArtifactsChanged();
                        }}
                        className={`shrink-0 rounded p-1 transition-all hover:text-ink ${
                          a.pinned
                            ? "text-accent"
                            : "text-ink-3 opacity-0 group-hover:opacity-100"
                        }`}
                        title={a.pinned ? "Unpin" : "Pin to top"}
                        aria-label={a.pinned ? `Unpin ${a.title}` : `Pin ${a.title} to top`}
                      >
                        <Pin size={12.5} fill={a.pinned ? "currentColor" : "none"} />
                      </button>
                      {a.kind !== "drawing" && !readOnly && (
                        <button
                          onClick={() => openRevise(a)}
                          className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-ink group-hover:opacity-100"
                          title="Revise"
                          aria-label={`Revise ${a.title}`}
                        >
                          <Pencil size={12.5} />
                        </button>
                      )}
                      {!readOnly && (
                      <button
                        onClick={async () => {
                          const ok = await confirmAction({
                            title: "Delete studio output?",
                            message: `“${a.title}” will be deleted. This can't be undone.`,
                          });
                          if (!ok) return;
                          await deleteArtifact(a.id);
                          onArtifactsChanged();
                        }}
                        className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                        title="Delete"
                      >
                        <Trash2 size={12.5} />
                      </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        </>
      )}

      {reportOpen && (
        <Modal title="Create report" onClose={() => setReportOpen(false)}>
          <p className="-mt-1 mb-3 text-[12px] leading-relaxed text-ink-3">
            Pick a format — the report is generated from your sources and saved below.
          </p>
          <div className="flex flex-col gap-1">
            {REPORT_FORMATS.map((f) => (
              <button
                key={f.id}
                onClick={() => {
                  setReportOpen(false);
                  setNaming({ defaultTitle: f.label, run: (title) => void runReport(title, f.prompt) });
                }}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover-soft"
              >
                <span className="text-[13px] font-medium">{f.label}</span>
                <span className="text-[11.5px] text-ink-3">{f.desc}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {interactiveOpen && (
        <InteractiveModal
          sources={textSources}
          onClose={() => setInteractiveOpen(false)}
          onGenerate={(opts) => void genInteractive(opts)}
        />
      )}

      {researchOpen && (
        <ResearchModal
          onClose={() => setResearchOpen(false)}
          onStart={genResearch}
        />
      )}

      {naming && (
        <NameModal
          key={naming.defaultTitle}
          defaultTitle={naming.defaultTitle}
          onClose={() => setNaming(null)}
          onConfirm={(title) => {
            setNaming(null);
            naming.run(title);
          }}
        />
      )}

      {revising && (
        <ReviseModal
          artifact={revising}
          title={reviseTitle}
          onTitleChange={(v) => queueTitleRename(revising, v)}
          note={reviseNote}
          onNoteChange={setReviseNote}
          reAudio={reviseAudio}
          onReAudioChange={setReviseAudio}
          busy={reviseBusy}
          onCancel={() => reviseCtrlRef.current?.abort()}
          onClose={() => {
            if (reviseBusy !== null) return;
            void settleRename(revising, reviseTitle);
            setRevising(null);
          }}
          onRun={(replace) => {
            void (async () => {
              // settle the rename first so "(revised)" copies use the new title
              const title = await settleRename(revising, reviseTitle);
              await reviseArtifact({ ...revising, title }, reviseNote, replace, reviseAudio);
            })();
          }}
        />
      )}

      {/* customize modals */}
      {customizing === "flashcards" && (
        <FlashcardsModal
          sources={textSources}
          defaults={{ amount: settings.defFlashcardsAmount, difficulty: settings.defFlashcardsDifficulty }}
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            const tool = TOOLS.find((t) => t.kind === "flashcards");
            if (tool) generate(tool, { sourceIds: opts.sourceIds, prompt: buildFlashcardsPrompt(opts) });
          }}
        />
      )}
      {customizing === "quiz" && (
        <QuizModal
          sources={textSources}
          defaults={{ amount: settings.defQuizAmount, difficulty: settings.defQuizDifficulty }}
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            const tool = TOOLS.find((t) => t.kind === "quiz");
            if (tool) generate(tool, { sourceIds: opts.sourceIds, prompt: buildQuizPrompt(opts) });
          }}
        />
      )}
      {customizing === "mindmap" && (
        <MindmapModal
          sources={textSources}
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            const tool = TOOLS.find((t) => t.kind === "mindmap");
            if (tool)
              generate(tool, { sourceIds: opts.sourceIds, prompt: buildMindmapPrompt(opts.description) });
          }}
        />
      )}
      {customizing === "audio" && (
        <AudioModal
          sources={textSources}
          defaults={{ mode: settings.defAudioMode, format: settings.defAudioFormat, length: settings.defAudioLength }}
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            genAudio(opts);
          }}
        />
      )}
      {customizing === "report" && (
        <ReportModal
          sources={textSources}
          defaults={{ type: settings.defReportType }}
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            genCustomReport(opts);
          }}
        />
      )}

    </aside>
  );
});

export default StudioPanel;

/* ----------------------------- Research modal ----------------------------- */

function ResearchModal({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  return (
    <Modal
      title="Deep research"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[12px] text-ink-3">Uses your provider's web search, which may cost a little extra.</span>
          <PrimaryButton onClick={() => onStart(title.trim(), description.trim())} disabled={!title.trim()}>
            Start research
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="-mt-1 text-[13px] leading-relaxed text-ink-3">
          The model plans web searches, reads the most relevant pages, and writes a
          cited report. Read pages are added as notebook sources.
        </p>
        <FormField label="Topic">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Grid-scale battery storage"
            autoFocus
            className={inputClass}
          />
        </FormField>
        <FormField label="Focus" note="Optional">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Angle, depth, or specific questions to cover…"
            rows={3}
            className={textareaClass}
          />
        </FormField>
      </div>
    </Modal>
  );
}

/* ------------------------------ Revise modal ------------------------------ */

/** Pencil-icon editor: describe a fix, then save as a copy or replace the original. */
function ReviseModal({
  artifact: a,
  title,
  onTitleChange,
  note,
  onNoteChange,
  reAudio,
  onReAudioChange,
  busy,
  onCancel,
  onClose,
  onRun,
}: {
  artifact: Artifact;
  title: string;
  onTitleChange: (v: string) => void;
  note: string;
  onNoteChange: (v: string) => void;
  reAudio: boolean;
  onReAudioChange: (v: boolean) => void;
  busy: "new" | "replace" | null;
  /** Stops the running revision; nothing is saved. */
  onCancel: () => void;
  onClose: () => void;
  onRun: (replace: boolean) => void;
}) {
  const placeholder: Partial<Record<ArtifactKind, string>> = {
    flashcards: "e.g. make the cards harder, add one on mitosis",
    quiz: "e.g. harder distractors, one question on photosynthesis",
    mindmap: "e.g. add a branch on applications",
    audio: "e.g. shorten to 10 turns and make it more casual",
    report: "e.g. add a caveats section, tighten the intro",
    research: "e.g. focus more on 2024 findings, trim the history",
    notes: "e.g. condense to half the length",
  };

  return (
    <Modal
      title={`Revise ${a.title}`}
      onClose={onClose}
      footer={
        <>
          {busy !== null && (
            <button onClick={onCancel} className="mr-auto rounded-md px-2 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink">
              Stop
            </button>
          )}
          <GhostButton onClick={() => onRun(false)} disabled={busy !== null || !note.trim()}>
            {busy === "new" ? <Spinner size={13} /> : null}
            Save as new copy
          </GhostButton>
          <PrimaryButton onClick={() => onRun(true)} disabled={busy !== null || !note.trim()}>
            {busy === "replace" ? <Spinner size={13} /> : null}
            Replace original
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label="Title" aside={<span className="text-[12px] text-ink-3">Renames save automatically</span>}>
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            maxLength={80}
            className={inputClass}
          />
        </FormField>
        <FormField label="What should change?">
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={placeholder[a.kind] ?? "Describe the change"}
            rows={3}
            autoFocus
            className={textareaClass}
          />
        </FormField>
        {a.kind === "audio" && (
          <label className="flex items-start justify-between gap-4 rounded-lg bg-hover/60 px-3 py-2.5">
            <span className="text-[13px] leading-snug text-ink">
              Re-generate the audio
              <span className="mt-0.5 block text-[12px] text-ink-3">
                Slower: re-synthesizes every turn. Off keeps the current mp3.
              </span>
            </span>
            <span className="mt-0.5 shrink-0">
              <Toggle checked={reAudio} onChange={onReAudioChange} label="Re-generate the audio" />
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------ Naming modal ------------------------------ */

/** One-shot "name your output" step before one-click Studio generation. */
function NameModal({
  defaultTitle,
  onClose,
  onConfirm,
}: {
  defaultTitle: string;
  onClose: () => void;
  onConfirm: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);

  return (
    <Modal
      title="Name your output"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" form="name-output">
            Generate
          </PrimaryButton>
        </>
      }
    >
      <form
        id="name-output"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(title.trim() || defaultTitle);
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
          maxLength={80}
          autoFocus
          aria-label="Name"
          className={inputClass}
        />
      </form>
    </Modal>
  );
}
