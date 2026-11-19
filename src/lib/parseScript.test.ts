import { describe, expect, it, vi } from "vitest";
vi.mock("./db", () => ({ getSetting: async () => "" }));
vi.mock("../platform", () => ({ platform: {} }));
import { parseScript } from "./tts";

describe("parseScript", () => {
  it("reads the plain format", () => {
    expect(parseScript("Host: Welcome back.\nCo-Host: Glad to be here.")).toEqual([
      { speaker: "Alex", text: "Welcome back." },
      { speaker: "Sam", text: "Glad to be here." },
    ]);
  });

  it("keeps a turn's second paragraph, and drops quotes and bold", () => {
    const raw = `**Host:** “Sleep isn't downtime.”\n\nThe study shows brain waves change.\n\nCo-Host: "Right."`;
    expect(parseScript(raw)).toEqual([
      { speaker: "Alex", text: "Sleep isn't downtime. The study shows brain waves change." },
      { speaker: "Sam", text: "Right." },
    ]);
  });

  it("takes the name on a line of its own, and Speaker 1/2 labels", () => {
    const raw = "**Host:**\nWelcome to the show.\n\n**Co-Host:**\nThanks!\nSpeaker 1: One more.\nSpeaker 2: And another.\nHost 2 (Sam): Last one.";
    expect(parseScript(raw).map((t) => [t.speaker, t.text])).toEqual([
      ["Alex", "Welcome to the show."],
      ["Sam", "Thanks!"],
      ["Alex", "One more."],
      ["Sam", "And another."],
      ["Sam", "Last one."],
    ]);
  });

  it("skips titles, headings, stage directions and the model's own notes", () => {
    const raw = [
      "Okay, here's a 10-minute podcast script based on your sources:",
      "# The Science of Sleep",
      "[Intro music]",
      "Host: Welcome.",
      "(laughs)",
      "Co-Host: [cheerfully] Hi there.",
      "**Part 2: Circadian rhythms**",
      "Host: The SCN sets the clock.",
      "",
      "I hope this helps! Let me know if you'd like changes.",
    ].join("\n");
    expect(parseScript(raw).map((t) => t.text)).toEqual(["Welcome.", "Hi there.", "The SCN sets the clock."]);
  });
});

describe("writeAudioScript", () => {
  it("asks once more when a reply has no usable lines", async () => {
    const { writeAudioScript } = await import("./audioScript");
    const prompts: string[] = [];
    const replies = [
      "Here's an outline you could use: sleep stages, circadian rhythm, dreams.", // no script lines
      "Host: Welcome.\nCo-Host: Hi.\nHost: Today, sleep.\nCo-Host: Let's go.",
    ];
    const turns = await writeAudioScript(
      { format: "brief", length: "short", mode: "conversation", sourceIds: [], description: "", variety: "" } as never,
      async (prompt) => {
        prompts.push(prompt);
        return replies.shift() ?? "";
      }
    );
    expect(turns).toHaveLength(4);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/ONLY the spoken lines/);
  });
});
