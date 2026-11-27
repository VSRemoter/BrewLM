import { describe, expect, it, vi } from "vitest";

/** Each call returns the next scripted part; `cut` parts report hitting the output limit. */
const script = vi.hoisted(() => ({ parts: [] as { text: string; cut?: boolean }[], seen: [] as any[] }));
vi.mock("./llm", () => ({
  complete: async (opts: any) => {
    script.seen.push(opts.messages);
    const p = script.parts.shift() ?? { text: "" };
    if (p.cut) opts.onCutOff?.();
    return p.text;
  },
}));

import { CONTINUE_PROMPT, joinParts, MAX_PARTS, writeInParts } from "./longWrite";

const request = { provider: "openrouter", apiKey: "k", model: "m", messages: [{ role: "user", content: "Write a long deck" }] } as any;

describe("joinParts", () => {
  it("drops a repeated overlap, a leading fence and a chatty opener", () => {
    expect(joinParts('{"slides": [{"title": "One"}, {"title": "Tw', 'Two"}, {"title": "Three"}]}')).toBe('{"slides": [{"title": "One"}, {"title": "Two"}, {"title": "Three"}]}');
    expect(joinParts('{"title": "Tw', 'o"}')).toBe('{"title": "Two"}');
    expect(joinParts("…the engine turns fuel into motion", "turns fuel into motion, and the brakes")).toBe("…the engine turns fuel into motion, and the brakes");
    expect(joinParts("## Part one\nSome text", "```json\nmore text")).toBe("## Part one\nSome textmore text");
    expect(joinParts("A line that stops mid", "Continuing:\n way through")).toBe("A line that stops mid way through");
  });

  it("drops a restarted line", () => {
    expect(joinParts("First line\n- Sleep helps memory consol", "- Sleep helps memory consolidation.\n- Next")).toBe(
      "First line\n- Sleep helps memory consolidation.\n- Next"
    );
  });
});

describe("writeInParts", () => {
  it("is one request when the reply fits", async () => {
    script.parts = [{ text: "whole thing" }];
    script.seen = [];
    expect(await writeInParts(request)).toBe("whole thing");
    expect(script.seen).toHaveLength(1);
  });

  it("asks for the rest while the reply is cut off, and joins the parts", async () => {
    script.parts = [{ text: "Part A and the start of ", cut: true }, { text: "the start of part B, ", cut: true }, { text: "then C." }];
    script.seen = [];
    const parts: number[] = [];
    expect(await writeInParts(request, (n) => parts.push(n))).toBe("Part A and the start of part B, then C.");
    expect(parts).toEqual([2, 3]);
    // Each continuation carries everything so far and the request to carry on.
    expect(script.seen[2].slice(-2)).toEqual([
      { role: "assistant", content: "Part A and the start of part B, " },
      { role: "user", content: CONTINUE_PROMPT },
    ]);
  });

  it("stops after MAX_PARTS", async () => {
    script.parts = Array.from({ length: 20 }, (_, i) => ({ text: `chunk number ${i} `, cut: true }));
    script.seen = [];
    await writeInParts(request);
    expect(script.seen).toHaveLength(MAX_PARTS);
  });
});
