import { describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
  list: [
    { id: "z-ai/glm-5.3-flash", architecture: { input_modalities: ["text", "image", "video"] } },
    { id: "z-ai/glm-5.3", architecture: { input_modalities: ["text"] } },
  ] as { id: string; architecture: { input_modalities: string[] } }[] | null,
}));

vi.mock("./db", () => ({ getSetting: async () => "", setSetting: async () => {}, hasSetting: async () => false }));
vi.mock("./usage", () => ({ recordUsage: async () => {} }));
vi.mock("../platform", () => ({ platform: { kind: "desktop", fetch: async () => new Response("{}") } }));
vi.mock("./modelLimits",() => ({ loadOpenRouterCatalog: async () => catalog.list }));

import { visionModel } from "./media";

const s = (provider: string, model: string) => ({ provider, model, localVisionModel: "gemma3:1b-it-qat" }) as never;

describe("which model reads an image", () => {
  it("uses the OpenRouter chat model when it takes images", async () => {
    expect(await visionModel(s("openrouter", "z-ai/glm-5.3-flash"), "openrouter")).toBe("z-ai/glm-5.3-flash");
  });

  it("falls back to the default for a text-only or unknown chat model", async () => {
    expect(await visionModel(s("openrouter", "z-ai/glm-5.3"), "openrouter")).toBe("google/gemini-2.5-flash");
    expect(await visionModel(s("openrouter", "someone/new-model"), "openrouter")).toBe("google/gemini-2.5-flash");
  });

  it("falls back when the catalog can't be fetched", async () => {
    const saved = catalog.list;
    catalog.list = null;
    expect(await visionModel(s("openrouter", "z-ai/glm-5.3-flash"), "openrouter")).toBe("google/gemini-2.5-flash");
    catalog.list = saved;
  });

  it("doesn't borrow another provider's chat model when OpenRouter is the backup", async () => {
    expect(await visionModel(s("anthropic", "z-ai/glm-5.3-flash"), "openrouter")).toBe("google/gemini-2.5-flash");
  });

  it("keeps the local pick on this computer", async () => {
    expect(await visionModel(s("openrouter", "z-ai/glm-5.3-flash"), "local")).toBe("gemma3:1b-it-qat");
  });
});
