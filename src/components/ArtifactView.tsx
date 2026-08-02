import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Check, ChevronLeft, ChevronRight, Download, FilePlus2, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addSource } from "../lib/db";
import { renderMarkdown } from "../lib/markdown";
import { artifactText } from "../lib/mentions";
import { hydrateMermaid } from "../lib/mermaid";
import type { Artifact, Flashcard, QuizQuestion } from "../lib/types";
import { Modal, GhostButton, IconButton } from "./ui";

/** Filesystem-safe name for downloads. */
function exportName(title: string, ext: string): string {
  const base = title.replace(/[/\\?%*:|"<>]/g, "").trim().slice(0, 60);
  return `${base || "brewlm-output"}.${ext}`;
}

export default function ArtifactView({
  artifact,
  onClose,
  onSourcesChanged,
}: {
  artifact: Artifact;
  onClose: () => void;
  onSourcesChanged?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    void hydrateMermaid(rootRef.current);
  }, [artifact.data]);

  /** Push the output into the notebook's Sources panel as readable markdown. */
  const addToSources = async () => {
    setExportError(null);
    const text = artifactText(artifact);
    if (!text) {
      setExportError("This output has no readable text to add as a source.");
      return;
    }
    try {
      await addSource(artifact.notebook_id, "text", artifact.title, text);
      onSourcesChanged?.();
      setAdded(true);
    } catch (e) {
      setExportError(`Couldn't add to sources: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Save the output to disk — audio as mp3/wav, everything else as markdown. */
  const download = async () => {
    setExportError(null);
    try {
      if (artifact.kind === "audio") {
        const parsed = parseAudio(artifact.data);
        if (parsed?.audio) {
          const isWav = parsed.audio.startsWith("data:audio/wav");
          const ext = isWav ? "wav" : "mp3";
          const path = await save({
            defaultPath: exportName(artifact.title, ext),
            filters: [{ name: "Audio", extensions: [ext] }],
          });
          if (!path) return; // cancelled
          const bytes = Uint8Array.from(atob(parsed.audio.split(",")[1] ?? ""), (c) =>
            c.charCodeAt(0)
          );
          await writeFile(path, bytes);
          return;
        }
      }
      const text = artifactText(artifact);
      if (!text) {
        setExportError("Nothing to download — this output has no readable content.");
        return;
      }
      const path = await save({
        defaultPath: exportName(artifact.title, "md"),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // cancelled
      await writeTextFile(path, text);
    } catch (e) {
      setExportError(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Modal
      title={artifact.title}
      onClose={onClose}
      wide
      actions={
        <>
          <IconButton
            onClick={addToSources}
            label={added ? "Added to sources" : "Add to sources"}
          >
            {added ? (
              <Check size={15} strokeWidth={2.2} className="text-ok" />
            ) : (
              <FilePlus2 size={15} strokeWidth={1.8} />
            )}
          </IconButton>
          <IconButton onClick={download} label="Download…">
            <Download size={15} strokeWidth={1.8} />
          </IconButton>
        </>
      }
    >
      {exportError && (
        <p className="mb-3 rounded-lg border border-danger-edge bg-danger-bg px-3 py-2 text-[12px] leading-snug text-danger">
          {exportError}
        </p>
      )}
      <div ref={rootRef}>
      {artifact.kind === "flashcards" && <FlashcardView data={artifact.data} />}
      {artifact.kind === "quiz" && <QuizView data={artifact.data} />}
      {artifact.kind === "mindmap" && <MindmapView data={artifact.data} />}
      {artifact.kind === "notes" && (
        <pre className="whitespace-pre-wrap text-[13px] leading-relaxed">{artifact.data}</pre>
      )}
      {artifact.kind === "report" && (
        <div
          className="md max-h-[70vh] overflow-y-auto pr-1 text-[13.5px] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(artifact.data) }}
        />
      )}
      {artifact.kind === "research" && <ResearchView data={artifact.data} />}
      {artifact.kind === "audio" && <AudioView data={artifact.data} />}
      </div>
    </Modal>
  );
}

/* ------------------------------ Flashcards ------------------------------ */

function FlashcardView({ data }: { data: string }) {
  const cards: Flashcard[] = useMemo(() => {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed.filter((c) => c?.front && c?.back) : [];
    } catch {
      return [];
    }
  }, [data]);

  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  if (cards.length === 0) return <ParseError />;

  const card = cards[Math.min(index, cards.length - 1)];
  const go = (dir: number) => {
    setFlipped(false);
    setIndex((i) => Math.max(0, Math.min(cards.length - 1, i + dir)));
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        onClick={() => setFlipped((f) => !f)}
        className="flex min-h-44 w-full cursor-pointer items-center justify-center rounded-2xl border border-edge bg-canvas p-8 text-center transition-colors hover:border-ink-3"
      >
        <div>
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-widest text-ink-3">
            {flipped ? "Answer" : "Card"}
          </p>
          <p className="mx-auto max-w-md text-[15px] leading-relaxed">
            {flipped ? card.back : card.front}
          </p>
        </div>
      </button>
      <div className="flex items-center gap-3">
        <IconButton onClick={() => go(-1)} label="Previous card">
          <ChevronLeft size={15} />
        </IconButton>
        <span className="min-w-14 text-center text-[12px] tabular-nums text-ink-3">
          {Math.min(index, cards.length - 1) + 1} / {cards.length}
        </span>
        <IconButton onClick={() => go(1)} label="Next card">
          <ChevronRight size={15} />
        </IconButton>
        <IconButton onClick={() => setFlipped((f) => !f)} label="Flip card">
          <RotateCw size={13} />
        </IconButton>
      </div>
      <p className="text-[11.5px] text-ink-3">Click the card to flip it.</p>
    </div>
  );
}

/* --------------------------------- Quiz --------------------------------- */

function QuizView({ data }: { data: string }) {
  const questions: QuizQuestion[] = useMemo(() => {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed)
        ? parsed.filter((q) => q?.question && Array.isArray(q?.options))
        : [];
    } catch {
      return [];
    }
  }, [data]);

  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);

  if (questions.length === 0) return <ParseError />;

  const q = questions[Math.min(index, questions.length - 1)];
  const clampedIdx = Math.min(index, questions.length - 1);
  const correct = q.answerIndex;

  const choose = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    if (i === correct) setScore((s) => s + 1);
  };

  const next = () => {
    if (clampedIdx + 1 >= questions.length) {
      setDone(true);
      return;
    }
    setIndex(clampedIdx + 1);
    setPicked(null);
  };

  const restart = () => {
    setIndex(0);
    setPicked(null);
    setScore(0);
    setDone(false);
  };

  if (done) {
    const pct = Math.round((score / questions.length) * 100);
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent">
          <Check size={22} strokeWidth={2.2} className="text-accent-ink" />
        </div>
        <p className="text-[18px] font-semibold tracking-tight">
          {score} / {questions.length} correct
        </p>
        <p className="text-[13px] text-ink-3">
          {pct >= 80 ? "Excellent — you know this material well." : pct >= 50 ? "Solid. Review the weak spots and retake." : "Worth another pass through your sources."}
        </p>
        <GhostButton onClick={restart}>Retake quiz</GhostButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-[11.5px] text-ink-3">
        <span className="tabular-nums">
          Question {clampedIdx + 1} of {questions.length}
        </span>
        <span className="tabular-nums">Score: {score}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hover">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${((clampedIdx + (picked !== null ? 1 : 0)) / questions.length) * 100}%` }}
        />
      </div>
      <p className="text-[14.5px] font-medium leading-relaxed">{q.question}</p>
      <div className="flex flex-col gap-2">
        {q.options.map((opt, i) => {
          const isCorrect = i === correct;
          const isPicked = i === picked;
          let cls = "border-edge bg-panel hover:border-ink-3";
          if (picked !== null) {
            if (isCorrect) cls = "border-ok-edge bg-ok-bg";
            else if (isPicked) cls = "border-danger-edge bg-danger-bg";
            else cls = "border-edge-soft bg-panel opacity-60";
          }
          return (
            <button
              key={i}
              onClick={() => choose(i)}
              disabled={picked !== null}
              className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-[13px] transition-colors ${cls}`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-edge text-[11px] font-medium text-ink-3">
                {String.fromCharCode(65 + i)}
              </span>
              {opt}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="anim-fade-up">
          {q.explanation && (
            <p className="mb-3 rounded-lg bg-canvas px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
              {q.explanation}
            </p>
          )}
          <div className="flex justify-end">
            <GhostButton onClick={next}>
              {clampedIdx + 1 >= questions.length ? "See results" : "Next question"}
            </GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Mind map ------------------------------- */

interface TreeNode {
  text: string;
  children: TreeNode[];
}

function parseOutline(data: string): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: { node: TreeNode; depth: number }[] = [];
  for (const raw of data.split("\n")) {
    const m = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    const node: TreeNode = { text: m[2].trim(), children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length === 0) root.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth });
  }
  return root;
}

function MindmapView({ data }: { data: string }) {
  const roots = useMemo(() => parseOutline(data), [data]);
  if (roots.length === 0) return <ParseError />;
  return (
    <div className="flex flex-col gap-2.5">
      {roots.map((n, i) => (
        <Branch key={i} node={n} />
      ))}
    </div>
  );
}

function Branch({ node }: { node: TreeNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="flex items-center gap-2">
        {node.children.length > 0 && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-hover"
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight
              size={11}
              strokeWidth={2.2}
              style={{
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform 120ms",
              }}
            />
          </button>
        )}
        <span
          className={`rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium ${
            node.children.length === 0 ? "ml-6" : ""
          }`}
        >
          {node.text}
        </span>
      </div>
      {open && node.children.length > 0 && (
        <div className="ml-[7px] mt-1.5 flex flex-col gap-1.5 border-l border-edge pl-5">
          {node.children.map((c, i) => (
            <Branch key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ParseError() {
  return (
    <p className="py-6 text-center text-[13px] text-ink-3">
      This artifact couldn't be displayed — its data looks malformed.
    </p>
  );
}

/* ----------------------------- Research view ------------------------------ */

interface ResearchData {
  md: string;
  sources: { title: string; url: string }[];
}

function ResearchView({ data }: { data: string }) {
  const parsed = useMemo((): ResearchData | null => {
    try {
      const d = JSON.parse(data);
      if (typeof d?.md !== "string") return null;
      return {
        md: d.md,
        sources: Array.isArray(d.sources)
          ? d.sources.filter(
              (s: unknown): s is { title: string; url: string } =>
                !!s &&
                typeof (s as { url?: unknown }).url === "string" &&
                /^https?:\/\//.test((s as { url: string }).url)
            )
          : [],
      };
    } catch {
      return null;
    }
  }, [data]);

  if (!parsed) return <ParseError />;

  return (
    <div className="flex flex-col gap-4">
      <div
        className="md max-h-[60vh] overflow-y-auto pr-1 text-[13.5px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.md) }}
      />
      {parsed.sources.length > 0 && (
        <div className="rounded-xl border border-edge-soft bg-canvas p-3.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Sources read · {parsed.sources.length}
          </p>
          <ol className="list-decimal pl-4 text-[12px] leading-relaxed">
            {parsed.sources.map((s, i) => (
              <li key={i} className="truncate">
                <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Audio view ------------------------------ */

interface ScriptTurn {
  speaker: "Alex" | "Sam";
  text: string;
}
interface AudioData {
  audio: string | null;
  script: ScriptTurn[];
  note?: string;
}

function parseAudio(data: string): AudioData | null {
  try {
    const d = JSON.parse(data);
    if (!Array.isArray(d?.script) || d.script.length === 0) return null;
    const script: ScriptTurn[] = d.script
      .filter(
        (t: unknown) =>
          t && typeof t === "object" && "text" in (t as object) && typeof (t as { text: unknown }).text === "string" && (t as { text: string }).text.trim()
      )
      .map((t: { speaker?: unknown; text: string }) => ({
        speaker: String(t.speaker).toLowerCase() === "sam" ? ("Sam" as const) : ("Alex" as const),
        text: t.text.trim(),
      }));
    if (script.length === 0) return null;
    return {
      audio: typeof d.audio === "string" && d.audio.startsWith("data:") ? d.audio : null,
      script,
      note: typeof d.note === "string" ? d.note : undefined,
    };
  } catch {
    return null;
  }
}

const SPEECH_OK = typeof window !== "undefined" && "speechSynthesis" in window;

/** Pick two distinct voices (prefer English) — one per host. */
function pickVoices(): Promise<[SpeechSynthesisVoice | null, SpeechSynthesisVoice | null]> {
  return new Promise((resolve) => {
    const pick = () => {
      const all = window.speechSynthesis.getVoices();
      if (!all.length) return false;
      const en = all.filter((v) => v.lang.toLowerCase().startsWith("en"));
      const pool = en.length >= 2 ? en : all;
      resolve([pool[0] ?? null, pool[1] ?? pool[0] ?? null]);
      return true;
    };
    if (pick()) return;
    window.speechSynthesis.onvoiceschanged = () => pick();
    setTimeout(() => pick(), 1500);
  });
}

function AudioView({ data }: { data: string }) {
  const parsed = useMemo(() => parseAudio(data), [data]);
  const [speaking, setSpeaking] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const runRef = useRef(0);

  // stop speech when the modal unmounts
  useEffect(
    () => () => {
      runRef.current++;
      if (SPEECH_OK) window.speechSynthesis.cancel();
    },
    []
  );

  if (!parsed) return <ParseError />;
  const { audio, script, note } = parsed;

  const stop = () => {
    runRef.current++;
    if (SPEECH_OK) window.speechSynthesis.cancel();
    setSpeaking(false);
    setCurrent(null);
  };

  const play = async () => {
    if (!SPEECH_OK) return;
    stop();
    const run = ++runRef.current;
    const [va, vb] = await pickVoices().catch((): [null, null] => [null, null]);
    if (runRef.current !== run) return;
    setSpeaking(true);
    let i = 0;
    const step = () => {
      if (runRef.current !== run) return;
      if (i >= script.length) {
        setSpeaking(false);
        setCurrent(null);
        return;
      }
      setCurrent(i);
      const u = new SpeechSynthesisUtterance(script[i].text);
      const voice = script[i].speaker === "Alex" ? va : vb;
      if (voice) u.voice = voice;
      u.rate = 1;
      u.onend = () => {
        if (runRef.current === run) {
          i++;
          step();
        }
      };
      u.onerror = u.onend;
      window.speechSynthesis.speak(u);
    };
    step();
  };

  return (
    <div className="flex flex-col gap-3">
      {audio ? (
        <div>
          <audio controls src={audio} className="w-full" />
          <p className="mt-1.5 text-[11px] text-ink-3">
            Synthesized with OpenAI text-to-speech (voices: nova &amp; onyx).
          </p>
        </div>
      ) : SPEECH_OK ? (
        <div className="flex items-center gap-3">
          {speaking ? (
            <GhostButton onClick={stop}>
              <Square size={11} className="mr-1.5 inline" /> Stop
            </GhostButton>
          ) : (
            <GhostButton onClick={play}>
              <Play size={11} className="mr-1.5 inline" /> Play with system voices
            </GhostButton>
          )}
          <span className="text-[11px] text-ink-3">
            Played locally with your Mac's voices{note ? ` · ${note}` : ""}
          </span>
        </div>
      ) : (
        <p className="text-[11px] text-ink-3">
          Read-only script — speech playback isn't available here.
        </p>
      )}

      <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-edge-soft bg-canvas p-3.5">
        {script.map((t, i) => (
          <p
            key={i}
            className={`text-[12.5px] leading-relaxed ${
              current === i ? "-mx-1.5 rounded-md bg-hover-soft px-1.5" : ""
            }`}
          >
            <span className={`font-semibold ${t.speaker === "Alex" ? "text-accent" : "text-ink"}`}>
              {t.speaker}:
            </span>{" "}
            <span className="text-ink-2">{t.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
