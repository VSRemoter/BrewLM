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
  REPORT_TYPE_LABELS,
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type AudioMode,
  type Difficulty,
  type ReportType,
} from "./studio";

/** Audio options without the source scoping (commands always use all sources). */
export type AudioCommandOptions =
  | { format: AudioFormat; length: AudioLength; mode: AudioMode; description: string }
  | null;

/** Optional scoping a command can carry (chat's make_study_item uses it; typed commands don't). */
interface Scoped {
  /** Only these sources (empty or absent = all of them). */
  sourceIds?: string[];
  /** The Studio item's name, instead of the tool's. */
  title?: string;
}

export type StudioCommand =
  | ({ tool: "flashcards" | "quiz"; prompt: string } & Scoped)
  | ({ tool: "mindmap"; prompt: string } & Scoped)
  | ({ tool: "report"; label: string; prompt: string } & Scoped)
  | { tool: "audio"; opts: AudioCommandOptions }
  | { tool: "research"; title: string };

export interface StudioParsed {
  cmd: StudioCommand;
  /** "Generating 24 easy flashcards…" — posted before work starts. */
  notice: string;
  /** Short name used when auto-titling the chat. */
  title: string;
}

/**
 * Settings → Studio Defaults, threaded into parsing so a bare /flashcards or
 * /audio honors the user's configured defaults. Explicit args still win.
 */
export type StudioDefaults = {
  defFlashcardsAmount?: Amount;
  defFlashcardsDifficulty?: Difficulty;
  defQuizAmount?: Amount;
  defQuizDifficulty?: Difficulty;
  defAudioMode?: AudioMode;
  defAudioFormat?: AudioFormat;
  defAudioLength?: AudioLength;
  defReportType?: ReportType;
};

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
  counts: Record<Amount, number>,
  defAmount: Amount = "default",
  defDifficulty: Difficulty = "medium"
): { amount: Amount; difficulty: Difficulty; focus: string } {
  let amount: Amount = defAmount;
  let difficulty: Difficulty = defDifficulty;
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
  audio: "`/audio [solo] [deep-dive|brief|debate|critique] [short|standard|long] [optional focus]`",
  report: "`/report [summary|study-guide|briefing|faq|timeline|analysis|custom <instructions>]`",
  research: "`/research <topic>` — a topic is required",
};

export function parseStudioCommand(raw: string, defs: StudioDefaults = {}): StudioParsed | string {
  const m = /^\/(\w+)\s*([\s\S]*)$/i.exec(raw);
  if (!m) return "Not a Studio command.";
  const tool = m[1].toLowerCase();
  const rest = m[2].trim();
  const args = rest ? rest.split(/\s+/) : [];

  switch (tool) {
    case "flashcards": {
      const { amount, difficulty, focus } = splitCardArgs(
        args,
        FLASHCARD_COUNTS,
        defs.defFlashcardsAmount,
        defs.defFlashcardsDifficulty
      );
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
      const { amount, difficulty, focus } = splitCardArgs(
        args,
        QUIZ_COUNTS,
        defs.defQuizAmount,
        defs.defQuizDifficulty
      );
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
      // Bare /audio flows through the same path: unspecified dims come from
      // the user's Studio Defaults (or the base fallbacks when unset).
      let format: AudioFormat = defs.defAudioFormat ?? "deep-dive";
      let length: AudioLength = defs.defAudioLength ?? "standard";
      let mode: AudioMode = defs.defAudioMode ?? "conversation";
      const knownFormat = Object.keys(AUDIO_FORMAT_LABELS) as AudioFormat[];
      const knownLength = Object.keys(AUDIO_LENGTH_LABELS) as AudioLength[];
      const focus: string[] = [];
      for (const tok of args) {
        const t = tok.toLowerCase();
        if ((knownFormat as string[]).includes(t)) format = t as AudioFormat;
        else if ((knownLength as string[]).includes(t)) length = t as AudioLength;
        else if (t === "solo") mode = "solo";
        else if (t === "conversation" || t === "duo") mode = "conversation";
        else focus.push(tok);
      }
      const desc = focus.join(" ");
      return {
        cmd: { tool, opts: { format, length, mode, description: desc } },
        notice: `Generating a ${mode === "solo" ? "solo " : ""}${AUDIO_LENGTH_LABELS[length].toLowerCase()} ${AUDIO_FORMAT_LABELS[format].toLowerCase()} audio overview${desc ? ` — focus: ${desc}` : ""}…`,
        title: "Audio overview",
      };
    }
    case "report": {
      if (args.length === 0) {
        // Bare /report → the user's default report type (Summary when unset;
        // "custom" can't be a bare default — it needs instructions).
        const t = defs.defReportType;
        if (t && t !== "custom") {
          return {
            cmd: { tool, label: REPORT_TYPE_LABELS[t], prompt: buildReportPrompt(t, "") },
            notice: `Writing a ${REPORT_TYPE_LABELS[t].toLowerCase()}…`,
            title: REPORT_TYPE_LABELS[t],
          };
        }
        const f = REPORT_FORMATS[0]; // Summary is the base one-click report
        return {
          cmd: { tool, label: f.label, prompt: f.prompt },
          notice: "Writing a summary…",
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

/* ------------------------- chat's make_study_item ------------------------- */

/** What chat's study tool may make: the quick, text-only Studio tools. No audio (voices cost extra), no deep research (web searches). */
export const STUDY_KINDS = ["flashcards", "quiz", "mindmap", "report"] as const;
export type StudyKind = (typeof STUDY_KINDS)[number];
/** Report types it may write (not "custom": free-form instructions stay with the user). */
export const STUDY_REPORTS = ["summary", "study-guide", "faq", "timeline", "briefing", "analysis"] as const;
export type StudyReport = (typeof STUDY_REPORTS)[number];

export interface StudyRequest {
  kind: StudyKind;
  /** Snapped to the nearest size Studio offers. */
  count?: number;
  difficulty?: Difficulty;
  focus?: string;
  report?: StudyReport;
  /** Already resolved to ids; empty = every source. */
  sourceIds: string[];
}

/** Longest focus kept, in characters. */
export const STUDY_FOCUS_MAX = 200;

/** The allowed size nearest to `n` (ties go to the smaller). */
function nearest(counts: Record<Amount, number>, n: number): Amount {
  const sizes = (Object.entries(counts) as [Amount, number][]).sort((a, b) => a[1] - b[1]);
  return sizes.reduce((best, cur) => (Math.abs(cur[1] - n) < Math.abs(best[1] - n) ? cur : best))[0];
}

/**
 * A Studio command from chat's study tool, built only from fixed choices
 * (kind, a size Studio offers, a difficulty, a report type) plus a short
 * focus. `what` describes it for the approval card ("a 8-question hard quiz
 * on NULL functions"). A string is a reason it can't be made.
 */
export function studyCommand(
  req: StudyRequest,
  defs: StudioDefaults = {}
): { cmd: StudioCommand; what: string; title: string } | string {
  if (!(STUDY_KINDS as readonly string[]).includes(req.kind)) return `It can make ${STUDY_KINDS.join(", ")}; not “${String(req.kind)}”.`;
  const focus = (req.focus ?? "").replace(/\s+/g, " ").trim().slice(0, STUDY_FOCUS_MAX);
  const on = focus ? ` on “${focus}”` : "";
  // The item's name: the focus up to its first clause, cut at a word if it's still long.
  const short = (() => {
    const clause = focus.split(/[:;(,—–]/)[0].trim() || focus;
    if (clause.length <= 40) return clause;
    const cut = clause.slice(0, 40);
    return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 40).trimEnd()}…`;
  })();
  const named = (base: string) => (focus ? `${base}: ${short}` : base);
  const difficulty: Difficulty | undefined =
    req.difficulty && isDifficulty(req.difficulty) ? req.difficulty : undefined;
  const scope = { sourceIds: req.sourceIds };
  switch (req.kind) {
    case "flashcards": {
      const amount = req.count ? nearest(FLASHCARD_COUNTS, req.count) : (defs.defFlashcardsAmount ?? "default");
      const d = difficulty ?? defs.defFlashcardsDifficulty ?? "medium";
      const title = named("Flashcards");
      return {
        cmd: { tool: "flashcards", prompt: buildFlashcardsPrompt({ amount, difficulty: d, sourceIds: [], description: focus }), title, ...scope },
        what: `${FLASHCARD_COUNTS[amount]} ${d} flashcards${on}`,
        title,
      };
    }
    case "quiz": {
      const amount = req.count ? nearest(QUIZ_COUNTS, req.count) : (defs.defQuizAmount ?? "default");
      const d = difficulty ?? defs.defQuizDifficulty ?? "medium";
      const title = named("Quiz");
      return {
        cmd: { tool: "quiz", prompt: buildQuizPrompt({ amount, difficulty: d, sourceIds: [], description: focus }), title, ...scope },
        what: `${QUIZ_COUNTS[amount] === 8 ? "an" : "a"} ${QUIZ_COUNTS[amount]}-question ${d} quiz${on}`,
        title,
      };
    }
    case "mindmap": {
      const title = named("Mind map");
      return { cmd: { tool: "mindmap", prompt: buildMindmapPrompt(focus), title, ...scope }, what: `a mind map${on}`, title };
    }
    case "report": {
      const type: StudyReport = req.report && (STUDY_REPORTS as readonly string[]).includes(req.report) ? req.report : "study-guide";
      const f = REPORT_FORMATS.find((x) => x.id === type);
      const label = f?.label ?? "Thorough Analysis";
      const base = f?.prompt ?? buildReportPrompt("analysis", "");
      // A focus narrows the report; the report's own rules stay as they are.
      const prompt = focus ? `${base}\n\nFocus especially on: ${focus}.` : base;
      const title = named(label);
      return { cmd: { tool: "report", label: title, prompt, title, ...scope }, what: `a ${label === "FAQ" ? label : label.toLowerCase()}${on}`, title };
    }
  }
}
