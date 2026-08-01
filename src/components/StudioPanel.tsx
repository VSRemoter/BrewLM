import {
  AudioLines,
  FileText,
  GraduationCap,
  Layers,
  Loader2,
  Network,
  StickyNote,
  Telescope,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { addArtifact, addSource, deleteArtifact } from "../lib/db";
import { complete, extractJson } from "../lib/llm";
import { deepResearch } from "../lib/research";
import { activeKey } from "../lib/settings";
import { formatTime } from "../lib/source";
import type { Artifact, ArtifactKind, Settings, Source } from "../lib/types";
import ArtifactView from "./ArtifactView";
import { buildSystemPrompt } from "./ChatPanel";
import { Modal, PrimaryButton } from "./ui";

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

/* --------------------------------- Report --------------------------------- */

const REPORT_RULES = `Rules: output ONLY the document itself in GitHub-flavored markdown — no preface, no "here is", no trailing questions. Use ## headings, bullets, and **bold** for key terms. Ground everything in the sources; cite specific facts with the source title in parentheses, e.g. (Source: Week 4 lecture.pdf). Never invent facts.`;

const REPORT_FORMATS: { id: string; label: string; desc: string; prompt: string }[] = [
  {
    id: "summary",
    label: "Summary",
    desc: "Concise overview of the material",
    prompt: `Write a concise, well-structured summary of my sources: the core ideas, why they matter, and the key details worth remembering. ${REPORT_RULES}`,
  },
  {
    id: "study-guide",
    label: "Study guide",
    desc: "Concepts, terms & review questions",
    prompt: `Create a study guide for my sources with: ## Key concepts (each with a short explanation), ## Important terms & definitions, ## Example questions (with answers folded in), and ## Study checklist. ${REPORT_RULES}`,
  },
  {
    id: "faq",
    label: "FAQ",
    desc: "Likely questions, grounded answers",
    prompt: `Create a FAQ for my sources: 8–12 questions a learner would likely ask, each answered clearly and specifically. Put each question in a ### heading and its answer below it. ${REPORT_RULES}`,
  },
  {
    id: "timeline",
    label: "Timeline",
    desc: "Chronological key events",
    prompt: `Build a chronological timeline of the events, dates, steps, or developments in my sources. Use a markdown table with | When | Event | Why it matters | columns. If the sources contain little temporal information, say so in one sentence and instead outline the logical progression of ideas. ${REPORT_RULES}`,
  },
  {
    id: "briefing",
    label: "Briefing doc",
    desc: "Themes, insights & key quotes",
    prompt: `Write a briefing document on my sources with sections: ## Overview, ## Main themes, ## Key insights, ## Notable facts & quotes, and ## Open questions. ${REPORT_RULES}`,
  },
];

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

interface ScriptTurn {
  speaker: "Alex" | "Sam";
  text: string;
}

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

function chunksToBase64(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < out.length; i += STEP) {
    bin += String.fromCharCode(...out.subarray(i, i + STEP));
  }
  return btoa(bin);
}

export default function StudioPanel({
  notebookId,
  sources,
  artifacts,
  settings,
  onArtifactsChanged,
  onSourcesChanged,
  onOpenSettings,
}: {
  notebookId: string;
  sources: Source[];
  artifacts: Artifact[];
  settings: Settings;
  onArtifactsChanged: () => void;
  onSourcesChanged?: () => void;
  onOpenSettings: () => void;
}) {
  const [generating, setGenerating] = useState<ArtifactKind | null>(null);
  const [genPhase, setGenPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Artifact | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);

  const textSources = sources.filter(
    (s) => s.type !== "context" && s.content && !s.content.startsWith("data:")
  );

  const generate = async (tool: (typeof TOOLS)[number]) => {
    setError(null);
    if (!activeKey(settings)) {
      onOpenSettings();
      return;
    }
    if (textSources.length === 0) {
      setError("Add at least one text-based source (PDF, text, or link) first.");
      return;
    }
    setGenerating(tool.kind);
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        messages: [
          { role: "system", content: buildSystemPrompt(sources) },
          { role: "user", content: tool.prompt },
        ],
      });

      let data: string;
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
      }

      await addArtifact(notebookId, tool.kind, tool.name, data);
      onArtifactsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
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

  /** Report: grounded markdown document (summary, study guide, FAQ…). */
  const genReport = async (format: (typeof REPORT_FORMATS)[number]) => {
    setReportOpen(false);
    setError(null);
    const blocked = canGenerate();
    if (blocked) {
      if (blocked !== "no-key") setError(blocked);
      return;
    }
    setGenerating("report");
    setGenPhase(`Writing ${format.label.toLowerCase()}…`);
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        messages: [
          { role: "system", content: buildSystemPrompt(sources) },
          { role: "user", content: format.prompt },
        ],
      });
      const doc = raw.trim();
      if (doc.length < 30) throw new Error("The report came back empty — try again.");
      await addArtifact(notebookId, "report", format.label, doc);
      onArtifactsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
      setGenPhase(null);
    }
  };

  /**
   * Audio overview: chat model writes a two-host podcast script; if the
   * provider supports text-to-speech (OpenAI), synthesize a real mp3 —
   * otherwise keep the script for playback with system voices.
   */
  const genAudio = async () => {
    setError(null);
    const blocked = canGenerate();
    if (blocked) {
      if (blocked !== "no-key") setError(blocked);
      return;
    }
    setGenerating("audio");
    setGenPhase("Drafting script…");
    try {
      const raw = await complete({
        provider: settings.provider,
        apiKey: activeKey(settings),
        model: settings.model,
        maxTokens: 4096,
        messages: [
          { role: "system", content: buildSystemPrompt(sources) },
          { role: "user", content: AUDIO_PROMPT },
        ],
      });

      const turns = parseScript(raw);
      if (turns.length < 4)
        throw new Error("Couldn't produce a usable script — try again.");

      let audio: string | null = null;
      let note: string | undefined;
      if (settings.provider === "openai" && settings.openaiKey) {
        try {
          const parts: Uint8Array[] = [];
          for (let i = 0; i < turns.length; i++) {
            setGenPhase(`Synthesizing audio ${i + 1}/${turns.length}…`);
            const resp = await fetch("https://api.openai.com/v1/audio/speech", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${settings.openaiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-4o-mini-tts",
                input: turns[i].text,
                voice: turns[i].speaker === "Alex" ? "nova" : "onyx",
                response_format: "mp3",
              }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            parts.push(new Uint8Array(await resp.arrayBuffer()));
          }
          audio = `data:audio/mpeg;base64,${chunksToBase64(parts)}`;
        } catch (e) {
          note = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
        }
      } else {
        note = "Text-to-speech needs the OpenAI provider";
      }

      await addArtifact(
        notebookId,
        "audio",
        "Audio overview",
        JSON.stringify({ audio, script: turns, note })
      );
      onArtifactsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
      setGenPhase(null);
    }
  };

  /**
   * Deep research: the LLM plans web searches, the provider's search access
   * finds pages, the app reads them directly, and a cited report is written.
   * Read pages are also imported as notebook sources for grounding.
   */
  const genResearch = async (title: string, description: string) => {
    setResearchOpen(false);
    setError(null);
    if (!activeKey(settings)) {
      onOpenSettings();
      return;
    }
    setGenerating("research");
    setGenPhase("Planning searches…");
    try {
      const outcome = await deepResearch({
        settings,
        title,
        description,
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
      setGenPhase(null);
    }
  };

  const viewArtifact = (a: Artifact) => {
    // kind-specific data already stored; reopen latest copy from props
    setViewing(a);
  };

  return (
    <aside className="flex h-full w-[288px] shrink-0 flex-col border-l border-edge-soft bg-panel">
      <div className="flex h-11 shrink-0 items-center border-b border-edge-soft px-3.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Studio
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* generation grid */}
        <div className="grid grid-cols-2 gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              onClick={() => generate(t)}
              disabled={generating !== null}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all hover:border-ink-3 hover:shadow-sm disabled:opacity-50"
            >
              <t.icon size={16} strokeWidth={1.8} className="text-ink" />
              <span className="text-[12.5px] font-semibold leading-none">{t.name}</span>
              <span className="text-[11px] leading-tight text-ink-3">{t.desc}</span>
              {generating === t.kind && (
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                  <Loader2 size={11} className="animate-spin" /> Generating…
                </span>
              )}
            </button>
          ))}
          {/* Audio overview */}
          <button
            onClick={genAudio}
            disabled={generating !== null}
            className="flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all hover:border-ink-3 hover:shadow-sm disabled:opacity-50"
          >
            <AudioLines size={16} strokeWidth={1.8} className="text-ink" />
            <span className="text-[12.5px] font-semibold leading-none">Audio overview</span>
            <span className="text-[11px] leading-tight text-ink-3">
              Podcast-style conversation
            </span>
            {generating === "audio" && (
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <Loader2 size={11} className="animate-spin" /> {genPhase ?? "Generating…"}
              </span>
            )}
          </button>
          {/* Report */}
          <button
            onClick={() => setReportOpen(true)}
            disabled={generating !== null}
            className="flex flex-col items-start gap-1.5 rounded-xl border border-edge bg-panel p-3 text-left transition-all hover:border-ink-3 hover:shadow-sm disabled:opacity-50"
          >
            <FileText size={16} strokeWidth={1.8} className="text-ink" />
            <span className="text-[12.5px] font-semibold leading-none">Report</span>
            <span className="text-[11px] leading-tight text-ink-3">
              Study guide, summary, FAQ…
            </span>
            {generating === "report" && (
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <Loader2 size={11} className="animate-spin" /> {genPhase ?? "Generating…"}
              </span>
            )}
          </button>
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
            {generating === "research" && (
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug text-ink-3">
                <Loader2 size={11} className="animate-spin" />
                <span className="min-w-0 truncate">{genPhase ?? "Researching…"}</span>
              </span>
            )}
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
                onClick={() => genReport(f)}
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

      {viewing && (
        <ArtifactView
          artifact={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </aside>
  );
}

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
