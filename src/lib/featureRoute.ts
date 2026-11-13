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
export const LOCAL_CAPABLE: Record<MediaFeature, boolean> = { vision: true, transcribe: true };

type RouteSettings = Pick<
  Settings,
  "provider" | "visionRunsOn" | "transcribeRunsOn" | "localBaseUrl" | "localVisionModel" | "localSttBaseUrl"
>;

export function runsOn(s: RouteSettings, f: MediaFeature): RunsOn {
  return (f === "vision" ? s.visionRunsOn : s.transcribeRunsOn) ?? "auto";
}

/** True when the job must stay on this computer: set to Local, or Automatic with a local chat model. */
export function staysLocal(s: RouteSettings, f: MediaFeature): boolean {
  const r = runsOn(s, f);
  return r === "local" || (r === "auto" && s.provider === "local");
}

/**
 * True when this computer is set up to do the job: images need the chat
 * server and a vision model on it; transcription needs its own server (the
 * model is optional: servers fall back to their default).
 */
export function localReady(s: RouteSettings, f: MediaFeature): boolean {
  if (!LOCAL_CAPABLE[f]) return false;
  if (f === "vision") return !!s.localBaseUrl.trim() && !!s.localVisionModel.trim();
  return !!s.localSttBaseUrl.trim();
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

/* --------------------------------- /image --------------------------------- */

export type ImageRoute = { via: "brewlm" | "openrouter" | "local" } | { error: string };

/**
 * Where /image draws. Automatic: BrewLM AI's model on BrewLM AI, this
 * computer with a local chat model (never a saved cloud key, as above), and
 * OpenRouter otherwise.
 */
export function imageRoute(
  s: Pick<Settings, "provider" | "imageRunsOn" | "localImageBaseUrl" | "openrouterKey">
): ImageRoute {
  const r = s.imageRunsOn ?? "auto";
  if (r === "local" || (r === "auto" && s.provider === "local"))
    return s.localImageBaseUrl.trim()
      ? { via: "local" }
      : {
          error:
            "Pictures are set to run on this computer, but no image server is set up. Add one under **Settings → Local Models → Pictures**, or choose OpenRouter for pictures there.",
        };
  if (r === "auto" && s.provider === "brewlm") return { via: "brewlm" };
  return s.openrouterKey
    ? { via: "openrouter" }
    : {
        error:
          "Pictures use OpenRouter's image models. Add an OpenRouter API key in **Settings → AI Model** (select OpenRouter to enter it — you can switch your chat provider back afterwards), or draw on this computer under **Settings → Local Models → Pictures**.",
      };
}
