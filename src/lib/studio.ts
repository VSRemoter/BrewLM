/**
 * Studio tool customization: option maps, labels, and prompt builders.
 *
 * The customize modals (StudioCustomize.tsx) collect these options from the
 * user; StudioPanel feeds the built prompts into the same generation pipeline
 * the default one-click tools use. Default behavior is untouched — everything
 * here only runs when the user opens a tool's customize modal.
 */

/* ------------------------------- option types ------------------------------ */

// Canonical definitions live in types.ts (Settings references them); re-exported
// here so existing imports from this module keep working.
import type {
  Amount,
  AudioFormat,
  AudioLength,
  AudioMode,
  Difficulty,
  ReportType,
} from "./types";
export type { Amount, AudioFormat, AudioLength, AudioMode, Difficulty, ReportType } from "./types";

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
  mode: AudioMode;
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

export const AUDIO_MODE_LABELS: Record<AudioMode, string> = {
  conversation: "Conversation",
  solo: "Solo",
};

export const AUDIO_MODE_DESCS: Record<AudioMode, string> = {
  conversation: "Two hosts — the Host and Co-Host — talk it through together.",
  solo: "One narrator (the Host's voice) talks you through the material.",
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

/** Outline contract for mind maps (generation and revision) — see lib/mindmap.ts. */
export const MINDMAP_FORMAT = `Format: a nested markdown bullet outline. Use "-" bullets and indent each nested level by exactly two spaces.
- Exactly one top-level bullet: the central topic. Under it, 3-6 main branches, going 2-4 levels deeper where the sources support it.
- Write every node as "Label: definition" — a short label (6 words max), a colon, then a one-line definition or explanation from the sources (20 words max).`;

export function buildMindmapPrompt(description: string): string {
  return `Create a mind map of the key ideas in my sources.${
    description ? `\nFocus the map especially on: ${description}.` : ""
  }
${MINDMAP_FORMAT}
Return ONLY the outline, no commentary.`;
}

/* ------------------------------ audio builder ------------------------------ */

/** Target episode length per setting. */
export const AUDIO_LENGTH_MINUTES: Record<AudioLength, number> = {
  short: 5,
  standard: 10,
  long: 20,
};

/** Conversational speaking pace used to turn minutes into a word budget. */
const WORDS_PER_MINUTE = 150;

/**
 * Parts an episode is written in. Short fits one request; longer episodes are
 * outlined first and each part written on its own, so small models never have
 * to produce thousands of words in one go.
 */
export const AUDIO_LENGTH_PARTS: Record<AudioLength, number> = {
  short: 1,
  standard: 3,
  long: 6,
};

export function audioWordTarget(length: AudioLength): number {
  return AUDIO_LENGTH_MINUTES[length] * WORDS_PER_MINUTE;
}

const AUDIO_FORMAT_RULES: Record<AudioFormat, string> = {
  "deep-dive":
    "Thoroughly explore the material: walk through the key ideas, explain why they matter, and unpack the most interesting examples.",
  brief:
    "Be tight and punchy: only the essentials, short lines, no digressions or tangents.",
  debate:
    "The hosts take opposing positions on the material's central claims — the Host argues for, the Co-Host argues against. They challenge each other directly, concede genuinely good points, and close by synthesizing where they each land.",
  critique:
    "The hosts critically analyze the material: what holds up, what's weak, hidden assumptions, gaps in coverage, and questionable claims — ending with an overall verdict.",
};

/** Single-narrator variants — debate/critique explicitly fold both sides into one voice. */
const SOLO_FORMAT_RULES: Record<AudioFormat, string> = {
  "deep-dive":
    "Thoroughly explore the material: walk through the key ideas, explain why they matter, and unpack the most interesting examples.",
  brief:
    "Be tight and punchy: only the essentials, short lines, no digressions or tangents.",
  debate:
    "Weigh the material's central claims from opposing angles: argue the case for, then steelman the case against, concede the strongest counterpoints, and close on a synthesized view.",
  critique:
    "Critically analyze the material: what holds up, what's weak, hidden assumptions, gaps in coverage, and questionable claims — ending with an overall verdict.",
};

/** Who speaks, the line format and the style rules shared by every audio prompt. */
function audioVoiceRules(opts: AudioOptions): string {
  if (opts.mode === "solo") {
    return `Voiced by a single narrator, the Host.

Format: ${AUDIO_FORMAT_LABELS[opts.format]} — ${SOLO_FORMAT_RULES[opts.format]}

Output EXACTLY one segment per line, in this exact format:
Host: <spoken line>

Rules:
- Spoken language only: no markdown, no headings, no bullet points, no emojis, no stage directions or sound-effects like [intro music].
- Natural, engaging narration — like a knowledgeable friend talking you through the material.
- The narrator never gives themselves a name.
- Stay strictly grounded in the sources — no fabricated facts.`;
  }
  return `Performed by two hosts: the Host (explains clearly) and the Co-Host (curious, engaged).

Format: ${AUDIO_FORMAT_LABELS[opts.format]} — ${AUDIO_FORMAT_RULES[opts.format]}

Output EXACTLY one turn per line, in this exact format:
Host: <spoken line>
Co-Host: <spoken line>

Rules:
- Alternate naturally; most turns are 2–4 sentences.
- Spoken language only: no markdown, no headings, no bullet points, no emojis, no stage directions or sound-effects like [intro music].
- Conversational and lively: the hosts react, question, and paraphrase each other.
- The hosts never call each other or themselves by name.
- Stay strictly grounded in the sources — no fabricated facts.`;
}

const audioFocus = (opts: AudioOptions) =>
  opts.description ? `\nFocus especially on: ${opts.description}.` : "";

/** One-request script (Short episodes, and the fallback when an outline fails). */
export function buildAudioPrompt(opts: AudioOptions): string {
  const minutes = AUDIO_LENGTH_MINUTES[opts.length];
  return `You are writing a ${minutes}-minute podcast-style "audio overview" of my sources. ${audioVoiceRules(opts)}

Length: about ${audioWordTarget(opts.length)} spoken words in total (≈${minutes} minutes read aloud) — cover the material in real depth rather than skimming.${audioFocus(opts)}
Open by naming what this episode covers ${opts.mode === "solo" ? "and start with the Host" : "with the Host speaking first"}; close with the 2–3 biggest takeaways.`;
}

/** Step 1 of a long episode: plan its parts. */
export function buildAudioOutlinePrompt(opts: AudioOptions): string {
  const parts = AUDIO_LENGTH_PARTS[opts.length];
  return `Plan a ${AUDIO_LENGTH_MINUTES[opts.length]}-minute podcast-style "audio overview" of my sources (${AUDIO_FORMAT_LABELS[opts.format]} — ${opts.mode === "solo" ? SOLO_FORMAT_RULES[opts.format] : AUDIO_FORMAT_RULES[opts.format]}).${audioFocus(opts)}

Split it into exactly ${parts} consecutive parts that together cover the most important material in my sources, in a sensible teaching order. The first part introduces the topic; the last part ends with the biggest takeaways.

Return ONLY ${parts} lines, one per part, in this format:
<short part title> — <one sentence on what this part covers, naming the specific concepts from the sources>`;
}

/** Step 2 of a long episode: write one part, continuing from the previous one. */
export function buildAudioSectionPrompt(
  opts: AudioOptions,
  outline: string[],
  index: number,
  previousLines: string
): string {
  const parts = outline.length;
  const words = Math.round(audioWordTarget(opts.length) / parts);
  const first = index === 0;
  const last = index === parts - 1;
  const position = first
    ? `This is the opening part: open by naming what this episode covers${opts.mode === "solo" ? "" : ", with the Host speaking first"}.`
    : last
      ? "This is the final part: wrap up with the 2–3 biggest takeaways of the whole episode and a short sign-off."
      : "This is a middle part: no greetings, intros or sign-offs — carry straight on from where the previous part stopped.";
  return `You are writing part ${index + 1} of ${parts} of a podcast-style "audio overview" of my sources. ${audioVoiceRules(opts)}

Episode plan:
${outline.map((o, i) => `${i + 1}. ${o}`).join("\n")}

Write ONLY part ${index + 1}: ${outline[index]}
Length: about ${words} spoken words for this part. Go into real depth on this part's material; leave the other parts' topics to them.
${position}${previousLines ? `\n\nThe previous part ended with:\n${previousLines}\n\nContinue naturally from there without repeating it.` : ""}${audioFocus(opts)}`;
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
