/**
 * Built-in transcription (desktop): whisper.cpp bundled with the app, with
 * speech models downloaded on request (src-tauri/src/whisper.rs). This side
 * keeps a cached copy of which models are on disk, so routing can tell
 * synchronously whether built-in transcription is ready.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { platform } from "../platform";
import type { BuiltinWhisperModel } from "./types";

export interface WhisperModelStatus {
  id: BuiltinWhisperModel;
  file: string;
  bytes: number;
  installed: boolean;
}

export interface WhisperStatus {
  /** The whisper-cli program is in this build. */
  available: boolean;
  models: WhisperModelStatus[];
}

/** What each model is for, in Settings. */
export const BUILTIN_MODEL_INFO: Record<BuiltinWhisperModel, { label: string; desc: string }> = {
  fast: { label: "Fast", desc: "Whisper base: quick on any computer, fine for clear speech." },
  accurate: { label: "Accurate", desc: "Whisper large-v3 turbo: much better with accents, noise and names; best with a GPU or Apple Silicon." },
};

let cached: WhisperStatus | null = null;
const listeners = new Set<(s: WhisperStatus) => void>();

/** The last status read from the app; null until the first read (or on the web). */
export function whisperStatusNow(): WhisperStatus | null {
  return cached;
}

/** Fresh status from disk. On the web: unavailable. */
export async function refreshWhisperStatus(): Promise<WhisperStatus> {
  if (platform.kind !== "desktop") return (cached = { available: false, models: [] });
  try {
    cached = await invoke<WhisperStatus>("whisper_status");
  } catch {
    cached = { available: false, models: [] };
  }
  for (const fn of listeners) fn(cached);
  return cached;
}

/** Called with every new status (download finished, model deleted). Returns the unsubscribe. */
export function onWhisperStatus(fn: (s: WhisperStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True/false once known; null before the first status read. */
export function builtinModelReady(id: BuiltinWhisperModel): boolean | null {
  if (!cached) return null;
  return cached.available && !!cached.models.find((m) => m.id === id)?.installed;
}

/** Download a model, with progress as (received, total) bytes. Rejects with "cancelled" when cancelled. */
export async function downloadWhisperModel(id: BuiltinWhisperModel, onProgress?: (received: number, total: number) => void): Promise<void> {
  const unlisten = await listen<{ id: string; received: number; total: number }>("whisper-download", (e) => {
    if (e.payload.id === id) onProgress?.(e.payload.received, e.payload.total);
  });
  try {
    await invoke("whisper_download_model", { id });
  } finally {
    unlisten();
    await refreshWhisperStatus();
  }
}

export function cancelWhisperDownload(id: BuiltinWhisperModel): Promise<void> {
  return invoke("whisper_cancel_download", { id });
}

export async function deleteWhisperModel(id: BuiltinWhisperModel): Promise<void> {
  try {
    await invoke("whisper_delete_model", { id });
  } finally {
    await refreshWhisperStatus();
  }
}

/** Transcribe 16 kHz mono WAV with the built-in model; percent progress as it goes. */
export async function transcribeBuiltin(wav: Uint8Array, id: BuiltinWhisperModel, onProgress?: (percent: number) => void): Promise<string> {
  const unlisten = onProgress ? await listen<number>("whisper-progress", (e) => onProgress(e.payload)) : null;
  try {
    return await invoke<string>("whisper_transcribe", wav, { headers: { "x-whisper-model": id } });
  } finally {
    unlisten?.();
  }
}

export function cancelBuiltinTranscription(): Promise<void> {
  return invoke("whisper_cancel");
}

/** "574 MB" */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
