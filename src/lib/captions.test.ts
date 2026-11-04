import { beforeEach, describe, expect, it, vi } from "vitest";

const pages = new Map<string, string>();
const fetched: string[] = [];
vi.mock("./webFetch", () => ({
  fetchWebPage: vi.fn(async (url: string) => {
    fetched.push(url);
    const body = pages.get(url);
    return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
  }),
}));
const ytResult = vi.fn<(url: string) => Promise<{ title: string; text: string }>>();
vi.mock("./youtube", async (orig) => ({ ...(await orig<typeof import("./youtube")>()), fetchYouTubeTranscript: (u: string) => ytResult(u) }));

import {
  embeddedVimeoRefs,
  jsonLdTranscripts,
  pageCaptionTracks,
  pageVideoTranscripts,
  parseCaptionFile,
  vimeoRef,
} from "./captions";

beforeEach(() => {
  pages.clear();
  fetched.length = 0;
  ytResult.mockReset();
});

describe("parseCaptionFile", () => {
  it("reads WebVTT with multi-line cues, voice tags and styling", () => {
    const vtt = `WEBVTT

NOTE a comment

00:00:02.090 --> 00:00:05.170
GILBERT STRANG: This
is heat equation video.

1:02:03.500 --> 1:02:05.000 align:start
<v Prof. Moler>So <c.yellow>this</c> works.</v>`;
    expect(parseCaptionFile(vtt)).toEqual([
      { at: 2.09, text: "GILBERT STRANG: This is heat equation video." },
      { at: 3723.5, text: "Prof. Moler: So this works." },
    ]);
  });

  it("reads SRT", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:01:00,250 --> 00:01:02,000\r\nworld\r\n";
    expect(parseCaptionFile(srt)).toEqual([
      { at: 1, text: "Hello" },
      { at: 60.25, text: "world" },
    ]);
  });

  it("reads TTML", () => {
    const ttml = `<tt><body><div><p begin="00:00:01.000" end="00:00:02.000">Hi<br/>there</p><p begin="12.5s">later</p></div></body></tt>`;
    expect(parseCaptionFile(ttml)).toEqual([
      { at: 1, text: "Hi there" },
      { at: 12.5, text: "later" },
    ]);
  });

  it("drops the rolling repeats of auto-generated captions", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
we start with

00:00:03.000 --> 00:00:05.000
we start with
the heat equation`;
    expect(parseCaptionFile(vtt).map((c) => c.text)).toEqual(["we start with", "the heat equation"]);
  });
});

describe("vimeoRef", () => {
  it("reads links and embeds, with unlisted hashes", () => {
    expect(vimeoRef("https://vimeo.com/76979871")).toEqual({ id: "76979871", hash: undefined });
    expect(vimeoRef("https://vimeo.com/76979871/abc123def0")).toEqual({ id: "76979871", hash: "abc123def0" });
    expect(vimeoRef("https://player.vimeo.com/video/76979871?h=abc123&badge=0")).toEqual({ id: "76979871", hash: "abc123" });
    expect(vimeoRef("https://vimeo.com/channels/staffpicks/76979871")).toEqual({ id: "76979871", hash: undefined });
  });

  it("ignores non-video Vimeo pages", () => {
    expect(vimeoRef("https://vimeo.com/features")).toBeNull();
    expect(vimeoRef("https://vimeo.com/user12345678")).toBeNull();
  });

  it("finds embedded players", () => {
    const html = `<iframe src="https://player.vimeo.com/video/111111111?h=deadbeef&amp;title=0"></iframe><iframe src="https://player.vimeo.com/video/111111111"></iframe>`;
    expect(embeddedVimeoRefs(html)).toEqual([{ id: "111111111", hash: "deadbeef" }]);
  });
});

// Trimmed from an MIT OpenCourseWare video page: a video.js player whose
// source is a YouTube embed, with the lecture's own caption file.
const OCW = `<html><body>
<h1>Heat Equation</h1>
<video id="vjs" class="video-js" data-setup='{"techOrder": ["youtube"], "sources": [{"type": "video/youtube", "src": "https://www.youtube.com/embed/i8rnEl8O-r0"}]}'>
  <track kind="captions" src="/courses/res-18-009/190d35dac2e25bbfb7ce52ff7a3f09c9_i8rnEl8O-r0.vtt" srclang="en" label="English" default>
</video>
<iframe src="https://www.youtube.com/embed/i8rnEl8O-r0"></iframe>
</body></html>`;
const OCW_URL = "https://ocw.mit.edu/courses/res-18-009/resources/heat-equation/";
const OCW_VTT = "https://ocw.mit.edu/courses/res-18-009/190d35dac2e25bbfb7ce52ff7a3f09c9_i8rnEl8O-r0.vtt";

describe("pageCaptionTracks", () => {
  it("finds OCW's caption track and resolves it against the page", () => {
    const [t, ...rest] = pageCaptionTracks(OCW, OCW_URL);
    expect(rest).toEqual([]);
    expect(t.src).toBe(OCW_VTT);
    expect(t.lang).toBe("en");
    expect(t.context).toContain("i8rnEl8O-r0");
  });

  it("picks English captions per player and skips chapters", () => {
    const html = `<video><track kind="chapters" src="c.vtt"><track src="de.vtt" srclang="de"><track kind="captions" src="en.vtt" srclang="en"></video>
      <video><track src="fr.vtt" srclang="fr"></video>`;
    expect(pageCaptionTracks(html, "https://x.org/a/").map((t) => t.src)).toEqual(["https://x.org/a/en.vtt", "https://x.org/a/fr.vtt"]);
  });
});

describe("jsonLdTranscripts", () => {
  it("reads a VideoObject transcript", () => {
    const t = "word ".repeat(60).trim();
    expect(jsonLdTranscripts(`{"@type":"VideoObject","transcript":${JSON.stringify(t)}}`)).toEqual([t]);
  });
});

describe("pageVideoTranscripts", () => {
  const ytWithTranscript = { title: "Heat Equation (YouTube)", text: "YouTube video: Heat Equation\n\nTranscript (English):\n\n[0:02] from YouTube" };
  const ytNoTranscript = {
    title: "Heat Equation (YouTube)",
    text: "YouTube video: Heat Equation\n\n[No transcript is available for this video — captions are disabled or couldn't be loaded. Only the title and description above are known; the spoken content is NOT available, so don't guess at it.]",
  };

  it("uses YouTube's transcript and doesn't fetch the page's duplicate caption file", async () => {
    ytResult.mockResolvedValue(ytWithTranscript);
    const out = await pageVideoTranscripts(OCW, OCW_URL);
    expect(out).toContain("[0:02] from YouTube");
    expect(fetched).not.toContain(OCW_VTT);
    expect(out.match(/\[Video on this page\]/g)).toHaveLength(1);
  });

  it("falls back to the page's caption file when YouTube's captions fail, keeping the video details", async () => {
    ytResult.mockResolvedValue(ytNoTranscript);
    pages.set(OCW_VTT, "WEBVTT\n\n00:00:02.090 --> 00:00:05.170\nGILBERT STRANG: This\nis heat equation video.\n");
    const out = await pageVideoTranscripts(OCW, OCW_URL);
    expect(out).toContain("YouTube video: Heat Equation");
    expect(out).toContain("Transcript (captions from this page):\n\n[0:02] GILBERT STRANG: This is heat equation video.");
    expect(out).not.toContain("No transcript is available");
  });

  it("reads a plain HTML5 video's captions", async () => {
    pages.set("https://talks.example/caps/en.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nWelcome.\n");
    const out = await pageVideoTranscripts(`<video src="t.mp4"><track src="caps/en.vtt" srclang="en" label="English"></video>`, "https://talks.example/t");
    expect(out).toContain("Video on this page — captions (English):\n\n[0:00] Welcome.");
  });

  it("returns nothing for a page without videos, without fetching", async () => {
    expect(await pageVideoTranscripts("<p>Just an article</p>", "https://x.org/")).toBe("");
    expect(fetched).toEqual([]);
  });
});
