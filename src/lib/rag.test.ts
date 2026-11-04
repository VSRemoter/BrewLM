import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "./types";

/** Every condense call the model got, with the signal it was sent. */
const calls: AbortSignal[] = [];
/** Resolves every model call still waiting. */
let release: () => void = () => {};

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./db", () => ({
  chunksForSource: async () => [],
  getSetting: async () => null,
  setSetting: async () => {},
  sourceText: (s: Source) => s.content,
  uid: () => "id",
}));
vi.mock("./media", () => ({ ensureMediaText: async () => {} }));
vi.mock("./settings", () => ({ activeKey: () => "key", loadSettings: async () => ({}) }));
vi.mock("./local", () => ({
  contextBudget: () => ({ condenseGroup: 20_000, sources: 28_000 }),
  loadLocalServer: async () => null,
  localHeaders: () => ({}),
}));
vi.mock("./usage", () => ({
  addUsage: () => {},
  newUsageAccumulator: () => ({}),
  recordAccumulated: async () => {},
}));
vi.mock("./llm", () => ({
  complete: (opts: { signal?: AbortSignal }) => {
    const signal = opts.signal!;
    calls.push(signal);
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      const prev = release;
      release = () => {
        prev();
        resolve("notes");
      };
    });
  },
}));

const { condenseNotebook } = await import("./rag");

let n = 0;
/** Three 20k-char sources: over the condense target, so the model is called. */
const notebook = (): Source[] => {
  n++;
  return [1, 2, 3].map((i) => ({
    id: `s${n}-${i}`,
    notebook_id: `nb${n}`,
    type: "text",
    title: `Source ${i}`,
    content: "x".repeat(20_000),
    mime: null,
    text: "",
    pinned: 0,
    created_at: 0,
  })) as Source[];
};
const settings = { provider: "openrouter", model: "m" } as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("condenseNotebook cancel", () => {
  beforeEach(() => {
    calls.length = 0;
    release = () => {};
  });

  it("stops the model calls when its only caller cancels", async () => {
    const sources = notebook();
    const ctrl = new AbortController();
    const run = condenseNotebook(sources[0].notebook_id, sources, settings, undefined, ctrl.signal);
    await tick();
    expect(calls.length).toBeGreaterThan(0);
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.every((s) => s.aborted)).toBe(true);
  });

  it("keeps going for a second job when the first one cancels", async () => {
    const sources = notebook();
    const a = new AbortController();
    const b = new AbortController();
    const first = condenseNotebook(sources[0].notebook_id, sources, settings, undefined, a.signal);
    const second = condenseNotebook(sources[0].notebook_id, sources, settings, undefined, b.signal);
    await tick();
    a.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.some((s) => s.aborted)).toBe(false);
    release();
    await expect(second).resolves.toContain("notes");
  });

  it("starts a fresh pass after every caller cancelled", async () => {
    const sources = notebook();
    const a = new AbortController();
    const first = condenseNotebook(sources[0].notebook_id, sources, settings, undefined, a.signal);
    await tick();
    a.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const again = condenseNotebook(sources[0].notebook_id, sources, settings);
    await tick();
    release();
    await expect(again).resolves.toContain("notes");
  });
});
