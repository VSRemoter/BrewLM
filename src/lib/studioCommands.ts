/**
 * Parsing for the Studio-triggering chat commands (/flashcards, /quiz,
 * /mindmap, /audio, /report, /research). Pure functions: they turn raw
 * command text into a StudioCommand for StudioPanel.run plus the user-facing
 * notice/error string and a friendly latest-title for the chat.
 *
 * Syntax: positional keywords first (amount / difficulty / format / length),
 * everything unrecognized joins into the free-text focus. No args at all
 * falls back to the Studio panel's base one-click defaults.
 */

import {
  AUDIO_FORMAT_LABELS,
  AUDIO_LENGTH_LABELS,
  FLASHCARD_COUNTS,
  QUIZ_COUNTS,
  REPORT_FORMATS,
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type Difficulty,
} from "./studio";

/** Audio options without the source scoping (commands always use all sources). */
export type AudioCommandOptions =
  | { format: AudioFormat; length: AudioLength; description: string }
  | null;

export type StudioCommand =
  | { tool: "flashcards" | "quiz"; prompt: string }
  | { tool: "mindmap"; prompt: string }
  | { tool: "report"; label: string; prompt: string }
  | { tool: "audio"; opts: AudioCommandOptions }
  | { tool: "research"; title: string };

export interface StudioParsed {
  cmd: StudioCommand;
  /** "Generating 24 easy flashcards…" — posted before work starts. */
  notice: string;
  /** Short name used when auto-titling the chat. */
  title: string;
}

const cardAmount = (t: string, counts: Record<Amount, number>): Amount | null => {
  if (t === "compact" || t === "default" || t === "more") return t;
  const hit = (Object.entries(counts) as [Amount, number][]).find(([, n]) => String(n) === t);
  return hit ? hit[0] : null;
};

const isDifficulty = (t: string): t is Difficulty =>
  t === "easy" || t === "medium" || t === "hard";

/** amount + difficulty + focus from a token list, for flashcards/quiz. */
function splitCardArgs(
  args: string[],
  counts: Record<Amount, number>
): { amount: Amount; difficulty: Difficulty; focus: string } {
  let amount: Amount = "default";
  let difficulty: Difficulty = "medium";
  const focus: string[] = [];
  for (const tok of args) {
    const t = tok.toLowerCase();
    const a = cardAmount(t, counts);
    if (a) amount = a;
    else if (isDifficulty(t)) difficulty = t;
    else focus.push(tok);
  }
  return { amount, difficulty, focus: focus.join(" ") };
}

const USAGE: Record<string, string> = {
  flashcards: "`/flashcards [8|12|24] [easy|medium|hard] [optional focus]`",
  quiz: "`/quiz [4|8|15] [easy|medium|hard] [optional focus]`",
  mindmap: "`/mindmap [optional focus]`",
  audio: "`/audio [deep-dive|brief|debate|critique] [short|standard|long] [optional focus]`",
  report: "`/report [summary|study-guide|briefing|faq|timeline|analysis|custom <instructions>]`",
  research: "`/research <topic>` — a topic is required",
};

export function parseStudioCommand(raw: string): StudioParsed | string {
  const m = /^\/(\w+)\s*([\s\S]*)$/i.exec(raw);
  if (!m) return "Not a Studio command.";
  const tool = m[1].toLowerCase();
  const rest = m[2].trim();
  const args = rest ? rest.split(/\s+/) : [];

  switch (tool) {
    case "flashcards": {
      const { amount, difficulty, focus } = splitCardArgs(args, FLASHCARD_COUNTS);
      const n = FLASHCARD_COUNTS[amount];
      return {
        cmd: {
          tool,
          prompt: buildFlashcardsPrompt({ amount, difficulty, sourceIds: [], description: focus }),
        },
        notice: `Generating ${n}${difficulty === "medium" ? "" : ` ${difficulty}`} flashcards${focus ? ` — focus: ${focus}` : ""}…`,
        title: "Flashcards",
      };
    }
    case "quiz": {
      const { amount, difficulty, focus } = splitCardArgs(args, QUIZ_COUNTS);
      const n = QUIZ_COUNTS[amount];
      return {
        cmd: {
          tool,
          prompt: buildQuizPrompt({ amount, difficulty, sourceIds: [], description: focus }),
        },
        notice: `Generating a${n === 8 ? "n" : ""} ${n}-question${difficulty === "medium" ? "" : ` ${difficulty}`} quiz${focus ? ` — focus: ${focus}` : ""}…`,
        title: "Quiz",
      };
    }
    case "mindmap":
      return {
        cmd: { tool, prompt: buildMindmapPrompt(rest) },
        notice: `Generating a mind map${rest ? ` — focus: ${rest}` : ""}…`,
        title: "Mind map",
      };
    case "audio": {
      if (args.length === 0) {
        return {
          cmd: { tool, opts: null },
          notice: "Generating an audio overview…",
          title: "Audio overview",
        };
      }
      let format: AudioFormat = "deep-dive";
      let length: AudioLength = "standard";
      const knownFormat = Object.keys(AUDIO_FORMAT_LABELS) as AudioFormat[];
      const knownLength = Object.keys(AUDIO_LENGTH_LABELS) as AudioLength[];
      const focus: string[] = [];
      for (const tok of args) {
        const t = tok.toLowerCase();
        if ((knownFormat as string[]).includes(t)) format = t as AudioFormat;
        else if ((knownLength as string[]).includes(t)) length = t as AudioLength;
        else focus.push(tok);
      }
      const desc = focus.join(" ");
      return {
        cmd: { tool, opts: { format, length, description: desc } },
        notice: `Generating a ${AUDIO_LENGTH_LABELS[length].toLowerCase()} ${AUDIO_FORMAT_LABELS[format].toLowerCase()} audio overview${desc ? ` — focus: ${desc}` : ""}…`,
        title: "Audio overview",
      };
    }
    case "report": {
      if (args.length === 0) {
        const f = REPORT_FORMATS[0]; // Summary is the base one-click report
        return {
          cmd: { tool, label: f.label, prompt: f.prompt },
          notice: `Writing a summary…`,
          title: "Summary",
        };
      }
      const id = args[0].toLowerCase();
      if (id === "custom") {
        const instructions = args.slice(1).join(" ").trim();
        if (!instructions) return USAGE.report;
        return {
          cmd: {
            tool,
            label: "Custom report",
            prompt: buildReportPrompt("custom", instructions),
          },
          notice: `Writing a custom report — ${instructions.slice(0, 60)}${instructions.length > 60 ? "…" : ""}`,
          title: "Custom report",
        };
      }
      if (id === "analysis") {
        return {
          cmd: {
            tool,
            label: "Thorough Analysis",
            prompt: buildReportPrompt("analysis", ""),
          },
          notice: "Writing a thorough analysis…",
          title: "Thorough analysis",
        };
      }
      const f = REPORT_FORMATS.find((x) => x.id === id);
      if (!f) return `Unknown report type “${id}”. ${USAGE.report}`;
      return {
        cmd: { tool, label: f.label, prompt: f.prompt },
        notice: `Writing a ${f.label.toLowerCase()}…`,
        title: f.label,
      };
    }
    case "research": {
      if (!rest) return USAGE.research;
      return {
        cmd: { tool, title: rest },
        notice: `Starting deep research on “${rest}”…`,
        title: rest.length > 40 ? rest.slice(0, 40).trimEnd() + "…" : rest,
      };
    }
    default:
      return `Unknown Studio command “/${tool}”. Try /flashcards, /quiz, /mindmap, /audio, /report, or /research.`;
  }
}
