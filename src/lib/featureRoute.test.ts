import { describe, expect, it } from "vitest";
import { cloudJobsWhileLocal, featureProviders, localReady, staysLocal } from "./featureRoute";
import type { Provider, Settings } from "./types";

type S = Parameters<typeof cloudJobsWhileLocal>[0];

const base: S = {
  provider: "openai",
  visionRunsOn: "auto",
  transcribeRunsOn: "auto",
  localBaseUrl: "",
  localVisionModel: "",
  ttsProvider: "system",
};
const s = (over: Partial<Settings>): S => ({ ...base, ...over }) as S;
const keys = (...ps: Provider[]) => (p: Provider) => ps.includes(p);

describe("featureProviders", () => {
  it("Automatic on a cloud provider: chat provider first, other keys as backup (unchanged behavior)", () => {
    expect(featureProviders(s({ provider: "anthropic" }), "vision", keys("openai", "anthropic"))).toEqual(["anthropic", "openai"]);
    expect(featureProviders(s({}), "transcribe", keys("openrouter", "anthropic"))).toEqual(["openrouter"]);
  });

  it("Automatic with a local chat model never falls back to a saved cloud key", () => {
    const all = keys("openai", "openrouter", "anthropic", "brewlm");
    expect(featureProviders(s({ provider: "local" }), "vision", all)).toEqual([]);
    expect(featureProviders(s({ provider: "local", localBaseUrl: "http://localhost:11434/v1" }), "vision", all)).toEqual([]);
    expect(featureProviders(s({ provider: "local" }), "transcribe", all)).toEqual([]);
  });

  it("Automatic with a local chat model reads images locally once a vision model is picked", () => {
    const local = s({ provider: "local", localBaseUrl: "http://localhost:11434/v1", localVisionModel: "qwen2.5vl:7b" });
    expect(featureProviders(local, "vision", keys("openai"))).toEqual(["local"]);
  });

  it("an explicit cloud choice uses only that provider, even with a local chat model", () => {
    expect(featureProviders(s({ provider: "local", transcribeRunsOn: "openai" }), "transcribe", keys("openai", "openrouter"))).toEqual(["openai"]);
    expect(featureProviders(s({ visionRunsOn: "openrouter" }), "vision", keys("openai"))).toEqual([]);
  });

  it("a provider that can't do the job is never used", () => {
    expect(featureProviders(s({ transcribeRunsOn: "anthropic" }), "transcribe", keys("anthropic"))).toEqual([]);
    expect(featureProviders(s({ provider: "anthropic" }), "transcribe", keys("anthropic", "openai"))).toEqual(["openai"]);
  });

  it("Local works with a cloud chat provider", () => {
    const local = s({ visionRunsOn: "local", localBaseUrl: "http://localhost:1234/v1", localVisionModel: "gemma3" });
    expect(featureProviders(local, "vision", keys("openai"))).toEqual(["local"]);
    expect(staysLocal(local, "vision")).toBe(true);
  });
});

describe("localReady", () => {
  it("needs an address and a vision model; transcription can't run locally yet", () => {
    const ready = s({ localBaseUrl: "http://localhost:11434/v1", localVisionModel: "llava" });
    expect(localReady(ready, "vision")).toBe(true);
    expect(localReady({ ...ready, localBaseUrl: " " }, "vision")).toBe(false);
    expect(localReady(ready, "transcribe")).toBe(false);
  });
});

describe("cloudJobsWhileLocal", () => {
  it("is empty unless chat is local", () => {
    expect(cloudJobsWhileLocal(s({ ttsProvider: "openai", visionRunsOn: "openai" }), keys("openai"))).toEqual([]);
  });

  it("is empty when everything stays local", () => {
    expect(cloudJobsWhileLocal(s({ provider: "local" }), keys("openai", "openrouter"))).toEqual([]);
  });

  it("names jobs sent to the cloud by choice", () => {
    const local = s({ provider: "local", transcribeRunsOn: "openai", ttsProvider: "elevenlabs" });
    expect(cloudJobsWhileLocal(local, keys("openai"))).toEqual(["transcription", "audio overview voices"]);
  });

  it("doesn't name a cloud choice that has no key (nothing is sent)", () => {
    expect(cloudJobsWhileLocal(s({ provider: "local", visionRunsOn: "openai" }), keys())).toEqual([]);
  });
});
