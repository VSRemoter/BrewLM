import { describe, expect, it, vi } from "vitest";
import type { Source } from "../lib/types";

vi.mock("../platform", () => ({ platform: { fetch: vi.fn(), openDb: vi.fn() } }));

import { buildSystemParts, buildSystemPrompt } from "./ChatPanel";
import { wholeNotebookFits } from "../lib/rag";
import type { RetrievedChunk } from "../lib/rag";

const src = (id: string, title: string, content: string, created_at: number): Source =>
  ({ id, notebook_id: "nb", type: "text", title, content, mime: null, created_at }) as unknown as Source;

const a = src("a", "Alpha", "alpha text", 1);
const b = src("b", "Beta", "beta text", 2);
const mentionB = { id: "b", title: "Beta", group: "source", type: "text", text: "beta text" } as never;

describe("system prompt for caching", () => {
  it("whole notebook: every source, oldest first, whatever order the UI passes", () => {
    const one = buildSystemParts([b, a], [], undefined, { whole: true });
    const two = buildSystemParts([a, b], [], undefined, { whole: true });
    expect(one.stable).toBe(two.stable);
    expect(one.stable.indexOf("### Alpha")).toBeLessThan(one.stable.indexOf("### Beta"));
    expect(one.volatile).toBe("");
  });

  it("whole notebook: an @-mention doesn't change the cached part or repeat the text", () => {
    const plain = buildSystemParts([a, b], [], undefined, { whole: true });
    const mentioned = buildSystemParts([a, b], [mentionB], undefined, { whole: true });
    expect(mentioned.stable).toBe(plain.stable);
    expect(mentioned.volatile).toContain("@Beta");
    expect(mentioned.volatile).toContain("full text is in the Sources section above");
    expect(mentioned.volatile).not.toContain("beta text");
  });

  it("retrieval: per-message excerpts go after the cached part", () => {
    const chunk: RetrievedChunk = { id: "c", sourceId: "a", sourceTitle: "Alpha", sourceType: "text", page: null, text: "alpha text", score: 1 };
    const parts = buildSystemParts([a, b], [], [chunk]);
    expect(parts.stable).not.toContain("alpha text");
    expect(parts.volatile).toContain("# Source excerpts");
    expect(buildSystemPrompt([a, b], [], [chunk])).toBe(`${parts.stable}\n\n${parts.volatile}`);
  });

  it("whole notebook only when it fits the budget", () => {
    expect(wholeNotebookFits([a, b], 1000)).toBe(true);
    expect(wholeNotebookFits([a, b], 50)).toBe(false);
    expect(wholeNotebookFits([], 1000)).toBe(false);
  });
});
