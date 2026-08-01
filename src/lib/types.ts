export interface Notebook {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
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

export interface Settings {
  provider: Provider;
  openrouterKey: string;
  openaiKey: string;
  anthropicKey: string;
  model: string;
  theme: string;
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
