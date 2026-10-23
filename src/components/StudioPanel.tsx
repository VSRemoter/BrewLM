import {
  AudioLines,
  FileText,
  GraduationCap,
  Layers,
  Loader2,
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
import { addArtifact, addSource, deleteArtifact, renameArtifact, setArtifactPinned, sourceText, updateArtifact } from "../lib/db";
import { complete, extractJson, isAbortError, LONG_OUTPUT_TOKENS } from "../lib/llm";
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
import { deepResearch } from "../lib/research";
import { activeKey } from "../lib/settings";
import { contextBudget } from "../lib/local";
import { recordUsage } from "../lib/usage";
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
import { writeAudioScript } from "../lib/audioScript";
import { parseScript, scriptLine, synthesizeScript, type ScriptTurn } from "../lib/tts";
import type { Artifact, ArtifactKind, Settings, Source } from "../lib/types";
import ArtifactView from "./ArtifactView";
import DrawingView from "./DrawingView";
import { isDarkTheme } from "../lib/themes";
import { buildSystemPrompt } from "./ChatPanel";
import {
  AudioModal,
  FlashcardsModal,
  MindmapModal,
  QuizModal,
  ReportModal,
} from "./StudioCustomize";
import { GhostButton, Modal, PrimaryButton, Spinner } from "./ui";

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
    desc: "Hierarchical outline",
    icon: Network,
    prompt: `Create a mind map of the key ideas in my sources as a nested markdown bullet outline.
Rules: use "-" bullets, indent nested levels by exactly two spaces, keep each node under 8 words, 3-6 top-level branches, 2-4 levels deep. Return ONLY the outline, no commentary.`,
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
    width?: number;
    sources: Source[];
    artifacts: Artifact[];
    settings: Settings;
    onArtifactsChanged: () => void;
    onSourcesChanged?: () => void;
    onOpenSettings: () => void;
    /** An output is open (true) or minimized (false) — the layout widens the panel for reading. */
    onReadingChange?: (reading: boolean) => void;
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
}, ref) {
  /** This notebook's generations in flight — several can run at once. */
  const jobs = useStudioJobs(notebookId);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Artifact | null>(null);
  // Tell the layout when an output is open so it can widen the panel for reading.
  const reading = viewing !== null;
  useEffect(() => onReadingChange?.(reading), [reading, onReadingChange]);
  /** The drawing open in the sketchpad. */
  const [drawing, setDrawing] = useState<Artifact | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
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
    opts: { exhaustive?: boolean; onPhase?: (phase: string) => void } = {}
  ): Promise<string> => {
    await ensureIndexed(scoped, settings);
    if (opts.exhaustive && sourceChars(scoped) > MAP_REDUCE_THRESHOLD) {
      const notes = await condenseNotebook(notebookId, scoped, settings, opts.onPhase);
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
   * Sources to ground a generation on. Constitutions always pass through;
   * when the customize modal scopes to specific sources, only those are used
   * as knowledge material. No ids (undefined or []) = every source — one-click
   * and slash-command runs pass [], and the modal can't submit an empty pick.
   */
  const scopedSources = (sourceIds?: string[]): Source[] =>
    sourceIds?.length ? sources.filter((s) => s.type === "context" || sourceIds.includes(s.id)) : sources;

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
      return "Add an API key in Settings first — I opened it for you.";
    }
    const usedSources = scopedSources(opts?.sourceIds);
    if (!usedSources.some(isTextSource)) {
      const msg = "Select at least one text-based source (PDF, text, or link) first.";
      setError(msg);
      return msg;
    }
    const title = opts?.title?.trim() || tool.name;
    const job = startStudioJob(notebookId, tool.kind, title, "Generating…");
    try {
      const prompt = opts?.prompt ?? tool.prompt;
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: LONG_OUTPUT_TOKENS,
        temperature: settings.temperature ?? undefined,
        signal: job.signal,
        onUsage: (u) => void recordUsage("studio", settings.provider, settings.model, u),
        messages: [
          { role: "system", content: await groundedSystem(usedSources, prompt, { exhaustive: true, onPhase: job.setPhase }) },
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
        data = JSON.stringify(parsed);
        count = parsed.length;
      }

      throwIfCancelled(job.signal);
      await addArtifact(notebookId, tool.kind, title, data);
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
        ? "Add an API key in Settings first — I opened it for you."
        : blocked;
      if (blocked !== "no-key") setError(msg);
      return msg;
    }
    const job = startStudioJob(notebookId, "report", label, `Writing ${label.toLowerCase()}…`);
    try {
      const scoped = scopedSources(sourceIds);
      // Bigger than a context window: groundedSystem runs the cached
      // whole-notebook condensation so the report covers EVERY source.
      const system = await groundedSystem(scoped, prompt, { exhaustive: true, onPhase: job.setPhase });
      job.setPhase(`Writing ${label.toLowerCase()}…`);
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: LONG_OUTPUT_TOKENS,
        temperature: settings.temperature ?? undefined,
        signal: job.signal,
        onUsage: (u) => void recordUsage("studio", settings.provider, settings.model, u),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      const doc = raw.trim();
      if (doc.length < 30) throw new Error("The report came back empty — try again.");
      throwIfCancelled(job.signal);
      await addArtifact(notebookId, "report", label, doc);
      return `Saved report “${label}” to Studio.`;
    } catch (e) {
      return failMsg(e, "Report", job.signal);
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
        ? "Add an API key in Settings first — I opened it for you."
        : blocked;
      if (blocked !== "no-key") setError(msg);
      return msg;
    }
    const title = saveTitle?.trim() || opts?.title?.trim() || "Audio overview";
    const job = startStudioJob(notebookId, "audio", title, "Writing script…");
    try {
      const o = opts ?? oneClickAudio();
      const scoped = scopedSources(o.sourceIds);
      const turns = await writeAudioScript(
        o,
        async (prompt, focus) =>
          complete({
            provider: settings.provider,
            apiKey: activeKey(settings),
            model: settings.model,
            maxTokens: LONG_OUTPUT_TOKENS,
            temperature: settings.temperature ?? undefined,
            signal: job.signal,
            onUsage: (u) => void recordUsage("studio", settings.provider, settings.model, u),
            messages: [
              { role: "system", content: await groundedSystem(scoped, focus, { exhaustive: true, onPhase: job.setPhase }) },
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
        JSON.stringify({ audio, script: turns, note })
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
      return "Add an API key in Settings first — I opened it for you.";
    }
    const job = startStudioJob(notebookId, "research", title, "Planning searches…");
    try {
      const outcome = await deepResearch({
        settings,
        title,
        description,
        signal: job.signal,
        onPhase: job.setPhase,
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
        })
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

  /** Human-readable content of an artifact, fed to the model for revision. */
  const reviseContent = (a: Artifact): string => {
    if (a.kind === "flashcards" || a.kind === "quiz") {
      try {
        return JSON.stringify(JSON.parse(a.data));
      } catch {
        return a.data;
      }
    }
    if (a.kind === "research" || a.kind === "audio") {
      try {
        const d = JSON.parse(a.data);
        if (a.kind === "research") return d.md ?? a.data;
        return (d.script ?? [])
          .map((t: ScriptTurn) => scriptLine(t))
          .join("\n");
      } catch {
        return a.data;
      }
    }
    return a.data; // mindmap, notes, report
  };

  /** "Return ONLY…" format contracts per kind — keeps revisions parseable. */
  const REVISE_FORMAT: Record<ArtifactKind, string> = {
    flashcards:
      'Return ONLY the revised flashcards as a JSON array shaped exactly like: [{"front": "question or term", "back": "concise answer"}]',
    quiz:
      'Return ONLY the revised quiz as a JSON array shaped exactly like: [{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why the answer is correct"}]',
    mindmap:
      'Return ONLY the revised outline as markdown: "-" bullets, two-space indentation per nested level, each node under 8 words, 3-6 top-level branches, 2-4 levels deep.',
    notes:
      "Return ONLY the revised markdown notes — no preface, no commentary.",
    report:
      "Return ONLY the revised markdown report — no preface, no commentary.",
    research:
      "Return ONLY the revised markdown report — no preface, no commentary. Keep the existing citation style (sources by title/url).",
    drawing: "", // drawings aren't revised by the AI
    audio: `Respond with the revised script only: one turn per line, exactly "Host: <line>" or "Co-Host: <line>", alternating and starting with the Host, about as long as the current script unless the instruction says otherwise. The hosts never call each other by name. Spoken language only: no markdown, no emojis, no stage directions.`,
  };

  /** Solo scripts rewrite with a single-voice contract, so the Co-Host never comes back. */
  const REVISE_FORMAT_AUDIO_SOLO = `Respond with the revised script only: one segment per line, exactly "Host: <line>", by a single narrator who never names themselves, about as long as the current script unless the instruction says otherwise. Spoken language only: no markdown, no emojis, no stage directions.`;

  /** A stored audio artifact is solo when every turn belongs to Alex. */
  const isSoloAudio = (a: Artifact): boolean => {
    try {
      const script = JSON.parse(a.data)?.script;
      return (
        Array.isArray(script) &&
        script.length > 0 &&
        script.every((t: { speaker?: unknown }) => t?.speaker === "Alex")
      );
    } catch {
      return false;
    }
  };

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
    const ctrl = new AbortController();
    try {
      const revisePrompt = `Here is the current "${a.title}":\n\n${reviseContent(a)}\n\nRevise it according to this instruction: ${note}\n\n${a.kind === "audio" && isSoloAudio(a) ? REVISE_FORMAT_AUDIO_SOLO : REVISE_FORMAT[a.kind]}`;
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: LONG_OUTPUT_TOKENS,
        temperature: settings.temperature ?? undefined,
        signal: ctrl.signal,
        onUsage: (u) => void recordUsage("studio", settings.provider, settings.model, u),
        messages: [
          { role: "system", content: await groundedSystem(sources, note) },
          { role: "user", content: revisePrompt },
        ],
      });

      let data: string;
      if (a.kind === "flashcards" || a.kind === "quiz") {
        const parsed = JSON.parse(extractJson(raw));
        if (!Array.isArray(parsed) || parsed.length === 0)
          throw new Error("The model returned an unexpected format. Try again.");
        data = JSON.stringify(parsed);
      } else if (a.kind === "mindmap") {
        data = raw
          .replace(/```(?:markdown|md)?\s*\n?/g, "")
          .replace(/```$/gm, "")
          .trim();
        if (!data) throw new Error("The revision came back empty — try again.");
      } else if (a.kind === "audio") {
        const turns = parseScript(raw);
        if (turns.length < 4)
          throw new Error("Couldn't produce a usable script — try again.");
        let audio: string | null = null;
        let ttsNote: string | undefined;
        if (reAudio) {
          try {
            const result = await synthesizeScript(turns, settings, {
              signal: ctrl.signal,
            });
            audio = result.audio;
            ttsNote = result.note;
          } catch (e) {
            ttsNote = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
          }
        } else {
          // script-only revision: keep any audio from the original artifact
          try {
            audio = JSON.parse(a.data).audio ?? null;
          } catch {
            /* no original audio */
          }
        }
        data = JSON.stringify({ audio, script: turns, note: ttsNote });
      } else if (a.kind === "research") {
        const md = raw.trim();
        if (md.length < 30) throw new Error("The revision came back empty — try again.");
        let readSources: { title: string; url: string }[] = [];
        try {
          readSources = JSON.parse(a.data).sources ?? [];
        } catch {
          /* keep empty */
        }
        data = JSON.stringify({ md, sources: readSources });
      } else {
        // notes, report
        const doc = raw.trim();
        if (doc.length < 30) throw new Error("The revision came back empty — try again.");
        data = doc;
      }

      const title = replace ? a.title : `${a.title} (revised)`;
      if (replace) {
        await updateArtifact(a.id, data);
      } else {
        await addArtifact(notebookId, a.kind, title, data);
      }
      onArtifactsChanged();
      setRevising(null);
      setReviseNote("");
    } catch (e) {
      setError(`Revision failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
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
    if (a.kind === "drawing") setDrawing(a);
    else setViewing(a);
  };

  /** Drawings: name it, save an empty canvas, open the sketchpad. */
  const newDrawing = async (title: string) => {
    const a = await addArtifact(notebookId, "drawing", title.trim() || "Drawing", JSON.stringify({ elements: [], files: {} }));
    onArtifactsChanged();
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
          running={jobs.length}
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
          <div className="stagger grid grid-cols-2 gap-2">
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

          {error && (
            <p className="mt-3 rounded-lg border border-danger-edge bg-danger-bg px-3 py-2 text-[12px] leading-snug text-danger">
              {error}
            </p>
          )}

          {/* saved artifacts */}
          <div className="mt-5">
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Saved
            </p>
            {artifacts.length === 0 && jobs.length === 0 ? (
              <p className="px-1 text-[12px] leading-relaxed text-ink-3">
                Generated study materials will appear here.
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
                      subtitle = `${d.script?.length ?? 0} turns${d.audio ? " · mp3" : ""}`;
                    } else if (a.kind === "research") {
                      const d = JSON.parse(a.data);
                      subtitle = `${d.sources?.length ?? 0} sources read`;
                    } else if (a.kind === "drawing") subtitle = `Drawing · ${formatTime(a.created_at)}`;
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
                      {a.kind !== "drawing" && (
                        <button
                          onClick={() => openRevise(a)}
                          className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-ink group-hover:opacity-100"
                          title="Revise"
                          aria-label={`Revise ${a.title}`}
                        >
                          <Pencil size={12.5} />
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          await deleteArtifact(a.id);
                          onArtifactsChanged();
                        }}
                        className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                        title="Delete"
                      >
                        <Trash2 size={12.5} />
                      </button>
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

      {drawing && (
        <DrawingView
          key={drawing.id}
          artifact={artifacts.find((x) => x.id === drawing.id) ?? drawing}
          dark={isDarkTheme(settings.theme)}
          onClose={() => {
            setDrawing(null);
            onArtifactsChanged();
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
    <Modal title="Deep research" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="-mt-1 text-[12px] leading-relaxed text-ink-3">
          The model plans web searches, reads the most relevant pages, and writes a
          cited report. Read pages are added as notebook sources.
        </p>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Grid-scale battery storage"
            autoFocus
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] outline-none focus:border-ink-3"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Description <span className="font-normal normal-case">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Angle, depth, or specific questions to cover…"
            rows={3}
            className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-ink-3"
          />
        </div>
        <p className="-mt-1 text-[11px] leading-relaxed text-ink-3">
          Uses your provider's web search — may incur small extra provider charges.
        </p>
        <div className="flex justify-end">
          <PrimaryButton
            onClick={() => onStart(title.trim(), description.trim())}
            disabled={!title.trim()}
          >
            Start research
          </PrimaryButton>
        </div>
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
    <Modal title={`Revise ${a.title}`} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Title
          </label>
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            maxLength={80}
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-ink-3"
          />
          <p className="mt-1 text-[11px] text-ink-3">Renames save automatically.</p>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Description
          </label>
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={placeholder[a.kind] ?? "What should change?"}
            rows={3}
            autoFocus
            className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-ink-3 focus:border-ink-3"
          />
        </div>
        {a.kind === "audio" && (
          <label className="flex items-start gap-2.5 text-[12px] leading-snug text-ink-2">
            <input
              type="checkbox"
              checked={reAudio}
              onChange={(e) => onReAudioChange(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
            />
            <span>
              Also re-generate the audio (slower — re-synthesizes every turn).{" "}
              <span className="text-ink-3">Off keeps the current mp3.</span>
            </span>
          </label>
        )}
        <div className="flex items-center justify-end gap-2">
          <GhostButton
            onClick={() => onRun(false)}
            disabled={busy !== null || !note.trim()}
          >
            {busy === "new" ? <Spinner size={13} /> : null}
            Save as new copy
          </GhostButton>
          <PrimaryButton
            onClick={() => onRun(true)}
            disabled={busy !== null || !note.trim()}
          >
            {busy === "replace" ? <Spinner size={13} /> : null}
            Replace original
          </PrimaryButton>
        </div>
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
    <Modal title="Name your output" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(title.trim() || defaultTitle);
        }}
        className="flex flex-col gap-3.5"
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
          maxLength={80}
          autoFocus
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] outline-none focus:border-ink-3"
        />
        <div className="flex justify-end gap-2">
          <PrimaryButton type="submit">Generate</PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}
