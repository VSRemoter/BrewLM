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

describe("@-mentions from other notebooks", () => {
  const away = {
    id: "p1",
    title: "Probability review",
    group: "output",
    type: "report",
    text: "Bayes: P(A|B) = P(B|A)P(A)/P(B)",
    notebookId: "stats",
    notebookTitle: "Stats 101",
    prepared: true,
  } as never;
  it("says which notebook it came from and how to cite it", () => {
    const { stable, volatile } = buildSystemParts([a], [away], undefined, { whole: true });
    expect(stable).not.toContain("Probability review");
    expect(volatile).toContain('### @Probability review (Output · report · from your notebook "Stats 101")');
    expect(volatile).toContain("P(A|B)");
    expect(volatile).toContain("name that notebook too");
  });
  it("a deleted pick tells the model not to guess", () => {
    const gone = { id: "x", title: "Old notes", group: "source", type: "pdf", text: null, missing: "was deleted" } as never;
    expect(buildSystemParts([a], [gone]).volatile).toContain("This source was deleted");
  });
  it("a whole notebook is labelled as one", () => {
    const nb = { id: "stats", title: "Stats 101", group: "notebook", type: "notebook", text: "Contents — 2 sources", notebookId: "stats", excerpt: true } as never;
    expect(buildSystemParts([a], [nb]).volatile).toContain('### @Stats 101 (Your notebook "Stats 101" · the parts most relevant to this message)');
  });
});
