import { describe, expect, it, vi } from "vitest";
import { buildFlashcardsPrompt, buildMindmapPrompt, buildQuizPrompt } from "./studio";
import {
  ANGLES,
  hasFocus,
  interactivePrior,
  priorOutputs,
  shuffleQuizOptions,
  varietyNote,
  withVariety,
} from "./studioVariety";
import type { Artifact } from "./types";

// interactive.ts streams through llm.ts, which needs the app's platform layer.
vi.mock("./llm", () => ({ streamChat: vi.fn() }));
const { buildStoryboardPrompt } = await import("./interactive");

let n = 0;
const art = (kind: Artifact["kind"], data: unknown, title: string = kind, created_at = ++n): Artifact => ({
  id: `a${n}`,
  notebook_id: "nb",
  kind,
  title,
  data: typeof data === "string" ? data : JSON.stringify(data),
  pinned: 0,
  created_at,
});

describe("priorOutputs", () => {
  it("lists earlier card fronts and quiz questions of the same kind only", () => {
    const arts = [
      art("flashcards", [{ front: "What is ATP?", back: "x" }, { front: "Define osmosis", back: "y" }]),
      art("quiz", [{ question: "Which organelle makes ATP?", options: ["a", "b"], answerIndex: 0 }]),
    ];
    expect(priorOutputs("flashcards", arts)).toBe("- What is ATP?\n- Define osmosis");
    expect(priorOutputs("quiz", arts)).toBe("- Which organelle makes ATP?");
    expect(priorOutputs("mindmap", arts)).toBe("");
  });

  it("summarizes mind maps, audio and interactive pages", () => {
    const arts = [
      art("mindmap", "- Cells: the unit of life\n  - Organelles: parts\n    - Mito: power\n  - Membranes: walls"),
      art("audio", { script: [{ speaker: "Alex", text: "Ever wondered why cells divide?" }] }, "Episode 1"),
      art("interactive", { html: "<html></html>", storyboard: "# **Cell Builder**\nFormat: game\nGoal: build a cell" }),
    ];
    expect(priorOutputs("mindmap", arts)).toBe("- Cells → Organelles, Membranes");
    expect(priorOutputs("audio", arts)).toContain("Ever wondered why cells divide?");
    expect(priorOutputs("interactive", arts)).toBe("- Cell Builder · Format: game · Goal: build a cell");
  });

  it("caps how much it quotes and survives malformed data", () => {
    const fronts = Array.from({ length: 200 }, (_, i) => ({ front: `Question number ${i} about something long enough` }));
    const out = priorOutputs("flashcards", [art("flashcards", fronts), art("flashcards", "not json")]);
    expect(out.length).toBeLessThanOrEqual(2400);
    expect(out.split("\n").length).toBeLessThanOrEqual(60);
  });
});

describe("varietyNote", () => {
  it("draws an angle only when there's no focus", () => {
    const blank = varietyNote("quiz", [], { focused: false, rand: () => 0 });
    expect(blank).toContain(ANGLES[0]);
    expect(varietyNote("quiz", [], { focused: true })).toBe("");
  });

  it("asks for different ground when outputs already exist", () => {
    const note = varietyNote("flashcards", [art("flashcards", [{ front: "What is ATP?" }])], { focused: true });
    expect(note).toMatch(/Don't repeat/);
    expect(note).toContain("- What is ATP?");
  });

  it("always asks audio for a fresh hook", () => {
    expect(varietyNote("audio", [], { focused: true })).toMatch(/fresh hook/);
  });
});

describe("withVariety", () => {
  it("keeps the output contract last", () => {
    const base = buildQuizPrompt({ amount: "default", difficulty: "medium", sourceIds: [], description: "" });
    const out = withVariety(base, "NOTE");
    expect(out.indexOf("NOTE")).toBeLessThan(out.indexOf("Return ONLY"));
    expect(out.trimEnd().endsWith('"explanation": "why the answer is correct"}]')).toBe(true);
    const map = withVariety(buildMindmapPrompt(""), "NOTE");
    expect(map.indexOf("NOTE")).toBeLessThan(map.indexOf("Format:"));
  });

  it("leaves the prompt alone for an empty note", () => {
    const base = buildFlashcardsPrompt({ amount: "default", difficulty: "easy", sourceIds: [], description: "" });
    expect(withVariety(base, "")).toBe(base);
  });
});

describe("hasFocus", () => {
  it("spots the focus line every builder writes", () => {
    const opts = { amount: "default" as const, difficulty: "easy" as const, sourceIds: [] };
    expect(hasFocus(buildFlashcardsPrompt({ ...opts, description: "enzymes" }))).toBe(true);
    expect(hasFocus(buildQuizPrompt({ ...opts, description: "" }))).toBe(false);
    expect(hasFocus(buildMindmapPrompt("enzymes"))).toBe(true);
  });
});

describe("shuffleQuizOptions", () => {
  const q = { question: "Q", options: ["right", "w1", "w2", "w3"], answerIndex: 0, explanation: "" };

  it("moves the answer index with its option", () => {
    const [out] = shuffleQuizOptions([q], () => 0);
    expect(out.options).not.toEqual(q.options);
    expect(out.options[out.answerIndex]).toBe("right");
    expect([...out.options].sort()).toEqual([...q.options].sort());
  });

  it("leaves positional and lettered options in place", () => {
    const positional = { ...q, options: ["a", "b", "c", "All of the above"] };
    const lettered = { ...q, options: ["A. a", "B. b", "C. c", "D. d"] };
    expect(shuffleQuizOptions([positional, lettered], () => 0)).toEqual([positional, lettered]);
  });

  it("leaves malformed questions alone", () => {
    const bad = { ...q, answerIndex: 9 };
    expect(shuffleQuizOptions([bad])).toEqual([bad]);
  });
});

describe("buildStoryboardPrompt variety", () => {
  it("uses the drawn format and angle only without a topic", () => {
    const blank = buildStoryboardPrompt({ topic: "" }, { format: "a what-if calculator", angle: "edge cases" });
    expect(blank).toContain("Lean toward a what-if calculator");
    expect(blank).toContain("edge cases");
    expect(blank).not.toMatch(/gains most/);
    const topic = buildStoryboardPrompt({ topic: "photosynthesis" }, { format: "a game", angle: "edge cases" });
    expect(topic).not.toContain("Lean toward");
  });

  it("lists earlier pages", () => {
    const prior = interactivePrior([art("interactive", { html: "x", storyboard: "Title: Cell Builder" })]);
    expect(buildStoryboardPrompt({ topic: "" }, { prior })).toContain("Cell Builder");
  });
});
