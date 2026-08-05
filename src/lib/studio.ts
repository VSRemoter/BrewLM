/**
 * Studio tool customization: option maps, labels, and prompt builders.
 *
 * The customize modals (StudioCustomize.tsx) collect these options from the
 * user; StudioPanel feeds the built prompts into the same generation pipeline
 * the default one-click tools use. Default behavior is untouched — everything
 * here only runs when the user opens a tool's customize modal.
 */

/* ------------------------------- option types ------------------------------ */

export type Amount = "compact" | "default" | "more";
export type Difficulty = "easy" | "medium" | "hard";
export type AudioFormat = "deep-dive" | "brief" | "debate" | "critique";
export type AudioLength = "short" | "standard" | "long";
export type ReportType = "study-guide" | "briefing-doc" | "analysis" | "custom";

export interface FlashcardsOptions {
  amount: Amount;
  difficulty: Difficulty;
  sourceIds: string[];
  description: string;
  /** Custom name for the saved artifact (falls back to the tool default). */
  title?: string;
}

export interface QuizOptions {
  amount: Amount;
  difficulty: Difficulty;
  sourceIds: string[];
  description: string;
  /** Custom name for the saved artifact (falls back to the tool default). */
  title?: string;
}

export interface MindmapOptions {
  sourceIds: string[];
  description: string;
  /** Custom name for the saved artifact (falls back to the tool default). */
  title?: string;
}

export interface AudioOptions {
  format: AudioFormat;
  length: AudioLength;
  sourceIds: string[];
  description: string;
  /** Custom name for the saved artifact (falls back to the tool default). */
  title?: string;
}

export interface ReportOptions {
  type: ReportType;
  customPrompt: string;
  sourceIds: string[];
  /** Custom name for the saved artifact (falls back to the report type label). */
  title?: string;
}

/* ------------------------------ labels & counts ---------------------------- */

export const FLASHCARD_COUNTS: Record<Amount, number> = {
  compact: 8,
  default: 12,
  more: 24,
};

export const QUIZ_COUNTS: Record<Amount, number> = {
  compact: 4,
  default: 8,
  more: 15,
};

export const AMOUNT_LABELS: Record<Amount, string> = {
  compact: "Compact",
  default: "Default",
  more: "More",
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export const AUDIO_FORMAT_LABELS: Record<AudioFormat, string> = {
  "deep-dive": "Deep Dive",
  brief: "Brief",
  debate: "Debate",
  critique: "Critique",
};

export const AUDIO_FORMAT_DESCS: Record<AudioFormat, string> = {
  "deep-dive": "Thorough walk-through of the material's key ideas.",
  brief: "Just the essentials — tight and punchy.",
  debate: "Hosts argue opposing sides, then synthesize.",
  critique: "Hosts judge strengths, weaknesses, and gaps.",
};

export const AUDIO_LENGTH_LABELS: Record<AudioLength, string> = {
  short: "Short",
  standard: "Standard",
  long: "Long",
};

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  "study-guide": "Study Guide",
  "briefing-doc": "Briefing Doc",
  analysis: "Thorough Analysis",
  custom: "Custom",
};

/* ------------------------- flashcards / quiz builders ---------------------- */

const DIFFICULTY_HINTS: Record<Difficulty, { flashcards: string; quiz: string }> = {
  easy: {
    flashcards: "basic recall — definitions and key facts, one clear concept per card",
    quiz: "basic recall — straightforward questions on definitions and facts",
  },
  medium: {
    flashcards: "understanding — connections between ideas and applied concepts",
    quiz: "understanding — questions that apply and connect the ideas",
  },
  hard: {
    flashcards: "mastery — nuanced distinctions, analysis, and edge cases",
    quiz: "mastery — tricky questions with genuinely plausible distractors, analysis and edge cases",
  },
};

export function buildFlashcardsPrompt(opts: FlashcardsOptions): string {
  const count = FLASHCARD_COUNTS[opts.amount];
  return `Create exactly ${count} flashcards covering the most important concepts in my sources.
Difficulty: ${opts.difficulty} — aim for ${DIFFICULTY_HINTS[opts.difficulty].flashcards}.${
    opts.description ? `\nFocus especially on: ${opts.description}.` : ""
  }
Return ONLY a JSON array, no commentary, shaped exactly like:
[{"front": "question or term", "back": "concise answer"}]`;
}

export function buildQuizPrompt(opts: QuizOptions): string {
  const count = QUIZ_COUNTS[opts.amount];
  return `Create exactly ${count} multiple-choice questions covering the most important concepts in my sources.
Difficulty: ${opts.difficulty} — aim for ${DIFFICULTY_HINTS[opts.difficulty].quiz}.${
    opts.description ? `\nFocus especially on: ${opts.description}.` : ""
  }
Return ONLY a JSON array, no commentary, shaped exactly like:
[{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why the answer is correct"}]`;
}

export function buildMindmapPrompt(description: string): string {
  return `Create a mind map of the key ideas in my sources as a nested markdown bullet outline.${
    description ? `\nFocus the map especially on: ${description}.` : ""
  }
Rules: use "-" bullets, indent nested levels by exactly two spaces, keep each node under 8 words, 3-6 top-level branches, 2-4 levels deep. Return ONLY the outline, no commentary.`;
}

/* ------------------------------ audio builder ------------------------------ */

/** Turn targets per length — must stay within parseScript's 24-turn cap. */
const AUDIO_LENGTH_TURNS: Record<AudioLength, string> = {
  short: "8",
  standard: "15",
  long: "22",
};

const AUDIO_FORMAT_RULES: Record<AudioFormat, string> = {
  "deep-dive":
    "Thoroughly explore the material: walk through the key ideas, explain why they matter, and unpack the most interesting examples.",
  brief:
    "Be tight and punchy: only the essentials, short lines, no digressions or tangents.",
  debate:
    "The hosts take opposing positions on the material's central claims — Alex argues for, Sam argues against. They challenge each other directly, concede genuinely good points, and close by synthesizing where they each land.",
  critique:
    "The hosts critically analyze the material: what holds up, what's weak, hidden assumptions, gaps in coverage, and questionable claims — ending with an overall verdict.",
};

export function buildAudioPrompt(opts: AudioOptions): string {
  return `You are writing a podcast-style "audio overview" of my sources, performed by two hosts: Alex (curious explainer) and Sam (engaged co-host).

Format: ${AUDIO_FORMAT_LABELS[opts.format]} — ${AUDIO_FORMAT_RULES[opts.format]}
Length: about ${AUDIO_LENGTH_TURNS[opts.length]} dialogue turns total.${
    opts.description ? `\nFocus the conversation especially on: ${opts.description}.` : ""
  }

Output EXACTLY one turn per line, in this exact format:
Alex: <spoken line>
Sam: <spoken line>

Rules:
- Start with Alex and alternate naturally.
- Spoken language only: no markdown, no headings, no bullet points, no emojis, no stage directions or sound-effects like [intro music].
- Conversational and lively: the hosts react, question, and paraphrase each other.
- Open by naming what this episode covers; close with the 2–3 biggest takeaways.
- Stay strictly grounded in the sources — no fabricated facts.`;
}

/* ------------------------------ report builder ----------------------------- */

/** Grounding rules shared by every report prompt (also used by the default formats). */
export const REPORT_RULES = `Rules: output ONLY the document itself in GitHub-flavored markdown — no preface, no "here is", no trailing questions. Use ## headings, bullets, and **bold** for key terms. Ground everything in the sources; cite specific facts with the source title in parentheses, e.g. (Source: Week 4 lecture.pdf). Never invent facts.`;

export const PROMPT_STUDY_GUIDE = `Create a study guide for my sources with: ## Key concepts (each with a short explanation), ## Important terms & definitions, ## Example questions (with answers folded in), and ## Study checklist. ${REPORT_RULES}`;

export const PROMPT_BRIEFING = `Write a briefing document on my sources with sections: ## Overview, ## Main themes, ## Key insights, ## Notable facts & quotes, and ## Open questions. ${REPORT_RULES}`;

export const PROMPT_ANALYSIS = `Write a thorough analysis of my sources with sections: ## Overview, ## Detailed analysis (organized by theme), ## Evidence & evaluation, ## Contradictions & gaps, and ## Conclusions. Go deep — surface nuance, evaluate claims against the evidence, and don't shy away from length. ${REPORT_RULES}`;

/** One-click report formats — also the choices for `/report <type>` in chat. */
export const REPORT_FORMATS: { id: string; label: string; desc: string; prompt: string }[] = [
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
    prompt: PROMPT_STUDY_GUIDE,
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
    prompt: PROMPT_BRIEFING,
  },
];

const REPORT_TYPE_PROMPTS: Record<Exclude<ReportType, "custom">, string> = {
  "study-guide": PROMPT_STUDY_GUIDE,
  "briefing-doc": PROMPT_BRIEFING,
  analysis: PROMPT_ANALYSIS,
};

/** Custom reports use the user's own instructions plus the shared grounding rules. */
export function buildReportPrompt(type: ReportType, customPrompt: string): string {
  if (type === "custom") return `${customPrompt.trim()}\n\n${REPORT_RULES}`;
  return REPORT_TYPE_PROMPTS[type];
}
