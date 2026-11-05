import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({}));
vi.mock("./research", () => ({}));
vi.mock("./genImage", () => ({}));
vi.mock("./imageApi", () => ({ isImageApiModel: async (m: string) => m.startsWith("img/") }));
vi.mock("../components/ChatPanel", () => ({}));
vi.mock("./rag", () => ({}));
vi.mock("./local", () => ({}));
vi.mock("./usage", () => ({}));

const { cloneReply, constitutionTurn, groundReply, isImageTurn, parseClone, starReply, stripOuterQuotes } = await import(
  "./chatTurns"
);

describe("shared chat commands", () => {
  it("/constitution flips, sets or explains", () => {
    expect(constitutionTurn("", true, true).next).toBe(false);
    expect(constitutionTurn(" ON ", false, true).next).toBe(true);
    // Already as asked: nothing to save.
    expect(constitutionTurn("on", true, true).next).toBeNull();
    expect(constitutionTurn("maybe", true, true)).toMatchObject({ next: null });
    expect(constitutionTurn("maybe", true, true).reply).toContain("currently **on**");
    expect(constitutionTurn("", true, false).reply).toContain("no constitution");
  });

  it("/ground says which way it went", () => {
    expect(groundReply(true)).toContain("Grounding **on**");
    expect(groundReply(false)).toContain("Grounding **off**");
  });

  it("strips straight and phone-style curly quotes", () => {
    expect(stripOuterQuotes('"Attention Is All You Need"')).toBe("Attention Is All You Need");
    expect(stripOuterQuotes("“Attention Is All You Need”")).toBe("Attention Is All You Need");
    expect(stripOuterQuotes('"half')).toBe('"half');
  });

  it("knows a picture turn", async () => {
    const s = (provider: string, model: string) => ({ provider, model }) as never;
    expect(await isImageTurn("/image a fox", s("openai", "gpt"))).toBe(true);
    expect(await isImageTurn("/remix darker", s("openai", "gpt"))).toBe(true);
    expect(await isImageTurn("a fox", s("openai", "gpt"))).toBe(false);
    // On an image model, plain messages draw; commands still don't.
    expect(await isImageTurn("a fox", s("openrouter", "img/flux"))).toBe(true);
    expect(await isImageTurn("/search foxes", s("openrouter", "img/flux"))).toBe(false);
  });

  it("/clone needs a quoted title; yes opens the copy", () => {
    expect(parseClone('/clone "Physics yes" no')).toEqual({ title: "Physics yes", jump: false });
    // Phones type curly quotes.
    expect(parseClone("/clone “Exam prep” yes")).toEqual({ title: "Exam prep", jump: true });
    expect(parseClone("/clone Exam prep")).toContain("Wrap the copy's title in quotes");
    expect(cloneReply("A", "B", true)).toContain("Taking you there");
  });

  it("/star says which way it went", () => {
    expect(starReply("Physics", false)).toContain("Starred “Physics”");
    expect(starReply("Physics", true)).toBe("Un-starred “Physics”.");
  });
});
