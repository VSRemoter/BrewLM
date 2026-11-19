import { beforeEach, describe, expect, it, vi } from "vitest";

/** Records every model call; answers by what the prompt asks for. */
const calls = vi.hoisted(() => ({ prompts: [] as { provider: string; model: string; text: string; system?: string }[] }));
const net = vi.hoisted(() => ({ requests: [] as string[] }));

vi.mock("./db", () => ({ getSetting: async () => "" }));
vi.mock("./usage", () => ({ recordUsage: async () => {} }));
vi.mock("./brewlmAi", () => ({}));
vi.mock("./routing", () => ({}));
vi.mock("./settings", () => ({
  activeKey: (s: { localBaseUrl: string }) => (s.localBaseUrl ? "local" : ""),
  noKeyMessage: () => "no key",
  researchModelFor: () => "llama3.1:8b",
}));
vi.mock("./source", () => ({
  fetchLinkContent: async (url: string) => ({ title: `Page ${url}`, text: `Long page about ${url}. `.repeat(400), finalUrl: url }),
}));
vi.mock("../platform", () => ({
  platform: {
    fetch: async (url: string) => {
      net.requests.push(url);
      return new Response(
        JSON.stringify({
          results: [
            { title: "One", url: "https://one.org", content: "first" },
            { title: "Two", url: "https://two.org", content: "second" },
          ],
        })
      );
    },
  },
}));
vi.mock("./llm", () => ({
  extractJson: (t: string) => t.slice(t.search(/[[{]/), Math.max(t.lastIndexOf("]"), t.lastIndexOf("}")) + 1),
  complete: async (o: { provider: string; model: string; messages: { role: string; content: string }[] }) => {
    const text = o.messages[o.messages.length - 1].content;
    const system = o.messages.find((m) => m.role === "system")?.content;
    calls.prompts.push({ provider: o.provider, model: o.model, text, system });
    if (text.startsWith("Turn this research request")) return '["local tts", "kokoro voices"]';
    if (text.includes("write notes on everything relevant")) return "- a note";
    if (text.includes("From the search results below, pick"))
      return '[{"title":"One","url":"https://one.org","kind":"docs","why":"w"},{"title":"Made up","url":"https://fake.org","kind":"docs","why":"w"}]';
    if (text.includes("Write a thorough, well-structured research report")) return "## Report\n\nText [1].\n\n## Sources\n1. [One](https://one.org)";
    return "Answer citing [1].";
  },
}));

import { deepResearch, fetchSources, searchUnavailable, webAnswer } from "./research";
import type { Settings } from "./types";

const settings = (over: Partial<Settings> = {}) =>
  ({
    provider: "local",
    localBaseUrl: "http://localhost:11434/v1",
    localContext: 8192,
    searchService: "searxng",
    searxngUrl: "http://localhost:8888",
    braveKey: "",
    tavilyKey: "",
    thinking: "auto",
    maxOutput: null,
    temperature: null,
    researchModels: {},
    ...over,
  }) as Settings;

beforeEach(() => {
  calls.prompts = [];
  net.requests = [];
});

describe("search with a local model", () => {
  it("explains what's missing instead of failing", () => {
    expect(searchUnavailable(settings({ searchService: "auto" }))).toMatch(/needs a search service/);
    expect(searchUnavailable(settings({ searxngUrl: "" }))).toMatch(/SearXNG .* no address/);
    expect(searchUnavailable(settings())).toBeNull();
    expect(searchUnavailable(settings({ provider: "openai", searchService: "auto" }))).toBeNull();
  });

  it("deep research: plans, searches SearXNG, takes notes to fit 8K, and writes on the local model", async () => {
    const phases: string[] = [];
    const out = await deepResearch({ settings: settings(), title: "Local TTS", description: "", onPhase: (p) => phases.push(p) });
    expect(out.markdown).toMatch(/## Report/);
    expect(out.pages.map((p) => p.url)).toEqual(["https://one.org/", "https://two.org/"]);
    expect(net.requests.filter((u) => u.startsWith("http://localhost:8888/search"))).toHaveLength(2);
    expect(calls.prompts.every((c) => c.provider === "local" && c.model === "llama3.1:8b")).toBe(true);
    expect(phases.some((p) => p.startsWith("Taking notes"))).toBe(true);
    // The report prompt carries the notes, not the 8,000-character pages.
    const report = calls.prompts.find((c) => c.text.includes("Write a thorough"))!;
    expect(report.text).toContain("- a note");
    expect(report.text.length).toBeLessThan(6000);
  });

  it("deep research on a cloud model doesn't take notes (pages fit)", async () => {
    const phases: string[] = [];
    await deepResearch({ settings: settings({ provider: "openai" }), title: "T", description: "", onPhase: (p) => phases.push(p) });
    expect(phases.some((p) => p.startsWith("Taking notes"))).toBe(false);
  });

  it("/search answers on the local model from the pages, numbered like the sources list", async () => {
    const out = await webAnswer({ query: "what is kokoro", settings: settings(), system: "persona" });
    expect(out.text).toBe("Answer citing [1].");
    expect(out.hits.map((h) => h.url)).toEqual(["https://one.org", "https://two.org"]);
    const call = calls.prompts[calls.prompts.length - 1];
    expect(call.system).toBe("persona");
    expect(call.text).toMatch(/### \[1\] One\nURL: https:\/\/one\.org/);
  });

  it("/fetch keeps only links the search really returned", async () => {
    const items = await fetchSources({ request: "learn local tts", settings: settings() });
    expect(items.map((i) => i.url)).toContain("https://one.org");
    expect(items.map((i) => i.url)).not.toContain("https://fake.org");
  });

  it("refuses with the setup message when no service is chosen", async () => {
    await expect(webAnswer({ query: "q", settings: settings({ searchService: "auto" }) })).rejects.toThrow(/needs a search service/);
    await expect(deepResearch({ settings: settings({ searchService: "auto" }), title: "T", description: "" })).rejects.toThrow(/needs a search service/);
    expect(net.requests).toEqual([]);
  });
});
