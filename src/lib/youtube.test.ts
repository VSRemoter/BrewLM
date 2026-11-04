import { describe, expect, it, vi } from "vitest";

vi.mock("./webFetch", () => ({ fetchWebPage: vi.fn() }));
import { embeddedYouTubeIds, youTubeId } from "./youtube";

describe("youTubeId", () => {
  it("reads watch links with a timestamp", () => {
    expect(youTubeId("https://www.youtube.com/watch?v=ToIXSwZ1pJU&t=149s")).toBe("ToIXSwZ1pJU");
  });
});

describe("embeddedYouTubeIds", () => {
  it("finds a JSON-LD embed URL (3Blue1Brown lesson pages)", () => {
    const html = `<script type="application/ld+json">{"@type":"VideoObject","thumbnailUrl":"https://img.youtube.com/vi/ToIXSwZ1pJU/maxresdefault.jpg","embedUrl":"https://www.youtube.com/embed/ToIXSwZ1pJU"}</script>`;
    expect(embeddedYouTubeIds(html)).toEqual(["ToIXSwZ1pJU"]);
  });

  it("finds iframes, lite-youtube and og:video, in page order without duplicates", () => {
    const html = `
      <meta property="og:video:url" content="https://www.youtube.com/embed/aaaaaaaaaaa">
      <iframe src="https://www.youtube-nocookie.com/embed/bbbbbbbbbbb?rel=0"></iframe>
      <lite-youtube videoid="ccccccccccc"></lite-youtube>
      <iframe src="https://www.youtube.com/embed/bbbbbbbbbbb"></iframe>`;
    expect(embeddedYouTubeIds(html)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("finds JSON-escaped embed URLs", () => {
    expect(embeddedYouTubeIds(`"embedUrl":"https:\\/\\/www.youtube.com\\/embed\\/ToIXSwZ1pJU"`)).toEqual(["ToIXSwZ1pJU"]);
  });

  it("ignores plain links and thumbnails of other videos", () => {
    const html = `<a href="https://www.youtube.com/watch?v=ly4S0oi3Yz8">next</a><img src="https://img.youtube.com/vi/r6sGWTCMz2k/maxresdefault.jpg">`;
    expect(embeddedYouTubeIds(html)).toEqual([]);
  });

  it("caps how many it returns", () => {
    const html = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]
      .map((id) => `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`)
      .join("");
    expect(embeddedYouTubeIds(html)).toHaveLength(3);
  });
});
