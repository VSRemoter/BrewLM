/**
 * Revise a Studio output with an instruction: one LLM pass grounded in the
 * notebook's sources, with a per-kind format contract so the result parses.
 * The desktop's Studio panel and Revise from a paired phone (jobRunner.ts)
 * both run this.
 */
import { complete, extractJson, isAbortError } from "./llm";
import { INTERACTIVE_REVISE_FORMAT, parseInteractive, writePage } from "./interactive";
import { MINDMAP_FORMAT } from "./studio";
import { parseScript, scriptLine, synthesizeScript, type ScriptTurn } from "./tts";
import type { Artifact, ArtifactKind, Settings } from "./types";

/** Human-readable content of an artifact, fed to the model for revision. */
export function reviseContent(a: Artifact): string {
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
  if (a.kind === "interactive") return parseInteractive(a.data)?.html ?? a.data;
  return a.data; // mindmap, notes, report
}

/** "Return ONLY…" format contracts per kind — keeps revisions parseable. */
export const REVISE_FORMAT: Record<ArtifactKind, string> = {
  flashcards:
    'Return ONLY the revised flashcards as a JSON array shaped exactly like: [{"front": "question or term", "back": "concise answer"}]',
  quiz:
    'Return ONLY the revised quiz as a JSON array shaped exactly like: [{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why the answer is correct"}]',
  mindmap: `Return ONLY the revised outline. ${MINDMAP_FORMAT}`,
  notes:
    "Return ONLY the revised markdown notes — no preface, no commentary.",
  report:
    "Return ONLY the revised markdown report — no preface, no commentary.",
  research:
    "Return ONLY the revised markdown report — no preface, no commentary. Keep the existing citation style (sources by title/url).",
  drawing: "", // drawings aren't revised by the AI
  interactive: INTERACTIVE_REVISE_FORMAT,
  audio: `Respond with the revised script only: one turn per line, exactly "Host: <line>" or "Co-Host: <line>", alternating and starting with the Host, about as long as the current script unless the instruction says otherwise. The hosts never call each other by name. Spoken language only: no markdown, no emojis, no stage directions.`,
};

/** Solo scripts rewrite with a single-voice contract, so the Co-Host never comes back. */
export const REVISE_FORMAT_AUDIO_SOLO = `Respond with the revised script only: one segment per line, exactly "Host: <line>", by a single narrator who never names themselves, about as long as the current script unless the instruction says otherwise. Spoken language only: no markdown, no emojis, no stage directions.`;

/** A stored audio artifact is solo when every turn belongs to Alex. */
export function isSoloAudio(a: Artifact): boolean {
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
}

/** The request for one revision, without its messages (model, key, usage sink…). */
type ReviseRequest = Omit<Parameters<typeof writePage>[0], "messages" | "onProgress">;

/**
 * The revised output's data, ready to save in place of `a.data` (or as a copy).
 * `system` grounds it in the sources; `reAudio` re-voices a revised script.
 */
export async function reviseOutput(opts: {
  a: Artifact;
  note: string;
  reAudio: boolean;
  settings: Settings;
  system: string;
  request: ReviseRequest;
}): Promise<string> {
  const { a, note, reAudio, settings } = opts;
  const signal = opts.request.signal;
  const revisePrompt = `Here is the current "${a.title}":\n\n${reviseContent(a)}\n\nRevise it according to this instruction: ${note}\n\n${a.kind === "audio" && isSoloAudio(a) ? REVISE_FORMAT_AUDIO_SOLO : REVISE_FORMAT[a.kind]}`;
  const request = {
    ...opts.request,
    messages: [
      { role: "system" as const, content: opts.system },
      { role: "user" as const, content: revisePrompt },
    ],
  };
  // Pages come back as a whole HTML document; writePage extracts and checks it.
  const raw = a.kind === "interactive" ? await writePage(request) : await complete(request);

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
          signal: signal,
        });
        audio = result.audio;
        ttsNote = result.note;
      } catch (e) {
        if (isAbortError(e) || signal.aborted) throw e;
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
  } else if (a.kind === "interactive") {
    const page = parseInteractive(a.data);
    data = JSON.stringify({ html: raw, storyboard: page?.storyboard ?? "" });
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
  return data;
}
