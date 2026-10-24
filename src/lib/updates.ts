/**
 * Lightweight update check against GitHub Releases (no auto-install — that
 * would need tauri-plugin-updater plus signed releases). Fails soft: any
 * network/parse problem yields null and the app simply skips the banner.
 */
import { platform } from "../platform";

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  isNewer: boolean;
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
    return {
      current,
      latest,
      url: json.html_url ?? `https://github.com/${REPO}/releases`,
      isNewer: semverGt(latest, current),
    };
  } catch {
    return null;
  }
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
