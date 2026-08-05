import {
  AudioLines,
  FileText,
  GraduationCap,
  Layers,
  Loader2,
  Network,
  Pencil,
  SlidersHorizontal,
  StickyNote,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { addArtifact, addSource, deleteArtifact, updateArtifact } from "../lib/db";
import { complete, extractJson, isAbortError } from "../lib/llm";
import { deepResearch } from "../lib/research";
import { activeKey } from "../lib/settings";
import { formatTime } from "../lib/source";
import {
  REPORT_FORMATS,
  REPORT_TYPE_LABELS,
  buildAudioPrompt,
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  type AudioOptions,
  type ReportOptions,
} from "../lib/studio";
import type { StudioCommand } from "../lib/studioCommands";
import { synthesizeScript, type ScriptTurn } from "../lib/tts";
import type { Artifact, ArtifactKind, Settings, Source } from "../lib/types";
import ArtifactView from "./ArtifactView";
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
};

/* ---------------------------------- Audio --------------------------------- */

const AUDIO_PROMPT = `You are writing a podcast-style "audio overview" of my sources, performed by two hosts: Alex (curious explainer) and Sam (engaged co-host).

Output EXACTLY one turn per line, in this exact format:
Alex: <spoken line>
Sam: <spoken line>

Rules:
- 14 to 18 turns total, starting with Alex and alternating naturally.
- Spoken language only: no markdown, no headings, no bullet points, no emojis, no stage directions or sound-effects like [intro music].
- Conversational and lively: Sam asks questions, reacts, and paraphrases; Alex explains clearly.
- Open by naming the topic of the sources; close with the 2–3 biggest takeaways.
- Stay strictly grounded in the sources — no fabricated facts.`;

function parseScript(raw: string): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*[*-]?\s*(Alex|Sam)\s*:\s*(.+?)\s*$/i);
    if (m && m[2].trim()) {
      turns.push({
        speaker: m[1].toLowerCase() === "sam" ? "Sam" : "Alex",
        text: m[2].replace(/\*\*/g, "").trim(),
      });
    }
  }
  return turns.slice(0, 24);
}

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
}, ref) {
  const [generating, setGenerating] = useState<ArtifactKind | null>(null);
  const [genPhase, setGenPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Artifact | null>(null);
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
  /** Audio-only toggle in the revise modal: re-run TTS on the revised script. */
  const [reviseAudio, setReviseAudio] = useState(false);
  /** Which modal action is busy (disables both buttons; shows the spinner). */
  const [reviseBusy, setReviseBusy] = useState<"new" | "replace" | null>(null);
  /** Aborts the one in-flight generation (only one runs at a time). */
  const abortRef = useRef<AbortController | null>(null);

  /** The X on a running tool card: cancel the job, save nothing. */
  const cancelGeneration = () => {
    abortRef.current?.abort();
  };

  /** Abort-aware catch: user cancels are quiet, real errors go to the panel. */
  const failMsg = (e: unknown, prefix: string, signal: AbortSignal): string => {
    if (isAbortError(e) || signal.aborted) return "Cancelled — nothing was saved.";
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    return `${prefix} failed: ${msg}`;
  };

  /** Running-status row shared by every tool card, with a cancel X. */
  const runningRow = (label: string) => (
    <span className="mt-0.5 flex w-full items-center gap-1.5 text-[11px] text-ink-3">
      <Loader2 size={11} className="shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          cancelGeneration();
        }}
        title="Cancel generation"
        aria-label="Cancel generation"
        className="pointer-events-auto shrink-0 rounded p-0.5 text-ink-3 transition-colors hover:text-danger"
      >
        <X size={12} strokeWidth={2.2} />
      </button>
    </span>
  );

  const isTextSource = (s: Source) =>
    s.type !== "context" && s.content && !s.content.startsWith("data:");

  const textSources = sources.filter(isTextSource);

  /**
   * Sources to ground a generation on. Constitutions always pass through;
   * when the customize modal scopes to specific sources, only those are used
   * as knowledge material.
   */
  const scopedSources = (sourceIds?: string[]): Source[] =>
    sourceIds ? sources.filter((s) => s.type === "context" || sourceIds.includes(s.id)) : sources;

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
    setGenerating(tool.kind);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        signal: ctrl.signal,
        messages: [
          { role: "system", content: buildSystemPrompt(usedSources) },
          { role: "user", content: opts?.prompt ?? tool.prompt },
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
      } else {
        const parsed = JSON.parse(extractJson(raw));
        if (!Array.isArray(parsed) || parsed.length === 0)
          throw new Error("The model returned an unexpected format. Try again.");
        data = JSON.stringify(parsed);
        count = parsed.length;
      }

      const title = opts?.title?.trim() || tool.name;
      await addArtifact(notebookId, tool.kind, title, data);
      onArtifactsChanged();
      return tool.kind === "flashcards"
        ? `Saved ${count} flashcards to Studio as “${title}”.`
        : tool.kind === "quiz"
          ? `Saved a ${count}-question quiz to Studio as “${title}”.`
          : `Saved a mind map to Studio as “${title}”.`;
    } catch (e) {
      return failMsg(e, tool.name, ctrl.signal);
    } finally {
      abortRef.current = null;
      setGenerating(null);
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
    setGenerating("report");
    setGenPhase(`Writing ${label.toLowerCase()}…`);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        signal: ctrl.signal,
        messages: [
          { role: "system", content: buildSystemPrompt(scopedSources(sourceIds)) },
          { role: "user", content: prompt },
        ],
      });
      const doc = raw.trim();
      if (doc.length < 30) throw new Error("The report came back empty — try again.");
      await addArtifact(notebookId, "report", label, doc);
      onArtifactsChanged();
      return `Saved report “${label}” to Studio.`;
    } catch (e) {
      return failMsg(e, "Report", ctrl.signal);
    } finally {
      abortRef.current = null;
      setGenerating(null);
      setGenPhase(null);
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
    setGenerating("audio");
    setGenPhase("Drafting script…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        signal: ctrl.signal,
        messages: [
          { role: "system", content: buildSystemPrompt(scopedSources(opts?.sourceIds)) },
          { role: "user", content: opts ? buildAudioPrompt(opts) : AUDIO_PROMPT },
        ],
      });

      const turns = parseScript(raw);
      if (turns.length < 4)
        throw new Error("Couldn't produce a usable script — try again.");

      let audio: string | null = null;
      let note: string | undefined;
      try {
        const result = await synthesizeScript(turns, settings, {
          signal: ctrl.signal,
          onProgress: (i, total) => setGenPhase(`Synthesizing audio ${i + 1}/${total}…`),
        });
        audio = result.audio;
        note = result.note;
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) throw e;
        note = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
      }

      const title = saveTitle?.trim() || opts?.title?.trim() || "Audio overview";
      await addArtifact(
        notebookId,
        "audio",
        title,
        JSON.stringify({ audio, script: turns, note })
      );
      onArtifactsChanged();
      return `Saved an audio overview to Studio as “${title}” — ${turns.length} turns${audio ? " · mp3 ready" : ""}${note ? ` · ${note}` : ""}.`;
    } catch (e) {
      return failMsg(e, "Audio overview", ctrl.signal);
    } finally {
      abortRef.current = null;
      setGenerating(null);
      setGenPhase(null);
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
    setGenerating("research");
    setGenPhase("Planning searches…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const outcome = await deepResearch({
        settings,
        title,
        description,
        signal: ctrl.signal,
        onPhase: setGenPhase,
      });

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
      setGenPhase("Saving sources…");
      for (const p of outcome.pages) {
        await addSource(notebookId, "link", p.title, p.text, p.url);
      }
      onSourcesChanged?.();
      onArtifactsChanged();
      return `Saved research “${title}” to Studio — ${outcome.pages.length} pages read & imported as sources.`;
    } catch (e) {
      return failMsg(e, "Deep research", ctrl.signal);
    } finally {
      abortRef.current = null;
      setGenerating(null);
      setGenPhase(null);
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
          .map((t: { speaker: string; text: string }) => `${t.speaker}: ${t.text}`)
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
    audio: `Respond with the revised script only: one turn per line, exactly "Alex: <line>" or "Sam: <line>", 14-18 turns alternating starting with Alex. Spoken language only: no markdown, no emojis, no stage directions.`,
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
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        signal: ctrl.signal,
        messages: [
          { role: "system", content: buildSystemPrompt(sources) },
          {
            role: "user",
            content: `Here is the current "${a.title}":\n\n${reviseContent(a)}\n\nRevise it according to this instruction: ${note}\n\n${REVISE_FORMAT[a.kind]}`,
          },
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

  const openRevise = (a: Artifact) => {
    setRevising(a);
    setReviseNote("");
    setReviseAudio(false);
  };

  /* ------------------- imperative run() for chat commands ------------------- */

  useImperativeHandle(
    ref,
    (): StudioPanelHandle => ({
      run: async (cmd) => {
        if (generating !== null) {
          return "Studio is already generating something — wait for it to finish first.";
        }
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
                : undefined
            );
          case "research":
            return genResearch(cmd.title, "");
        }
      },
    })
  );

  const viewArtifact = (a: Artifact) => {
    // kind-specific data already stored; reopen latest copy from props
    setViewing(a);
  };

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-edge-soft bg-panel"
      style={{ width }}
    >
      <div className="flex h-11 shrink-0 items-center border-b border-edge-soft px-3.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Studio
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* generation grid */}
        <div className="grid grid-cols-2 gap-2">
          {TOOLS.map((t) => (
            <div
              key={t.kind}
              role="button"
              tabIndex={0}
              onClick={() =>
                setNaming({ defaultTitle: t.name, run: (title) => void generate(t, { title }) })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  setNaming({ defaultTitle: t.name, run: (title) => void generate(t, { title }) });
              }}
              className={`group relative flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all ${
                generating !== null
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer hover:border-ink-3 hover:shadow-sm"
              }`}
            >
              {customizeIcon(t.kind as CustomizeKind, t.name)}
              <t.icon size={16} strokeWidth={1.8} className="text-ink" />
              <span className="text-[12.5px] font-semibold leading-none">{t.name}</span>
              <span className="text-[11px] leading-tight text-ink-3">{t.desc}</span>
              {generating === t.kind && runningRow("Generating…")}
            </div>
          ))}
          {/* Audio overview */}
          <div
            role="button"
            tabIndex={0}
            onClick={() =>
              setNaming({ defaultTitle: "Audio overview", run: (title) => void genAudio(undefined, title) })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setNaming({ defaultTitle: "Audio overview", run: (title) => void genAudio(undefined, title) });
            }}
            className={`group relative flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all ${
              generating !== null
                ? "pointer-events-none opacity-50"
                : "cursor-pointer hover:border-ink-3 hover:shadow-sm"
            }`}
          >
            {customizeIcon("audio", "Audio overview")}
            <AudioLines size={16} strokeWidth={1.8} className="text-ink" />
            <span className="text-[12.5px] font-semibold leading-none">Audio overview</span>
            <span className="text-[11px] leading-tight text-ink-3">
              Podcast-style conversation
            </span>
            {generating === "audio" && runningRow(genPhase ?? "Generating…")}
          </div>
          {/* Report */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setReportOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setReportOpen(true);
            }}
            className={`group relative flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all ${
              generating !== null
                ? "pointer-events-none opacity-50"
                : "cursor-pointer hover:border-ink-3 hover:shadow-sm"
            }`}
          >
            {customizeIcon("report", "Report")}
            <FileText size={16} strokeWidth={1.8} className="text-ink" />
            <span className="text-[12.5px] font-semibold leading-none">Report</span>
            <span className="text-[11px] leading-tight text-ink-3">
              Study guide, summary, FAQ…
            </span>
            {generating === "report" && runningRow(genPhase ?? "Generating…")}
          </div>
          {/* Deep research */}
          <button
            onClick={() => setResearchOpen(true)}
            disabled={generating !== null}
            className="col-span-2 flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all hover:border-ink-3 hover:shadow-sm disabled:opacity-50"
          >
            <Telescope size={16} strokeWidth={1.8} className="text-ink" />
            <span className="text-[12.5px] font-semibold leading-none">Deep research</span>
            <span className="text-[11px] leading-tight text-ink-3">
              Web-powered analysis with cited sources
            </span>
            {generating === "research" && runningRow(genPhase ?? "Researching…")}
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
          {artifacts.length === 0 ? (
            <p className="px-1 text-[12px] leading-relaxed text-ink-3">
              Generated study materials will appear here.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {artifacts.map((a) => {
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
                  } else subtitle = formatTime(a.created_at);
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
                      onClick={() => openRevise(a)}
                      className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-ink group-hover:opacity-100"
                      title="Revise"
                      aria-label={`Revise ${a.title}`}
                    >
                      <Pencil size={12.5} />
                    </button>
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
          note={reviseNote}
          onNoteChange={setReviseNote}
          reAudio={reviseAudio}
          onReAudioChange={setReviseAudio}
          busy={reviseBusy}
          onClose={() => reviseBusy === null && setRevising(null)}
          onRun={(replace) => void reviseArtifact(revising, reviseNote, replace, reviseAudio)}
        />
      )}

      {/* customize modals */}
      {customizing === "flashcards" && (
        <FlashcardsModal
          sources={textSources}
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
          onClose={() => setCustomizing(null)}
          onGenerate={(opts) => {
            setCustomizing(null);
            genCustomReport(opts);
          }}
        />
      )}

      {viewing && (
        <ArtifactView
          key={viewing.id}
          artifact={viewing}
          onClose={() => setViewing(null)}
          onSourcesChanged={onSourcesChanged}
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
  note,
  onNoteChange,
  reAudio,
  onReAudioChange,
  busy,
  onClose,
  onRun,
}: {
  artifact: Artifact;
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
        <p className="-mt-1 text-[12px] leading-relaxed text-ink-3">
          Describe the change — the current output is rewritten with your sources as grounding.
        </p>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={placeholder[a.kind] ?? "What should change?"}
          rows={3}
          autoFocus
          className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
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
