import { beforeEach, describe, expect, it, vi } from "vitest";

let server: { url: string; session: string } | null = null;
let plan: string | undefined;
vi.mock("./sync", () => ({
  shareServer: () => server,
  getSyncStatus: () => ({ state: "on", syncApiKeys: true, account: plan ? { plan } : undefined }),
}));

const { brewlmModelLabel, openRouterApi, OPENROUTER_API, planHasAi, SIGN_IN_FOR_AI, speaksOpenRouter, tierOf, aiConfigNow } = await import("./brewlmAi");

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
