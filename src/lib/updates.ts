/**
 * Update check against GitHub Releases, plus in-place install through
 * tauri-plugin-updater when the release carries signed updater artifacts
 * (latest.json). Releases without them fall back to a Download link. Fails
 * soft: any network/parse problem yields null and the app skips the banner.
 */
import type { Update } from "@tauri-apps/plugin-updater";
import { platform } from "../platform";

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  isNewer: boolean;
  /** Set when this release can be installed in place (see installUpdate). */
  update?: Update;
}

const REPO = "VSRemoter/BrewLM";

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const latest = String(json.tag_name ?? "").replace(/^v/, "");
    if (!latest) return null;
    const current = await platform.appVersion();
    const isNewer = semverGt(latest, current);
    return {
      current,
      latest,
      url: json.html_url ?? `https://github.com/${REPO}/releases`,
      isNewer,
      update: isNewer ? await findInstallable() : undefined,
    };
  } catch {
    return null;
  }
}

/** The signed update from the updater endpoint, if the latest release has one. */
async function findInstallable(): Promise<Update | undefined> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    return (await check()) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Download and install the update, then relaunch into it. `onProgress` gets
 * the downloaded fraction (null while the size is unknown). Only returns by
 * throwing: on success the app restarts.
 */
export async function installUpdate(
  update: Update,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  let total = 0;
  let done = 0;
  await update.download((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      done += e.data.chunkLength;
      onProgress(total ? Math.min(1, done / total) : null);
    }
  });
  // On Windows install() hands over to the installer and exits this process,
  // so stop sharing (the cloudflared sidecar) before it does.
  await invoke("stop_sharing");
  await update.install();
  await invoke("restart_app");
}

/** a > b for dotted numeric versions ("0.10.0" > "0.9.9"). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
