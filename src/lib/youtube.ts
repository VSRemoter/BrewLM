/**
 * YouTube links → the video's transcript. Fetching a watch page as HTML yields
 * only player boilerplate, so the generic link fetcher can't read videos.
 * Instead: ask YouTube's player API (Innertube, Android client — its caption
 * URLs work without a browser proof-of-origin token) for the caption tracks,
 * pick the best one (manual over auto-generated, English first), and turn the
 * timed text into timestamped paragraphs. Title, channel, and description come
 * along so the model knows what the video is even when captions are missing.
 */

import { platform } from "../platform";

/** Placeholder content for a YouTube link whose transcript hasn't been fetched yet (phone adds). */
export const YOUTUBE_PENDING =
  "[YouTube video — transcript pending. BrewLM on the desktop fetches it before the next answer.]";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" };
/** YouTube's public web Innertube key — used when the page doesn't expose one. */
const FALLBACK_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const MAX_CHARS = 200_000;
/** Start a new timestamped paragraph at least this often (seconds). */
const PARAGRAPH_SECONDS = 30;

/** The 11-character video id of a YouTube URL, or null if it isn't one. */
export function youTubeId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v");
    if (!id) {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export const isYouTubeUrl = (url: string) => youTubeId(url) !== null;

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
    lengthSeconds?: string;
  };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Caption text is often entity-encoded twice; textContent only undoes one level. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Pull a JSON object assigned in an inline script (`var x = {...};`). */
function extractJsonAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchWatchPage(id: string): Promise<{ apiKey: string; player: PlayerResponse | null }> {
  try {
    const res = await platform.fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      method: "GET",
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
      connectTimeout: 20000,
    });
    if (!res.ok) return { apiKey: FALLBACK_INNERTUBE_KEY, player: null };
    const html = await res.text();
    const apiKey = /"INNERTUBE_API_KEY":\s*"([\w-]+)"/.exec(html)?.[1] ?? FALLBACK_INNERTUBE_KEY;
    const player = extractJsonAfter(html, "ytInitialPlayerResponse") as PlayerResponse | null;
    return { apiKey, player };
  } catch {
    return { apiKey: FALLBACK_INNERTUBE_KEY, player: null };
  }
}

async function fetchPlayer(id: string, apiKey: string): Promise<PlayerResponse | null> {
  try {
    const res = await platform.fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 14) gzip`,
      },
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId: id }),
      connectTimeout: 20000,
    });
    return res.ok ? ((await res.json()) as PlayerResponse) : null;
  } catch {
    return null;
  }
}

/** Manual English > auto English > any manual > anything. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const en = (t: CaptionTrack) => t.languageCode.toLowerCase().startsWith("en");
  const manual = (t: CaptionTrack) => t.kind !== "asr";
  return (
    tracks.find((t) => en(t) && manual(t)) ??
    tracks.find(en) ??
    tracks.find(manual) ??
    tracks[0] ??
    null
  );
}

/** Timed-text XML (format 1 `<text start>` or srv3 `<p t>`) → timestamped paragraphs. */
async function fetchTrackText(track: CaptionTrack): Promise<string> {
  const url = new URL(track.baseUrl);
  url.searchParams.delete("fmt");
  const res = await platform.fetch(url.toString(), {
    method: "GET",
    headers: { "User-Agent": BROWSER_UA },
    connectTimeout: 20000,
  });
  if (!res.ok) return "";
  const xml = await res.text();
  if (!xml.trim()) return "";
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  const cues: { at: number; text: string }[] = [];
  for (const el of Array.from(doc.getElementsByTagName("text"))) {
    cues.push({ at: Number(el.getAttribute("start") ?? 0), text: el.textContent ?? "" });
  }
  if (cues.length === 0) {
    for (const el of Array.from(doc.getElementsByTagName("p"))) {
      cues.push({ at: Number(el.getAttribute("t") ?? 0) / 1000, text: el.textContent ?? "" });
    }
  }

  const paras: string[] = [];
  let cur = "";
  let curStart = 0;
  for (const cue of cues) {
    const line = decodeEntities(cue.text).replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (!cur) {
      cur = line;
      curStart = cue.at;
    } else if (cue.at - curStart >= PARAGRAPH_SECONDS && /[.!?]["')\]]?$/.test(cur)) {
      paras.push(`[${clock(curStart)}] ${cur}`);
      cur = line;
      curStart = cue.at;
    } else if (cue.at - curStart >= PARAGRAPH_SECONDS * 2) {
      // Auto captions have no punctuation — break on time alone.
      paras.push(`[${clock(curStart)}] ${cur}`);
      cur = line;
      curStart = cue.at;
    } else {
      cur += ` ${line}`;
    }
  }
  if (cur) paras.push(`[${clock(curStart)}] ${cur}`);
  return paras.join("\n\n");
}

/**
 * Fetch a YouTube video's transcript and metadata as source text.
 * Throws a friendly error only when nothing at all can be learned about the
 * video; a video without captions still yields its title and description,
 * with an explicit note that the spoken content is unavailable.
 */
export async function fetchYouTubeTranscript(rawUrl: string): Promise<{ title: string; text: string }> {
  const id = youTubeId(rawUrl);
  if (!id) throw new Error("That doesn't look like a YouTube video link.");

  const page = await fetchWatchPage(id);
  const api = await fetchPlayer(id, page.apiKey);
  const details = api?.videoDetails ?? page.player?.videoDetails ?? {};
  const status = api?.playabilityStatus ?? page.player?.playabilityStatus;
  const tracks = [
    ...(api?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []),
    ...(page.player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []),
  ];

  let transcript = "";
  let trackLabel = "";
  // Android-client tracks first (they don't need a proof-of-origin token);
  // web-page tracks are a fallback in case YouTube changes the former.
  const tried = new Set<string>();
  for (const track of [pickTrack(tracks), ...tracks]) {
    if (!track || tried.has(track.baseUrl)) continue;
    tried.add(track.baseUrl);
    try {
      transcript = await fetchTrackText(track);
    } catch {
      transcript = "";
    }
    if (transcript) {
      const name = track.name?.simpleText ?? track.name?.runs?.map((r) => r.text).join("") ?? track.languageCode;
      trackLabel = `${name}${track.kind === "asr" ? ", auto-generated" : ""}`;
      break;
    }
    if (tried.size >= 3) break;
  }

  if (!details.title && !transcript) {
    const reason = status?.reason ? ` (${status.reason})` : "";
    throw new Error(`Couldn't read that YouTube video${reason} — it may be private, age-restricted, or removed.`);
  }

  const title = details.title ? `${details.title} (YouTube)` : `YouTube video ${id}`;
  const length = Number(details.lengthSeconds ?? 0);
  const header = [
    `YouTube video: ${details.title ?? id}`,
    details.author ? `Channel: ${details.author}` : "",
    `URL: https://www.youtube.com/watch?v=${id}`,
    length ? `Length: ${clock(length)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const description = details.shortDescription?.trim()
    ? `\n\nDescription:\n${details.shortDescription.trim()}`
    : "";
  const body = transcript
    ? `\n\nTranscript (${trackLabel}):\n\n${transcript}`
    : "\n\n[No transcript is available for this video — captions are disabled or couldn't be loaded. Only the title and description above are known; the spoken content is NOT available, so don't guess at it.]";

  const text = header + description + body;
  return {
    title,
    text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n\n[Truncated — transcript too long to store in full.]" : text,
  };
}
