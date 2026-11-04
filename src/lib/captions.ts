/**
 * Videos on web pages → their transcripts. A lesson or lecture page (MIT
 * OpenCourseWare, 3Blue1Brown, a conference talk…) is mostly a video player;
 * its own text says little. So when a page is added as a source, each video
 * it plays is found and its captions are read too:
 *
 * - YouTube embeds → youtube.ts (Innertube captions, title, description)
 * - Vimeo embeds and links → the player config's caption tracks (WebVTT)
 * - HTML5 `<video>` / `<audio>` with a `<track kind="captions|subtitles">`
 *   → that caption file (WebVTT, SRT or TTML). OCW pages carry one per
 *   lecture, which also covers a YouTube video whose captions won't load.
 * - schema.org VideoObject `transcript` text in JSON-LD
 *
 * Every fetch is best-effort: a video whose captions can't be read is skipped
 * and the page is still saved.
 */

import { fetchWebPage } from "./webFetch";
import { clock, cuesToParagraphs, embeddedYouTubeIds, fetchYouTubeTranscript } from "./youtube";

export interface Cue {
  at: number;
  text: string;
}

/** At most this many videos are transcribed per page (a gallery page shouldn't pull dozens). */
const MAX_VIDEOS = 5;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* ---------- caption files ---------- */

/** `01:02:03.450`, `02:03,450`, `00:01.5` → seconds; null if it isn't a timestamp. */
function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(raw.trim());
  if (!m) return null;
  const [, h, min, s, frac] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
}

/** TTML/DFXP `begin` values: a clock time, or `12.5s` / `1250ms` / ticks. */
function parseTtmlTime(raw: string): number | null {
  const m = /^([\d.]+)(h|m|s|ms|t)$/.exec(raw.trim());
  if (m) {
    const n = Number(m[1]);
    return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, t: n / 10_000_000 }[m[2] as "h" | "m" | "s" | "ms" | "t"];
  }
  return parseTimestamp(raw);
}

/**
 * A caption file (WebVTT, SRT or TTML/DFXP) → cues. Styling tags are dropped,
 * a WebVTT voice tag becomes "Name: ", and the rolling repeats of
 * auto-generated captions (each cue re-showing the previous line) are removed.
 */
export function parseCaptionFile(text: string): Cue[] {
  const raw: Cue[] = [];
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (src.includes("-->")) {
    for (const block of src.split(/\n{2,}/)) {
      const lines = block.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const at = parseTimestamp(lines[i].split("-->")[0]);
      if (at === null) continue;
      const body = lines
        .slice(i + 1)
        .map((l) => l.replace(/<v(?:\.[\w.-]+)?\s+([^>]+)>/g, "$1: ").replace(/<[^>]*>/g, "").trim())
        .filter(Boolean);
      if (body.length) raw.push({ at, text: body.join("\n") });
    }
  } else {
    for (const m of src.matchAll(/<p\b[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi)) {
      const at = parseTtmlTime(m[1]);
      const body = m[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim();
      if (at !== null && body) raw.push({ at, text: body });
    }
  }
  // Drop lines that repeat the line just shown (rolling auto-captions).
  const cues: Cue[] = [];
  let last = "";
  for (const cue of raw) {
    const fresh = cue.text.split("\n").filter((l) => l !== last);
    if (cue.text) last = cue.text.split("\n").pop() ?? last;
    if (fresh.length) cues.push({ at: cue.at, text: fresh.join(" ") });
  }
  return cues;
}

/** Download a caption file and turn it into timestamped paragraphs ("" if it can't be read). */
export async function fetchCaptionText(url: string, referer?: string): Promise<string> {
  try {
    const res = await fetchWebPage(url, {
      method: "GET",
      headers: { "User-Agent": BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
    });
    if (!res.ok) return "";
    return cuesToParagraphs(parseCaptionFile(await res.text()));
  } catch {
    return "";
  }
}

/* ---------- Vimeo ---------- */

export interface VimeoRef {
  id: string;
  /** The privacy hash of an unlisted video (`?h=` on embeds, the path segment after the id on links). */
  hash?: string;
}

/** The Vimeo video a URL points at (vimeo.com/123, vimeo.com/123/abcdef, player.vimeo.com/video/123?h=…), or null. */
export function vimeoRef(raw: string): VimeoRef | null {
  let u: URL;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let hash = u.searchParams.get("h") ?? undefined;
  if (host === "player.vimeo.com" && parts[0] === "video") id = parts[1];
  else if (host === "vimeo.com") {
    // vimeo.com/123, vimeo.com/123/abcdef, vimeo.com/channels/x/123, vimeo.com/showcase/1/video/123
    const at = parts.findIndex((p) => /^\d{5,}$/.test(p));
    if (at >= 0 && (at === 0 || ["channels", "groups", "video", "videos"].includes(parts[at - 1]) || parts[0] === "channels")) {
      id = parts[at];
      if (!hash && parts[at + 1] && /^[0-9a-f]{6,}$/i.test(parts[at + 1])) hash = parts[at + 1];
    }
  }
  return id && /^\d{5,}$/.test(id) ? { id, hash } : null;
}

export const isVimeoUrl = (url: string) => vimeoRef(url) !== null;

/** Vimeo players a page embeds (iframes, og:video), in page order, without duplicates. */
export function embeddedVimeoRefs(html: string, max = MAX_VIDEOS): VimeoRef[] {
  const out: VimeoRef[] = [];
  for (const m of html.matchAll(/player\.vimeo\.com\\?\/video\\?\/(\d{5,})([^"'\s<>]*)/gi)) {
    if (out.some((r) => r.id === m[1])) continue;
    const hash = /[?&](?:amp;)?h=([0-9a-f]+)/i.exec(m[2])?.[1];
    out.push({ id: m[1], hash });
  }
  return out.slice(0, max);
}

interface VimeoConfig {
  video?: { title?: string; duration?: number; owner?: { name?: string }; url?: string };
  request?: { text_tracks?: { url: string; lang?: string; label?: string; kind?: string; provenance?: string }[] };
}

/**
 * A Vimeo video's title and captions as source text. Throws only when the
 * video can't be read at all (private, removed, or locked to other sites).
 * `referer` is the page that embeds it — domain-locked players need it.
 */
export async function fetchVimeoTranscript(ref: VimeoRef, referer?: string): Promise<{ title: string; text: string }> {
  const url = `https://player.vimeo.com/video/${ref.id}/config${ref.hash ? `?h=${ref.hash}` : ""}`;
  const res = await fetchWebPage(url, {
    method: "GET",
    headers: { "User-Agent": BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
  });
  if (!res.ok) throw new Error(`Couldn't read that Vimeo video (HTTP ${res.status}) — it may be private or only playable on its own site.`);
  const cfg = (await res.json()) as VimeoConfig;
  const v = cfg.video ?? {};
  const tracks = cfg.request?.text_tracks ?? [];
  const en = (t: (typeof tracks)[number]) => (t.lang ?? "").toLowerCase().startsWith("en");
  const human = (t: (typeof tracks)[number]) => !/auto|ai|machine/i.test(t.provenance ?? "");
  const ordered = [tracks.find((t) => en(t) && human(t)), tracks.find(en), tracks.find(human), tracks[0]];

  let transcript = "";
  let label = "";
  for (const t of new Set(ordered)) {
    if (!t) continue;
    transcript = await fetchCaptionText(t.url, referer);
    if (transcript) {
      label = `${t.label ?? t.lang ?? "captions"}${human(t) ? "" : ", auto-generated"}`;
      break;
    }
  }
  const header = [
    `Vimeo video: ${v.title ?? ref.id}`,
    v.owner?.name ? `By: ${v.owner.name}` : "",
    `URL: ${v.url ?? `https://vimeo.com/${ref.id}`}`,
    v.duration ? `Length: ${clock(v.duration)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = transcript
    ? `\n\nTranscript (${label}):\n\n${transcript}`
    : "\n\n[No transcript is available for this video — it has no captions. Only the title above is known; the spoken content is NOT available, so don't guess at it.]";
  return { title: v.title ? `${v.title} (Vimeo)` : `Vimeo video ${ref.id}`, text: header + body };
}

/* ---------- HTML5 caption tracks ---------- */

export interface PageTrack {
  src: string;
  lang: string;
  label: string;
  /** The page's markup from the enclosing <video>/<audio> up to this track — to tell which player it belongs to. */
  context: string;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/**
 * The best caption track of each player on the page: `<track>` elements of
 * kind captions/subtitles (the default kind), English and captions first.
 * Relative `src`s are resolved against `baseUrl`.
 */
export function pageCaptionTracks(html: string, baseUrl: string, max = MAX_VIDEOS): PageTrack[] {
  const players = new Map<number, (PageTrack & { score: number })[]>();
  const lower = html.toLowerCase();
  for (const m of html.matchAll(/<track\b[^>]*>/gi)) {
    const tag = m[0];
    const kind = (attr(tag, "kind") ?? "subtitles").toLowerCase();
    if (kind !== "captions" && kind !== "subtitles") continue;
    const rawSrc = attr(tag, "src");
    if (!rawSrc) continue;
    let src: string;
    try {
      src = new URL(rawSrc.replace(/&amp;/g, "&"), baseUrl).toString();
    } catch {
      continue;
    }
    const at = m.index ?? 0;
    // Tracks are grouped by the nearest <video>/<audio> before them (-1: outside any player).
    const start = Math.max(lower.lastIndexOf("<video", at), lower.lastIndexOf("<audio", at));
    const lang = (attr(tag, "srclang") ?? "").toLowerCase();
    const label = attr(tag, "label") ?? lang ?? "";
    const score = (lang.startsWith("en") || /english/i.test(label) ? 2 : 0) + (kind === "captions" ? 1 : 0);
    const list = players.get(start) ?? [];
    list.push({ src, lang, label, context: start < 0 ? "" : html.slice(start, at), score });
    players.set(start, list);
  }
  return [...players.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, list]) => list.reduce((best, t) => (t.score > best.score ? t : best)))
    .map(({ score: _score, ...t }) => t)
    .slice(0, max);
}

/** schema.org VideoObject `transcript` strings in the page's JSON-LD. */
export function jsonLdTranscripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/"transcript"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      const t = (JSON.parse(m[1]) as string).trim();
      if (t.length >= 200 && !out.includes(t)) out.push(t);
    } catch {
      /* not a JSON string */
    }
  }
  return out;
}

/* ---------- a page's videos ---------- */

/**
 * Transcripts of every video a web page plays, as text to append to the
 * page's own ("" when it has none, or none could be read).
 */
export async function pageVideoTranscripts(html: string, pageUrl: string): Promise<string> {
  const youTube = embeddedYouTubeIds(html, MAX_VIDEOS);
  const vimeo = embeddedVimeoRefs(html, MAX_VIDEOS);
  const tracks = pageCaptionTracks(html, pageUrl, MAX_VIDEOS);
  if (!youTube.length && !vimeo.length && !tracks.length && !/"transcript"\s*:/.test(html)) return "";

  const [yt, vm] = await Promise.all([
    Promise.all(youTube.map((id) => fetchYouTubeTranscript(`https://www.youtube.com/watch?v=${id}`).catch(() => null))),
    Promise.all(vimeo.map((ref) => fetchVimeoTranscript(ref, pageUrl).catch(() => null))),
  ]);
  const hasTranscript = (r: { text: string } | null) => !!r && r.text.includes("\nTranscript (");
  const ids = [...youTube, ...vimeo.map((r) => r.id)];
  const results = [...yt, ...vm];
  const trackFor = (id: string) => tracks.find((t) => t.context.includes(id) || t.src.includes(id));
  // The page's own caption file stands in for a video whose captions didn't
  // come through; one for a video already transcribed isn't needed twice.
  const needed = tracks.filter((t) => {
    const i = ids.findIndex((id) => trackFor(id) === t);
    return i < 0 || !hasTranscript(results[i]);
  });
  const trackTexts = new Map(
    await Promise.all(needed.map(async (t) => [t, await fetchCaptionText(t.src, pageUrl)] as const)),
  );

  const parts: string[] = [];
  const used = new Set<PageTrack>();
  for (const [i, r] of results.entries()) {
    if (!r) continue;
    const track = hasTranscript(r) ? undefined : trackFor(ids[i]);
    const captions = track && trackTexts.get(track);
    if (track && captions) {
      used.add(track);
      parts.push(`${r.text.replace(/\n\n\[No transcript is available[^\]]*\]/, "")}\n\nTranscript (captions from this page):\n\n${captions}`);
    } else parts.push(r.text);
  }
  for (const t of needed) {
    const captions = trackTexts.get(t);
    if (captions && !used.has(t)) parts.push(`Video on this page — captions (${t.label || t.lang || "captions"}):\n\n${captions}`);
  }
  for (const t of jsonLdTranscripts(html)) parts.push(`Video transcript (from the page):\n\n${t}`);

  return parts
    .slice(0, MAX_VIDEOS)
    .map((p) => `\n\n---\n\n[Video on this page]\n\n${p}`)
    .join("");
}
