import { describe, expect, it } from "vitest";
import { buildFetchItems, encodeFetchMessage, parseFetchMessage, stripFetchMarker, urlKey } from "./fetchList";

const hits = [
  { title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" },
  { title: "The Illustrated Transformer", url: "https://jalammar.github.io/illustrated-transformer/" },
  { title: "Transformer video", url: "https://www.youtube.com/watch?v=abc" },
];

describe("urlKey", () => {
  it("ignores www, trailing slashes, tracking params and hashes", () => {
    expect(urlKey("https://www.Example.com/a/?utm_source=x#top")).toBe(urlKey("http://example.com/a"));
    expect(urlKey("https://example.com/a?id=2")).not.toBe(urlKey("https://example.com/a?id=3"));
  });
});

describe("buildFetchItems", () => {
  it("keeps only links the search returned, with the model's notes", () => {
    const picked = [
      { title: "The paper", url: "https://arxiv.org/abs/1706.03762/", kind: "paper", why: "The original." },
      { title: "Made up", url: "https://invented.example/page", kind: "article", why: "?" },
    ];
    const items = buildFetchItems(picked, hits);
    expect(items[0]).toEqual({ title: "The paper", url: hits[0].url, kind: "paper", why: "The original." });
    expect(items.some((i) => i.url.includes("invented"))).toBe(false);
    // short pick topped up from the search results, no repeats
    expect(items.map((i) => i.url)).toEqual(hits.map((h) => h.url));
    expect(items[2].kind).toBe("video");
  });

  it("falls back to the search results when the model's reply isn't usable", () => {
    expect(buildFetchItems(null, hits)).toHaveLength(3);
  });

  it("trusts the model's links when the provider reported none", () => {
    const items = buildFetchItems([{ title: "X", url: "https://x.example", kind: "docs", why: "" }], []);
    expect(items).toHaveLength(1);
  });
});

describe("fetch messages", () => {
  it("round-trips, and the model sees only the markdown list", () => {
    const list = { query: "a <!-- tricky --> query", items: buildFetchItems(null, hits) };
    const msg = encodeFetchMessage(list);
    expect(parseFetchMessage(msg)).toEqual(list);
    const plain = stripFetchMarker(msg);
    expect(plain).not.toContain("brewlm-fetch");
    expect(plain).toContain("1. [Attention Is All You Need](https://arxiv.org/abs/1706.03762)");
  });

  it("leaves other messages alone", () => {
    expect(parseFetchMessage("Hello")).toBeNull();
    expect(stripFetchMarker("Hello")).toBe("Hello");
  });
});
