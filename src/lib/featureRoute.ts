/**
 * Where each media job runs (Settings → Local models).
 *
 * Image reading and transcription each have a "Runs on" choice. Automatic
 * follows the chat provider: with a cloud provider, the chat provider is tried
 * first and any other cloud key is the backup (as before); with a local chat
 * model, the job runs on this computer or not at all. A saved cloud key is
 * never used behind the user's back while they've chosen local.
 *
 * Pure: callers pass `hasKey`, so this stays testable without the database.
 */
import type { Provider, RunsOn, Settings } from "./types";

export type MediaFeature = "vision" | "transcribe";

/** Cloud providers that can do each job, in backup order. */
export const CLOUD_PROVIDERS: Record<MediaFeature, Provider[]> = {
  vision: ["openai", "openrouter", "anthropic", "brewlm"],
  transcribe: ["openai", "openrouter", "brewlm"],
};

/** Jobs a local server can do in this build. */
export const LOCAL_CAPABLE: Record<MediaFeature, boolean> = { vision: true, transcribe: false };

type RouteSettings = Pick<
  Settings,
  "provider" | "visionRunsOn" | "transcribeRunsOn" | "localBaseUrl" | "localVisionModel"
>;

export function runsOn(s: RouteSettings, f: MediaFeature): RunsOn {
  return (f === "vision" ? s.visionRunsOn : s.transcribeRunsOn) ?? "auto";
}

/** True when the job must stay on this computer: set to Local, or Automatic with a local chat model. */
export function staysLocal(s: RouteSettings, f: MediaFeature): boolean {
  const r = runsOn(s, f);
  return r === "local" || (r === "auto" && s.provider === "local");
}

/** True when this computer is set up to do the job. */
export function localReady(s: RouteSettings, f: MediaFeature): boolean {
  if (!LOCAL_CAPABLE[f] || !s.localBaseUrl.trim()) return false;
  return f === "vision" ? !!s.localVisionModel.trim() : false;
}

/** Providers to try for a job, in order; [] when nothing is set up for it. */
export function featureProviders(s: RouteSettings, f: MediaFeature, hasKey: (p: Provider) => boolean): Provider[] {
  if (staysLocal(s, f)) return localReady(s, f) ? ["local"] : [];
  const allowed = CLOUD_PROVIDERS[f];
  const r = runsOn(s, f);
  if (r !== "auto") return allowed.includes(r) && hasKey(r) ? [r] : [];
  const order = [s.provider, ...allowed.filter((p) => p !== s.provider)];
  return order.filter((p) => allowed.includes(p) && hasKey(p));
}

/**
 * While chat runs locally, the jobs that would send source material to a
 * cloud service on their own, in words (for the chat footer). [] when chat
 * isn't local. /image isn't listed: it sends only the prompt typed with it.
 */
export function cloudJobsWhileLocal(
  s: RouteSettings & Pick<Settings, "ttsProvider">,
  hasKey: (p: Provider) => boolean
): string[] {
  if (s.provider !== "local") return [];
  const out: string[] = [];
  if (!staysLocal(s, "vision") && featureProviders(s, "vision", hasKey).length) out.push("image reading");
  if (!staysLocal(s, "transcribe") && featureProviders(s, "transcribe", hasKey).length) out.push("transcription");
  if (s.ttsProvider !== "system" && s.ttsProvider !== "local") out.push("audio overview voices");
  return out;
}
