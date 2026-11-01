import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ value: "" }));
vi.mock("./db", () => ({ getSetting: async () => stored.value }));

import {
  DEFAULT_ROUTING,
  matchEndpoint,
  type ModelEndpoint,
  parseRouting,
  pinKey,
  providerPrefs,
  routingError,
  serializeRouting,
  withPin,
} from "./routing";

const endpoint = (slug: string, name: string): ModelEndpoint => ({
  slug,
  name,
  quantization: "",
  promptPrice: 0,
  completionPrice: 0,
  context: 0,
  status: 0,
});

describe("parseRouting", () => {
  it("falls back to the default for empty or corrupt values", () => {
    expect(parseRouting("")).toEqual(DEFAULT_ROUTING);
    expect(parseRouting("{not json")).toEqual(DEFAULT_ROUTING);
    expect(parseRouting(JSON.stringify({ sort: "random", ignore: "groq", pins: { m: { order: [] } } }))).toEqual(DEFAULT_ROUTING);
  });

  it("round-trips through serializeRouting, storing nothing for the default", () => {
    expect(serializeRouting(DEFAULT_ROUTING)).toBe("");
    const r = withPin({ ...DEFAULT_ROUTING, sort: "price", noTraining: true, ignore: ["deepinfra"] }, "a/b", { order: ["groq"], only: true });
    expect(parseRouting(serializeRouting(r))).toEqual(r);
  });
});

describe("providerPrefs", () => {
  it("sends nothing when everything is at its default", () => {
    expect(providerPrefs(DEFAULT_ROUTING, "a/b")).toBeUndefined();
  });

  it("maps the global rules to OpenRouter's fields", () => {
    const r = { ...DEFAULT_ROUTING, sort: "throughput" as const, noTraining: true, zdr: true, ignore: ["novita"] };
    expect(providerPrefs(r, "a/b")).toEqual({ sort: "throughput", data_collection: "deny", zdr: true, ignore: ["novita"] });
  });

  it("lets a model's pin replace the sort and win over a block", () => {
    const r = withPin({ ...DEFAULT_ROUTING, sort: "price", ignore: ["deepinfra", "novita"] }, "a/b", {
      order: ["deepinfra/turbo", "groq"],
      only: true,
    });
    expect(providerPrefs(r, "a/b")).toEqual({ order: ["deepinfra/turbo", "groq"], allow_fallbacks: false, ignore: ["novita"] });
    // Another model doesn't get the pin.
    expect(providerPrefs(r, "c/d")).toEqual({ sort: "price", ignore: ["deepinfra", "novita"] });
  });

  it("shares a pin across routing variants, not with :free", () => {
    expect(pinKey("a/b:nitro")).toBe("a/b");
    expect(pinKey("a/b:floor")).toBe("a/b");
    expect(pinKey("a/b:free")).toBe("a/b:free");
    const r = withPin(DEFAULT_ROUTING, "a/b", { order: ["groq"], only: false });
    expect(providerPrefs(r, "a/b:nitro")).toEqual({ order: ["groq"] });
    expect(providerPrefs(r, "a/b:free")).toBeUndefined();
  });
});

describe("matchEndpoint", () => {
  const list = [
    endpoint("deepinfra/turbo", "DeepInfra"),
    endpoint("google-vertex/us-central1", "Google"),
    endpoint("google-vertex", "Google"),
    endpoint("sambanova-turbo", "SambaNova"),
  ];

  it("keeps an exact variant slug and pins the base slug for a name", () => {
    expect(matchEndpoint(list, "deepinfra/turbo")).toBe("deepinfra/turbo");
    expect(matchEndpoint(list, "DeepInfra")).toBe("deepinfra");
    expect(matchEndpoint(list, "google")).toBe("google-vertex");
    expect(matchEndpoint(list, "Samba Nova")).toBe("sambanova-turbo");
    expect(matchEndpoint(list, "groq")).toBeUndefined();
  });
});

describe("routingError", () => {
  it("explains a no-provider failure only when the user's rules could cause it", async () => {
    const detail = "API request failed (404): No endpoints found matching your data policy";
    stored.value = "";
    expect(await routingError(detail, "a/b")).toBeNull();
    stored.value = serializeRouting({ ...DEFAULT_ROUTING, sort: "price" });
    expect(await routingError(detail, "a/b")).toBeNull();
    stored.value = serializeRouting({ ...DEFAULT_ROUTING, noTraining: true });
    expect(await routingError(detail, "a/b")).toMatch(/no providers that train on your data.*\/provider off/);
    expect(await routingError("API request failed (401): bad key", "a/b")).toBeNull();
  });
});
