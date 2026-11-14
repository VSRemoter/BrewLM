import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./db", () => ({ getSetting: async () => "" }));

import { isSpeechModel, isTranscribeModel, isVisionModel, localHostVoices, parseVoiceList } from "./local";

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
