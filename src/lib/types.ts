export interface Notebook {
  id: string;
  title: string;
  description: string;
  /** SQLite boolean: 1 = pinned to the top of the homepage. */
  starred: number;
  /** Data-URL banner image for the homepage grid card ("" = none). Not shown in list view. */
  cover: string;
  /** Data-URL image behind the chat area ("" = none). */
  chat_bg: string;
  /** Readability overlay over chat_bg: 0–80 (percent of dark scrim). */
  chat_bg_dim: number;
  /** Folder this notebook lives in ("" = homepage root). */
  folder_id: string;
  /** 0 = live; otherwise the timestamp it was sent to the homepage Trash. */
  trashed_at: number;
  /** SQLite boolean: 1 = chat answers grounded in sources (default); 0 = free-form. */
  grounded: number;
  created_at: number;
  updated_at: number;
}

/** Homepage folder grouping notebooks. */
export interface Folder {
  id: string;
  name: string;
  description: string;
  /** Data-URL banner image for the homepage grid card ("" = none). Not shown in list view. */
  cover: string;
  created_at: number;
}

export type SourceType = "context" | "pdf" | "text" | "link" | "image" | "audio" | "file";

export interface Source {
  id: string;
  notebook_id: string;
  type: SourceType;
  title: string;
  content: string;
  mime: string | null;
  created_at: number;
}

/** One retrievable slice of a source (see rag.ts). Embedding is a JSON number[]. */
export interface SourceChunk {
  id: string;
  source_id: string;
  notebook_id: string;
  seq: number;
  /** PDF page the chunk came from, when known. */
  page: number | null;
  text: string;
  /** JSON-serialized embedding vector; "" when indexed with the BM25 fallback. */
  embedding: string;
}

export interface ChatMessage {
  id: string;
  notebook_id: string;
  chat_id: string | null;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

/** A saved conversation thread within a notebook. */
export interface Chat {
  id: string;
  notebook_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export type ArtifactKind = "flashcards" | "quiz" | "mindmap" | "notes" | "report" | "audio" | "research";

export interface Artifact {
  id: string;
  notebook_id: string;
  kind: ArtifactKind;
  title: string;
  data: string;
  created_at: number;
}

export type Provider = "openrouter" | "openai" | "anthropic";

/** Where Audio overviews get their voices from. */
export type TtsProvider = "system" | "openai" | "openrouter" | "elevenlabs";

export interface Settings {
  provider: Provider;
  openrouterKey: string;
  openaiKey: string;
  anthropicKey: string;
  model: string;
  theme: string;
  /** UI font id from fonts.ts ("system" follows the theme's default stack). */
  font: string;
  /** Text-to-speech for studio audio. Independent of the chat provider. */
  ttsProvider: TtsProvider;
  /** Dedicated TTS key for OpenAI; falls back to openaiKey when empty. */
  openaiTtsKey: string;
  /** Dedicated TTS key for OpenRouter; falls back to openrouterKey when empty. */
  openrouterTtsKey: string;
  elevenlabsKey: string;
  /** Empty → provider default. */
  ttsModel: string;
  ttsVoiceAlex: string;
  ttsVoiceSam: string;
  /** Direction for how the hosts should sound (tone, pace, accent…). OpenAI TTS only. */
  ttsInstructions: string;
}

export interface Flashcard {
  front: string;
  back: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
}
