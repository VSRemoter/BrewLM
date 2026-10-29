import { describe, expect, it, vi } from "vitest";

// mentions.ts pulls in db.ts and interactive.ts, which need the app's platform.
vi.mock("./db", () => ({ sourceText: (s: { content: string }) => s.content }));
vi.mock("./interactive", () => ({ parseInteractive: () => null }));

import { linkKey, resolveMentions, type MentionItem } from "./mentions";

const link = (id: string, url: string): MentionItem => ({ id, title: `Page ${id}`, group: "source", type: "link", text: "body", url });

describe("linkKey", () => {
  it("ignores scheme, www, trailing slash and share-tracking parameters", () => {
    expect(linkKey("https://x.com/hqmank/status/2113443767009304792?s=20")).toBe(linkKey("http://twitter.com/hqmank/status/2113443767009304792/"));
    expect(linkKey("https://www.example.com/a?utm_source=x")).toBe("example.com/a");
  });
  it("keeps parameters that pick the page", () => {
    expect(linkKey("https://www.youtube.com/watch?v=abc&t=30")).toBe("youtube.com/watch?v=abc");
    expect(linkKey("https://youtube.com/watch?v=abc")).not.toBe(linkKey("https://youtube.com/watch?v=xyz"));
  });
});

describe("resolveMentions", () => {
  it("treats a pasted link source address as a mention", () => {
    const items = [link("a", "https://x.com/hqmank/status/2113443767009304792"), link("b", "https://example.com/other")];
    const got = resolveMentions("Here it is https://x.com/hqmank/status/2113443767009304792?s=46 — what does it say?", items);
    expect(got.map((m) => m.id)).toEqual(["a"]);
  });
  it("finds nothing for unrelated addresses", () => {
    expect(resolveMentions("see https://news.example.org/story", [link("a", "https://x.com/a/status/1")])).toEqual([]);
  });
});
