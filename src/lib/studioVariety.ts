/**
 * Variety for Studio outputs.
 *
 * Studio tools send the same sources and the same prompt every time, so a
 * model hands back nearly the same deck, quiz, map, episode or page on each
 * run. Two things break that up, appended to a tool's prompt:
 *
 * 1. What this notebook already has of that kind (card fronts, questions,
 *    map branches, episode openings, page titles) with "cover different
 *    ground" — so a second quiz asks new questions.
 * 2. When the user gave no focus, a randomly drawn angle (and, for
 *    Interactive, a format) in place of "the most important concepts" —
 *    which has only one answer per notebook.
 *
 * A focus the user typed always wins: no angle is drawn then. Reports and
 * deep research don't use this — fixed report sections are the point, and
 * research already varies with the live web.
 */
import type { Artifact, ArtifactKind } from "./types";

export type VarietyKind = Extract<ArtifactKind, "flashcards" | "quiz" | "mindmap" | "audio" | "interactive">;

/** Lenses to read the sources through when the user gave no focus. */
export const ANGLES: string[] = [
  "how things work: the mechanisms and processes behind the ideas",
  "applications: concrete examples and real-world uses",
  "edge cases, exceptions and limits",
  "comparisons: how ideas, approaches or sources differ",
  "common misconceptions and easily confused ideas",
  "causes and effects: why things happen and what follows from them",
  "key terms and their precise meanings",
  "numbers, data and specific details",
  "the less obvious material beyond the headline ideas",
  "connections between ideas in different parts of the sources",
];

/** Page formats Interactive leans toward when the user gave no topic. */
export const INTERACTIVE_FORMATS: string[] = [
  "a step-by-step guided animation",
  "a hands-on simulation with sliders and live values",
  "a game with a score and instant feedback",
  "an explorable diagram you click into",
  "a side-by-side comparison tool",
  "a sorting, matching or build-it-yourself activity",
  "a timeline or process you can scrub through",
  "a what-if calculator",
];

type Rand = () => number;

const pick = <T,>(list: T[], rand: Rand): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

export const pickAngle = (rand: Rand = Math.random) => pick(ANGLES, rand);
export const pickFormat = (rand: Rand = Math.random) => pick(INTERACTIVE_FORMATS, rand);

/** How many earlier outputs of a kind to look at, and how much of them to quote. */
const PRIOR_OUTPUTS = 5;
const PRIOR_ITEMS = 60;
const PRIOR_CHARS = 2400;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function jsonArray(data: string): unknown[] {
  try {
    const v = JSON.parse(data);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The lines that stand for one earlier output in the "already made" list. */
function summarize(a: Artifact): string[] {
  switch (a.kind) {
    case "flashcards":
      return jsonArray(a.data)
        .map((c) => (c as { front?: unknown })?.front)
        .filter((f): f is string => typeof f === "string" && f.trim() !== "")
        .map((f) => clip(f, 140));
    case "quiz":
      return jsonArray(a.data)
        .map((q) => (q as { question?: unknown })?.question)
        .filter((q): q is string => typeof q === "string" && q.trim() !== "")
        .map((q) => clip(q, 160));
    case "mindmap": {
      // The central topic and its main branches, labels only.
      const lines = a.data.split("\n");
      const label = (l: string) => clip(l.replace(/^\s*[-*]\s+/, "").split(":")[0], 60);
      const root = lines.find((l) => /^[-*]\s+\S/.test(l));
      const branches = lines.filter((l) => /^ {2}[-*]\s+\S/.test(l)).map(label);
      return root ? [`${label(root)} → ${branches.join(", ")}`] : [];
    }
    case "audio": {
      try {
        const script = (JSON.parse(a.data) as { script?: { text?: unknown }[] }).script ?? [];
        const opening = script.find((t) => typeof t?.text === "string")?.text as string | undefined;
        return opening ? [`“${a.title}”, which opened: ${clip(opening, 200)}`] : [`“${a.title}”`];
      } catch {
        return [`“${a.title}”`];
      }
    }
    case "interactive": {
      try {
        const board = String((JSON.parse(a.data) as { storyboard?: unknown }).storyboard ?? "");
        // The storyboard opens with its title, format and goal.
        const head = board
          .split("\n")
          .map((l) => l.replace(/^[#*\-\d.)\s]+/, "").replace(/\*\*/g, "").trim())
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ");
        return [head ? clip(head, 260) : `“${a.title}”`];
      } catch {
        return [`“${a.title}”`];
      }
    }
    default:
      return [];
  }
}

/**
 * A bullet list of what the notebook already has of this kind, newest first,
 * capped so it never crowds out the sources. Empty when there's nothing yet.
 */
export function priorOutputs(kind: VarietyKind, artifacts: Artifact[]): string {
  const lines = artifacts
    .filter((a) => a.kind === kind)
    .sort((x, y) => y.created_at - x.created_at)
    .slice(0, PRIOR_OUTPUTS)
    .flatMap(summarize);
  const unique = [...new Set(lines)].slice(0, PRIOR_ITEMS);
  const out: string[] = [];
  let size = 0;
  for (const l of unique) {
    size += l.length + 3;
    if (size > PRIOR_CHARS) break;
    out.push(`- ${l}`);
  }
  return out.join("\n");
}

const AVOID: Record<VarietyKind, string> = {
  flashcards:
    "This notebook already has flashcards with these fronts. Don't repeat them or ask the same thing in other words; cover material they missed. If the sources are mostly covered, test the same ideas from a clearly different angle.",
  quiz:
    "This notebook already has quizzes with these questions. Don't repeat them or reword them; cover material they missed. If the sources are mostly covered, test the same ideas from a clearly different angle.",
  mindmap:
    "This notebook already has mind maps organized like this. Don't rebuild the same map: choose a different central angle or organizing principle.",
  audio:
    "This notebook already has these episodes. Take a different route through the material: a different opening, emphasis and order.",
  interactive:
    "This notebook already has these interactive pages. Don't rebuild any of them: choose a different idea, or at least a clearly different format and design.",
};

const ANGLE_LEAD: Record<Exclude<VarietyKind, "interactive">, string> = {
  flashcards: "Angle for this deck",
  quiz: "Angle for this quiz",
  mindmap: "Organize this map through this lens",
  audio: "Angle for this episode",
};

/**
 * The variety paragraph for a flashcards, quiz, mind map or audio prompt.
 * `focused` = the user typed a focus, so no angle is drawn.
 */
export function varietyNote(
  kind: Exclude<VarietyKind, "interactive">,
  artifacts: Artifact[],
  opts: { focused: boolean; rand?: Rand }
): string {
  const parts: string[] = [];
  if (!opts.focused) {
    parts.push(
      `${ANGLE_LEAD[kind]}: ${pickAngle(opts.rand)}. Choose what to cover through that lens rather than only the headline concepts, still strictly from my sources. If my sources have little to offer for it, blend it with the core material.`
    );
  }
  if (kind === "audio") {
    parts.push(
      "Open with a fresh hook (a surprising fact, a question, a short scenario or a striking detail from the sources), not a generic welcome."
    );
  }
  const prior = priorOutputs(kind, artifacts);
  if (prior) parts.push(`${AVOID[kind]}\n${prior}`);
  return parts.join("\n\n");
}

/** The "already made" paragraph for an Interactive storyboard; empty when there's nothing yet. */
export function interactivePrior(artifacts: Artifact[]): string {
  const prior = priorOutputs("interactive", artifacts);
  return prior ? `${AVOID.interactive}\n${prior}` : "";
}

/** True when a built flashcards/quiz/mind map prompt carries the user's own focus line. */
export const hasFocus = (prompt: string) => /\bespecially on:/i.test(prompt);

/**
 * Put a variety note into a built prompt just before its output contract
 * ("Format: …" or "Return ONLY …"), so the format rules stay last. Appends
 * when the prompt has neither.
 */
export function withVariety(prompt: string, note: string): string {
  if (!note.trim()) return prompt;
  const m = prompt.match(/\n(?=Format:|Return ONLY\b)/);
  if (!m || m.index === undefined) return `${prompt.trimEnd()}\n\n${note}`;
  return `${prompt.slice(0, m.index).trimEnd()}\n\n${note}\n${prompt.slice(m.index + 1)}`;
}

/* ------------------------------- quiz options ------------------------------- */

/** Options that refer to the others' positions, so shuffling would break them. */
const POSITIONAL = /\b(all|none|both|neither) of the (above|options|answers)\b|^\s*(both\s+)?[A-D]\s+(and|&)\s+[A-D]\s*$|^\s*(only\s+)?[A-D]\s*$/i;

interface QuizItem {
  options?: unknown;
  answerIndex?: unknown;
}

/**
 * Shuffle each question's options (and move answerIndex with them): models
 * tend to put the correct answer in the same slot every time. Questions
 * whose options refer to positions ("All of the above", "A and B") or that
 * look malformed are left as they are.
 */
export function shuffleQuizOptions<T extends QuizItem>(items: T[], rand: Rand = Math.random): T[] {
  return items.map((q) => {
    const opts = q.options;
    const ans = q.answerIndex;
    if (!Array.isArray(opts) || opts.length < 2 || typeof ans !== "number" || ans < 0 || ans >= opts.length) return q;
    if (opts.some((o) => typeof o !== "string" || POSITIONAL.test(o))) return q;
    // Lettered options ("A. Paris") would come out of order.
    if (opts.every((o) => /^\s*\(?[A-Ha-h][.):]\s/.test(o as string))) return q;
    const order = opts.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return { ...q, options: order.map((i) => opts[i]), answerIndex: order.indexOf(ans) };
  });
}
