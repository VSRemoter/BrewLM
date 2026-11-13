import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  status: 200,
  body: {} as unknown,
  down: false,
  requests: [] as { url: string; init?: RequestInit }[],
}));

vi.mock("../platform", () => ({
  platform: {
    fetch: async (url: string, init?: RequestInit) => {
      net.requests.push({ url, init });
      if (net.down) throw new TypeError("connection refused");
      return new Response(typeof net.body === "string" ? net.body : JSON.stringify(net.body), { status: net.status });
    },
  },
}));

import { cleanResults, configuredService, normalizeSearxngUrl, searchWithService, serviceSetupProblem } from "./webSearch";
import type { Settings } from "./types";

const s = (over: Partial<Settings>) =>
  ({ searchService: "auto", searxngUrl: "", braveKey: "", tavilyKey: "", ...over }) as Settings;

beforeEach(() => {
  net.status = 200;
  net.body = {};
  net.down = false;
  net.requests = [];
});

describe("setup", () => {
  it("knows when the chosen service is ready", () => {
    expect(configuredService(s({}))).toBeNull();
    expect(configuredService(s({ searchService: "searxng" }))).toBeNull();
    expect(configuredService(s({ searchService: "searxng", searxngUrl: "localhost:8888" }))).toBe("searxng");
    expect(configuredService(s({ searchService: "brave", tavilyKey: "x" }))).toBeNull();
    expect(serviceSetupProblem(s({ searchService: "tavily" }))).toMatch(/Tavily .* no API key/);
    expect(serviceSetupProblem(s({ searchService: "searxng" }))).toMatch(/no address/);
    expect(serviceSetupProblem(s({}))).toBeNull();
  });

  it("tidies a SearXNG address", () => {
    expect(normalizeSearxngUrl(" localhost:8888/ ")).toBe("http://localhost:8888");
    expect(normalizeSearxngUrl("https://search.example.org/search")).toBe("https://search.example.org");
  });

  it("keeps web links once, strips markup, and caps the count", () => {
    expect(
      cleanResults(
        [
          { title: "<b>A</b>", url: "https://a.org", snippet: "one  <em>two</em>" },
          { title: "dup", url: "https://a.org" },
          { title: "bad", url: "javascript:alert(1)" },
          { title: "", url: "https://b.org" },
          { title: "C", url: "https://c.org" },
        ],
        2
      )
    ).toEqual([
      { title: "A", url: "https://a.org", snippet: "one two" },
      { title: "https://b.org", url: "https://b.org", snippet: "" },
    ]);
  });
});

describe("searchWithService", () => {
  it("SearXNG: JSON search at the address", async () => {
    net.body = { results: [{ title: "Kokoro", url: "https://k.org", content: "TTS" }] };
    const r = await searchWithService("kokoro tts", s({ searchService: "searxng", searxngUrl: "localhost:8888" }));
    expect(r).toEqual([{ title: "Kokoro", url: "https://k.org", snippet: "TTS" }]);
    expect(net.requests[0].url).toBe("http://localhost:8888/search?q=kokoro%20tts&format=json&safesearch=1");
  });

  it("SearXNG: explains JSON output being off", async () => {
    net.status = 403;
    await expect(searchWithService("x", s({ searchService: "searxng", searxngUrl: "http://h" }))).rejects.toThrow(/settings\.yml/);
    net.status = 200;
    net.body = "<html>";
    await expect(searchWithService("x", s({ searchService: "searxng", searxngUrl: "http://h" }))).rejects.toThrow(/didn't answer with JSON/);
    net.down = true;
    await expect(searchWithService("x", s({ searchService: "searxng", searxngUrl: "http://h" }))).rejects.toThrow(/Is it running/);
  });

  it("Brave: key in its header", async () => {
    net.body = { web: { results: [{ title: "T", url: "https://t.org", description: "d" }] } };
    const r = await searchWithService("q", s({ searchService: "brave", braveKey: " BSAkey " }), { count: 5 });
    expect(r).toEqual([{ title: "T", url: "https://t.org", snippet: "d" }]);
    expect(net.requests[0].url).toBe("https://api.search.brave.com/res/v1/web/search?q=q&count=5");
    expect((net.requests[0].init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("BSAkey");
  });

  it("Tavily: POST with a bearer key", async () => {
    net.body = { results: [{ title: "T", url: "https://t.org", content: "c" }] };
    await searchWithService("q", s({ searchService: "tavily", tavilyKey: "tvly-1" }));
    expect(net.requests[0].init?.method).toBe("POST");
    expect((net.requests[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tvly-1");
    expect(JSON.parse(String(net.requests[0].init?.body))).toMatchObject({ query: "q", max_results: 8 });
  });

  it("names a rejected key and a rate limit", async () => {
    net.status = 401;
    await expect(searchWithService("q", s({ searchService: "brave", braveKey: "k" }))).rejects.toThrow(/Brave Search rejected the API key/);
    net.status = 429;
    await expect(searchWithService("q", s({ searchService: "tavily", tavilyKey: "k" }))).rejects.toThrow(/rate limit/);
  });

  it("refuses to run when the service isn't set up", async () => {
    await expect(searchWithService("q", s({ searchService: "brave" }))).rejects.toThrow(/no API key/);
    expect(net.requests).toEqual([]);
  });
});
