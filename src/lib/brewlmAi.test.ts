import { beforeEach, describe, expect, it, vi } from "vitest";

let server: { url: string; session: string } | null = null;
let plan: string | undefined;
vi.mock("./modelLimits", () => ({
  loadOpenRouterCatalog: async () => [
    { id: "anthropic/claude-haiku-5.5", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
    { id: "anthropic/claude-sonnet-5.5", pricing: { prompt: "0.000002", completion: "0.00001" } },
  ],
}));
vi.mock("./sync", () => ({
  shareServer: () => server,
  getSyncStatus: () => ({ state: "on", syncApiKeys: true, account: plan ? { plan } : undefined }),
}));

const { aiBlock, brewlmChatModels, costLabel, costVsFast, brewlmModelLabel, openRouterApi, OPENROUTER_API, planHasAi, SIGN_IN_FOR_AI, speaksOpenRouter, tierOf, aiConfigNow } = await import("./brewlmAi");

beforeEach(() => {
  server = null;
  plan = undefined;
});

describe("BrewLM AI requests", () => {
  it("go to the sync server's proxy with the session, never to OpenRouter", () => {
    server = { url: "https://sync.example", session: "sess-1" };
    expect(openRouterApi("brewlm", "sk-or-ignored")).toEqual({ base: "https://sync.example/v1/ai/openrouter", key: "sess-1", headers: {} });
  });

  it("ask for a sign-in when signed out", () => {
    expect(() => openRouterApi("brewlm", "")).toThrow(SIGN_IN_FOR_AI);
  });

  it("leave the user's own OpenRouter key going to OpenRouter", () => {
    server = { url: "https://sync.example", session: "sess-1" };
    const api = openRouterApi("openrouter", "sk-or-mine");
    expect(api.base).toBe(OPENROUTER_API);
    expect(api.key).toBe("sk-or-mine");
    expect(api.headers["X-Title"]).toBe("BrewLM");
  });

  it("use OpenRouter's request format", () => {
    expect(speaksOpenRouter("brewlm")).toBe(true);
    expect(speaksOpenRouter("openrouter")).toBe(true);
    expect(speaksOpenRouter("anthropic")).toBe(false);
  });
});

describe("BrewLM AI plans and tiers", () => {
  it("is on for Pro and Max, off for Sync plans", () => {
    plan = "pro";
    expect(planHasAi()).toBe(true);
    plan = "max";
    expect(planHasAi()).toBe(true);
    plan = "plus";
    expect(planHasAi()).toBe(false);
  });

  it("names tier models by their tier", () => {
    const fast = aiConfigNow().tiers.fast.model;
    expect(tierOf(fast)).toBe("fast");
    expect(brewlmModelLabel(fast)).toBe("Fast");
    expect(brewlmModelLabel("someone/else")).toBe("someone/else");
  });
});

describe("BrewLM AI allowance", () => {
  it("recognises the proxy's refusals", () => {
    expect(aiBlock("You've used this month's BrewLM AI. It refills on December 1, or add a top-up")).toBe("limit");
    expect(aiBlock("BrewLM AI comes with the Pro and Max plans. Choose one in Settings → Sync")).toBe("plan");
    expect(aiBlock("HTTP 500: upstream error")).toBeNull();
  });

  it("compares a model's chat cost with Fast's", async () => {
    expect(await costVsFast("anthropic/claude-sonnet-5.5")).toBeCloseTo(20, 5);
    expect(await costVsFast("nobody/unknown")).toBeNull();
    expect(costLabel(20)).toBe("about 20× Fast");
    expect(costLabel(3.4)).toBe("about 3× Fast");
    expect(costLabel(2.2)).toBe("about 2.2× Fast");
    expect(costLabel(1)).toBe("about the same as Fast");
    expect(costLabel(0.4)).toBe("cheaper than Fast");
  });

  it("lists the tiers before More models", () => {
    const all = brewlmChatModels();
    expect(all.slice(0, 3)).toEqual(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]);
    expect(all.length).toBeGreaterThan(3);
    expect(brewlmModelLabel("x-ai/grok-4.7")).toBe("Grok 4.7");
  });
});
