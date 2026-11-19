import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./db", () => ({ getSetting: async () => "" }));

import { platform } from "../platform";
import {
  AUTO_CONTEXT,
  clearServerContext,
  contextBudget,
  detectLocalServers,
  effectiveContext,
  ensureServerContext,
  isSpeechModel,
  isTranscribeModel,
  isVisionModel,
  knownServerContext,
  localHostVoices,
  parseLlamaProps,
  parseLmStudioModels,
  parseLocalContext,
  parseOllamaPs,
  parseOllamaShow,
  parseVllmModels,
  parseVoiceList,
  readServerContext,
} from "./local";

describe("isVisionModel", () => {
  it("spots common vision models by name", () => {
    for (const id of ["qwen2.5vl:7b", "qwen3-vl:8b", "gemma3:4b", "llava:13b", "llama3.2-vision", "minicpm-v", "moondream"])
      expect(isVisionModel(id), id).toBe(true);
    for (const id of ["llama3.1:8b", "mistral:7b", "deepseek-r1:8b", "nomic-embed-text", "qwen2.5:14b"])
      expect(isVisionModel(id), id).toBe(false);
  });
});

describe("isSpeechModel", () => {
  it("keeps speech models and drops transcription and embedding ones", () => {
    for (const id of ["kokoro", "tts-1", "speaches-ai/Kokoro-82M-v1.0-ONNX", "speaches-ai/piper-en_US-amy-low", "orpheus-3b"])
      expect(isSpeechModel(id), id).toBe(true);
    for (const id of ["Systran/faster-whisper-small", "whisper-1", "nomic-embed-text", "llama3.1:8b"])
      expect(isSpeechModel(id), id).toBe(false);
  });
});

describe("isTranscribeModel", () => {
  it("keeps speech-to-text models and drops speech and chat ones", () => {
    for (const id of ["Systran/faster-whisper-small", "deepdml/faster-whisper-large-v3-turbo-ct2", "whisper-1", "nvidia/parakeet-tdt-0.6b-v2"])
      expect(isTranscribeModel(id), id).toBe(true);
    for (const id of ["speaches-ai/Kokoro-82M-v1.0-ONNX", "kokoro", "llama3.1:8b", "nomic-embed-text"])
      expect(isTranscribeModel(id), id).toBe(false);
  });
});

describe("parseVoiceList", () => {
  it("reads the shapes speech servers use", () => {
    expect(parseVoiceList({ voices: ["af_heart", "am_adam"] })).toEqual(["af_heart", "am_adam"]);
    expect(parseVoiceList(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(parseVoiceList({ data: [{ id: "x" }, { voice_id: "y" }, { name: "z" }, { other: 1 }] })).toEqual(["x", "y", "z"]);
    expect(parseVoiceList({ detail: "Not Found" })).toEqual([]);
    expect(parseVoiceList(null)).toEqual([]);
  });
});

describe("localHostVoices", () => {
  const served = ["af_heart", "af_bella", "am_michael", "zz_custom"];

  it("keeps picks the server has", () => {
    expect(localHostVoices({ Alex: "af_bella", Sam: "zz_custom" }, served)).toEqual({ Alex: "af_bella", Sam: "zz_custom" });
  });

  it("replaces missing or leftover cloud voices with distinct server voices", () => {
    expect(localHostVoices({ Alex: "nova", Sam: "onyx" }, served)).toEqual({ Alex: "af_heart", Sam: "af_bella" });
    expect(localHostVoices({ Alex: "", Sam: "af_heart" }, served)).toEqual({ Alex: "af_bella", Sam: "af_heart" });
  });

  it("uses any server voices when none are Kokoro's", () => {
    expect(localHostVoices({ Alex: "", Sam: "" }, ["amy", "ryan"])).toEqual({ Alex: "amy", Sam: "ryan" });
    expect(localHostVoices({ Alex: "", Sam: "" }, ["only"])).toEqual({ Alex: "only", Sam: "only" });
  });

  it("sends the picks as they are when the server has no voice list", () => {
    expect(localHostVoices({ Alex: "nova", Sam: "" }, null)).toEqual({ Alex: "nova", Sam: "" });
  });
});

/* ------------------------- the server's real window ------------------------- */

// Shapes copied from real servers (Ollama 0.18, LM Studio's /api/v1 and /api/v0, llama.cpp b11960).
const OLLAMA_PS = {
  models: [{ name: "qwen3:0.6b", model: "qwen3:0.6b", size_vram: 1028598816, context_length: 4096 }],
};
const OLLAMA_SHOW = { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 } };
const LMS_V1 = {
  models: [
    { key: "qwen3.5-9b", max_context_length: 262144, loaded_instances: [] },
    { key: "nomic-embed", max_context_length: 2048, loaded_instances: [{ id: "nomic-embed", config: { context_length: 2048 } }] },
  ],
};
const LMS_V0 = {
  data: [{ id: "nomic-embed", state: "loaded", max_context_length: 2048, loaded_context_length: 2048 }],
  object: "list",
};
const LLAMA_PROPS = { default_generation_settings: { n_ctx: 3072 }, total_slots: 4 };

describe("server window parsers", () => {
  it("reads Ollama's loaded window, matching names with or without :latest", () => {
    expect(parseOllamaPs(OLLAMA_PS, "qwen3:0.6b")).toBe(4096);
    expect(parseOllamaPs({ models: [{ name: "llama3:latest", context_length: 8192 }] }, "llama3")).toBe(8192);
    expect(parseOllamaPs({ models: [] }, "qwen3:0.6b")).toBeNull(); // Ollama, model not loaded
    expect(parseOllamaPs(null, "qwen3:0.6b")).toBeUndefined(); // not Ollama
    expect(parseOllamaShow(OLLAMA_SHOW)).toBe(40960);
  });
  it("reads LM Studio's loaded window from either API", () => {
    expect(parseLmStudioModels(LMS_V1, "nomic-embed")).toEqual({ loaded: 2048, max: 2048 });
    expect(parseLmStudioModels(LMS_V1, "qwen3.5-9b")).toEqual({ loaded: null, max: 262144 });
    expect(parseLmStudioModels(LMS_V1, "missing")).toBeNull();
    expect(parseLmStudioModels(LMS_V0, "nomic-embed")).toEqual({ loaded: 2048, max: 2048 });
  });
  it("reads llama.cpp's per-request window and vLLM's max_model_len", () => {
    expect(parseLlamaProps(LLAMA_PROPS)).toBe(3072);
    expect(parseLlamaProps({ error: "nope" })).toBeNull();
    expect(parseVllmModels({ data: [{ id: "Qwen/Qwen3-8B", max_model_len: 32768 }] }, "Qwen/Qwen3-8B")).toBe(32768);
    expect(parseVllmModels({ data: [{ id: "x" }] }, "x")).toBeNull();
  });
});

describe("parseLocalContext", () => {
  it("reads a stored size, and anything else as Automatic", () => {
    expect(parseLocalContext("16384")).toBe(16384);
    expect(parseLocalContext("0")).toBe(AUTO_CONTEXT);
    expect(parseLocalContext("")).toBe(AUTO_CONTEXT);
    expect(parseLocalContext("junk")).toBe(AUTO_CONTEXT);
  });
});

/** A fake local server: path → JSON (or a status), and a log of requests. */
function fakeServer(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const p = platform as unknown as { kind: string; fetch: (url: string, init?: RequestInit) => Promise<Response> };
  p.kind = "desktop";
  p.fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const body = routes[path];
    if (typeof body === "function") return new Response(JSON.stringify((body as () => unknown)()));
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(body));
  };
  return calls;
}

const local = (model: string, localContext = AUTO_CONTEXT) => ({
  provider: "local" as const,
  localBaseUrl: "http://localhost:11434/v1",
  localKey: "",
  model,
  localContext,
});

describe("readServerContext", () => {
  it("tells the servers apart", async () => {
    fakeServer({ "/api/ps": OLLAMA_PS, "/api/show": OLLAMA_SHOW });
    expect(await readServerContext({ baseUrl: "localhost:11434", key: "" }, "qwen3:0.6b")).toEqual({ server: "Ollama", loaded: 4096, max: 40960 });
    fakeServer({ "/api/v1/models": LMS_V1 });
    expect(await readServerContext({ baseUrl: "http://localhost:1234/v1", key: "" }, "nomic-embed")).toEqual({ server: "LM Studio", loaded: 2048, max: 2048 });
    fakeServer({ "/props": LLAMA_PROPS });
    expect((await readServerContext({ baseUrl: "http://localhost:8080/v1", key: "" }, "any"))?.loaded).toBe(3072);
    fakeServer({ "/v1/models": { data: [{ id: "m" }] } });
    expect(await readServerContext({ baseUrl: "http://localhost:9000/v1", key: "" }, "m")).toBeNull();
  });

  it("knows the engines that share ports or imitate others", async () => {
    const at = (base: string) => readServerContext({ baseUrl: base, key: "" }, "m");
    // Strata copies llama.cpp's /props and /slots; its /v1/status gives it away.
    fakeServer({ "/v1/status": { loaded: true, auto_load: true }, "/slots": [{ id: 0, n_ctx: 65536 }], "/props": { n_predict: -1 } });
    expect(await at("http://127.0.0.1:8080/v1")).toEqual({ server: "Strata", loaded: 65536, max: null });
    fakeServer({ "/v1/status": { loaded: false, auto_load: true } });
    expect(await at("http://127.0.0.1:8080/v1")).toEqual({ server: "Strata", loaded: null, max: null });
    fakeServer({ "/api/extra/true_max_context_length": { value: 8192 }, "/api/ps": { models: [] } });
    expect((await at("http://localhost:5001/v1"))?.server).toBe("KoboldCpp");
    fakeServer({ "/v1/model": { id: "m", parameters: { max_seq_len: 16384 } } });
    expect(await at("http://localhost:5000/v1")).toEqual({ server: "TabbyAPI", loaded: 16384, max: null });
    fakeServer({ "/v1/models": { data: [{ id: "m", owned_by: "sglang", max_model_len: 40960 }] } });
    expect((await at("http://localhost:30000/v1"))?.server).toBe("SGLang");
    fakeServer({ "/slots": [{ id: 0, n_ctx: 4096 }] });
    expect((await at("http://localhost:8080/v1"))?.server).toBe("llama.cpp");
  });
});

describe("detectLocalServers", () => {
  it("names a server by what it reports, not by its port", async () => {
    const p = platform as unknown as { kind: string; fetch: (url: string, init?: RequestInit) => Promise<Response> };
    p.fetch = async (url: string) => {
      const u = new URL(url);
      if (u.port !== "8080") throw new Error("refused");
      if (u.pathname === "/v1/models") return new Response(JSON.stringify({ data: [{ id: "qwen3.8-flash-next" }] }));
      if (u.pathname === "/v1/status") return new Response(JSON.stringify({ loaded: true, auto_load: true }));
      return new Response("not found", { status: 404 });
    };
    expect(await detectLocalServers()).toEqual([
      { label: "Strata", baseUrl: "http://localhost:8080/v1", models: ["qwen3.8-flash-next"] },
    ]);
  });
});

describe("effectiveContext and ensureServerContext", () => {
  beforeEach(() => clearServerContext());

  it("uses the picked size (or 8K on Automatic) when the server hasn't said", () => {
    expect(effectiveContext(local("m"))).toBe(8192);
    expect(effectiveContext(local("m", 32768))).toBe(32768);
  });

  it("never sends more than the window Ollama loaded", async () => {
    fakeServer({ "/api/ps": OLLAMA_PS, "/api/show": OLLAMA_SHOW });
    await ensureServerContext(local("qwen3:0.6b", 32768));
    expect(effectiveContext(local("qwen3:0.6b", 32768))).toBe(4096);
    expect(effectiveContext(local("qwen3:0.6b"))).toBe(4096); // Automatic
    expect(effectiveContext(local("qwen3:0.6b", 2048))).toBe(2048); // smaller picks stand
    expect(contextBudget(local("qwen3:0.6b", 32768)).maxOutput).toBe(1024);
  });

  it("loads an unloaded model with one token first, then reads its window", async () => {
    let loaded = false;
    const calls = fakeServer({
      "/api/ps": () => ({ models: loaded ? OLLAMA_PS.models : [] }),
      "/api/show": OLLAMA_SHOW,
      "/v1/chat/completions": () => ((loaded = true), { choices: [] }),
    });
    await ensureServerContext(local("qwen3:0.6b"), { load: true });
    expect(calls.filter((c) => c === "POST /v1/chat/completions")).toHaveLength(1);
    expect(knownServerContext("http://localhost:11434/v1", "qwen3:0.6b")?.loaded).toBe(4096);
  });

  it("doesn't load anything unless asked", async () => {
    const calls = fakeServer({ "/api/ps": { models: [] }, "/api/show": OLLAMA_SHOW, "/v1/chat/completions": { choices: [] } });
    await ensureServerContext(local("qwen3:0.6b"));
    expect(calls).not.toContain("POST /v1/chat/completions");
    expect(knownServerContext("http://localhost:11434/v1", "qwen3:0.6b")).toBeNull();
  });

  it("does nothing for cloud providers or on the web app", async () => {
    const calls = fakeServer({ "/api/ps": OLLAMA_PS });
    await ensureServerContext({ ...local("qwen3:0.6b"), provider: "openrouter" });
    (platform as unknown as { kind: string }).kind = "web";
    await ensureServerContext(local("qwen3:0.6b"), { load: true });
    expect(calls).toHaveLength(0);
  });
});
