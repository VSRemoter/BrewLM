import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fake local transcription server. */
const server = vi.hoisted(() => ({
  reply: "json" as "json" | "text" | "down" | "missing" | "badmodel",
  requests: [] as { url: string; form?: FormData; auth?: string }[],
}));

vi.mock("./db", () => ({ getSetting: async () => "", setSetting: async () => {}, hasSetting: async () => false }));
vi.mock("./usage", () => ({ recordUsage: async () => {} }));
vi.mock("./audioEncode", () => ({
  compressRecording: async () => null,
  splitRecording: async () => [],
  toTranscribeWav: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]),
}));
vi.mock("../platform", () => ({
  platform: {
    kind: "desktop",
    fetch: async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      server.requests.push({ url, form: init?.body as FormData, auth: headers.Authorization });
      if (server.reply === "down") throw new TypeError("connection refused");
      if (server.reply === "missing") return new Response("Not Found", { status: 404 });
      if (server.reply === "badmodel") return new Response('{"detail":"Model foo is not installed"}', { status: 404 });
      if (server.reply === "text") return new Response(" Hello from whisper.cpp \n");
      return new Response(JSON.stringify({ text: "Hello there." }));
    },
  },
}));

import { testLocalTranscription, transcribeAudio } from "./media";
import type { Settings } from "./types";

const settings = (over: Partial<Settings> = {}) =>
  ({
    provider: "local",
    transcribeRunsOn: "auto",
    visionRunsOn: "auto",
    localBaseUrl: "http://localhost:11434/v1",
    localSttBaseUrl: "localhost:8000",
    localSttKey: "",
    localSttModel: "Systran/faster-whisper-small",
    openaiKey: "sk-should-never-be-used",
    openaiTtsKey: "",
    openrouterKey: "",
    openrouterTtsKey: "",
    anthropicKey: "",
    keepRecordings: true,
    transcribeModels: {},
    ...over,
  }) as Settings;

const clip = () => new Blob([new Uint8Array(100)], { type: "audio/mpeg" });

beforeEach(() => {
  server.reply = "json";
  server.requests = [];
});

describe("local transcription", () => {
  it("sends the audio as WAV to the local server, never to a saved cloud key", async () => {
    const out = await transcribeAudio(clip(), "lecture.mp3", settings({ localSttKey: "k" }));
    expect(out.text).toBe("[Transcript]\n\nHello there.");
    expect(server.requests.map((r) => r.url)).toEqual(["http://localhost:8000/v1/audio/transcriptions"]);
    const form = server.requests[0].form!;
    expect(form.get("model")).toBe("Systran/faster-whisper-small");
    expect((form.get("file") as File).name).toBe("lecture.wav");
    expect((form.get("file") as File).type).toBe("audio/wav");
    expect(server.requests[0].auth).toBe("Bearer k");
  });

  it("asks for whisper-1 when no model is picked, and reads plain-text replies", async () => {
    server.reply = "text";
    const out = await transcribeAudio(clip(), "memo.m4a", settings({ localSttModel: "" }));
    expect(out.text).toBe("[Transcript]\n\nHello from whisper.cpp");
    expect(server.requests[0].form!.get("model")).toBe("whisper-1");
  });

  it("waits, without calling anything, when no transcription server is set", async () => {
    const out = await transcribeAudio(clip(), "memo.m4a", settings({ localSttBaseUrl: "" }));
    expect(out.text).toBe("");
    expect(out.warning).toMatch(/Settings → Local Models/);
    expect(server.requests).toEqual([]);
  });

  it("explains an unreachable server, a wrong address and a missing model", async () => {
    server.reply = "down";
    expect((await transcribeAudio(clip(), "a.mp3", settings())).warning).toMatch(/couldn't reach your local transcription server/);
    server.reply = "missing";
    expect((await transcribeAudio(clip(), "a.mp3", settings())).warning).toMatch(/wasn't found.*--inference-path/);
    server.reply = "badmodel";
    expect((await transcribeAudio(clip(), "a.mp3", settings())).warning).toMatch(/Check that “Systran\/faster-whisper-small” is on your transcription server/);
  });

  it("Test reports success and failure", async () => {
    expect(await testLocalTranscription(settings())).toMatchObject({ ok: true });
    server.reply = "down";
    expect(await testLocalTranscription(settings())).toMatchObject({ ok: false, message: expect.stringMatching(/^Couldn't reach/) });
  });
});
