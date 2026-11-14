import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fake local speech server: records requests, answers from `server`. */
const server = vi.hoisted(() => ({
  voices: ["af_heart", "af_bella", "am_michael"] as string[] | null,
  reply: "mp3" as "mp3" | "wav" | "down" | "badvoice",
  requests: [] as { url: string; body?: Record<string, unknown>; auth?: string }[],
}));

vi.mock("./db", () => ({ getSetting: async () => "", setSetting: async () => {}, hasSetting: async () => false }));
vi.mock("./audioEncode", () => ({ encodeM4a: () => Promise.reject(new Error("no encoder in tests")) }));
vi.mock("../platform", () => ({
  platform: {
    kind: "desktop",
    fetch: async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      server.requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
      if (server.reply === "down") throw new TypeError("connection refused");
      if (url.endsWith("/audio/voices"))
        return server.voices ? new Response(JSON.stringify({ voices: server.voices })) : new Response("nope", { status: 404 });
      if (url.endsWith("/audio/speech/voices")) return new Response("nope", { status: 404 });
      if (url.endsWith("/audio/speech")) {
        if (server.reply === "badvoice") return new Response(JSON.stringify({ detail: "Voice 'nova' not found" }), { status: 400 });
        if (server.reply === "wav") return new Response(wavBytes([1000, 2000]));
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2]));
      }
      return new Response("not found", { status: 404 });
    },
  },
}));

/** The built-in voice, faked: is it downloaded, and what it was asked to say. */
const kokoro = vi.hoisted(() => ({ ready: true, said: [] as { text: string; voice: string }[] }));
vi.mock("./builtinKokoro", () => ({
  KOKORO_VOICES: [{ id: "af_heart" }, { id: "am_michael" }, { id: "bf_emma" }],
  kokoroReady: async () => kokoro.ready,
  kokoroLanes: () => 2,
  kokoroSpeak: async (text: string, voice: string) => {
    kokoro.said.push({ text, voice });
    // The first line finishes last: the joined file must still follow the script.
    await new Promise((r) => setTimeout(r, text.startsWith("Welcome") ? 20 : 0));
    return { samples: new Float32Array([text.startsWith("Welcome") ? 0.5 : -0.5]), rate: 24000 };
  },
}));

import { synthesizeScript } from "./tts";
import type { Settings } from "./types";

function wavBytes(samples: number[], rate = 24000): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
}

const settings = (over: Partial<Settings> = {}) =>
  ({
    ttsProvider: "local",
    localTtsBaseUrl: "localhost:8880",
    localTtsKey: "",
    ttsModel: "",
    ttsVoiceAlex: "nova", // left over from OpenAI
    ttsVoiceSam: "am_michael",
    ...over,
  }) as Settings;

const script = [
  { speaker: "Alex" as const, text: "Welcome." },
  { speaker: "Sam" as const, text: "Thanks." },
];

beforeEach(() => {
  server.voices = ["af_heart", "af_bella", "am_michael"];
  server.reply = "mp3";
  server.requests = [];
});

describe("local voices", () => {
  it("speaks each line on the local server and joins mp3 clips", async () => {
    const out = await synthesizeScript(script, settings({ localTtsKey: "secret" }));
    expect(out.audio).toMatch(/^data:audio\/mpeg;base64,/);
    const speech = server.requests.filter((r) => r.url.endsWith("/audio/speech"));
    expect(speech.map((r) => r.url)).toEqual(["http://localhost:8880/v1/audio/speech", "http://localhost:8880/v1/audio/speech"]);
    // "nova" isn't on the server: swapped for a server voice the co-host isn't using.
    expect(speech.map((r) => r.body?.voice)).toEqual(["af_heart", "am_michael"]);
    expect(speech[0].body).toMatchObject({ model: "kokoro", input: "Welcome.", response_format: "mp3" });
    expect(speech[0].auth).toBe("Bearer secret");
  });

  it("merges wav replies into one file", async () => {
    server.reply = "wav";
    const out = await synthesizeScript(script, settings());
    expect(out.audio).toMatch(/^data:audio\/wav;base64,/);
    const bytes = Uint8Array.from(atob(out.audio!.split(",")[1]), (c) => c.charCodeAt(0));
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(8); // 4 samples × 2 bytes
  });

  it("sends picks as they are when the server has no voice list", async () => {
    server.voices = null;
    await synthesizeScript(script, settings({ ttsVoiceAlex: "", ttsVoiceSam: "amy" }));
    const speech = server.requests.filter((r) => r.url.endsWith("/audio/speech"));
    expect(speech[0].body).not.toHaveProperty("voice"); // the server's own default
    expect(speech[1].body?.voice).toBe("amy");
  });

  it("explains an unreachable server and a refused voice", async () => {
    server.reply = "down";
    await expect(synthesizeScript(script, settings())).rejects.toThrow(/Couldn't reach your local speech server at http:\/\/localhost:8880\/v1/);
    server.reply = "badvoice";
    await expect(synthesizeScript(script, settings())).rejects.toThrow(/didn't accept the voice/);
  });

  it("asks for an address when none is set", async () => {
    const out = await synthesizeScript(script, settings({ localTtsBaseUrl: "" }));
    expect(out.audio).toBeNull();
    expect(out.note).toMatch(/address/);
  });
});

describe("the built-in voice", () => {
  beforeEach(() => {
    kokoro.ready = true;
    kokoro.said = [];
  });
  const turns = [
    { speaker: "Alex" as const, text: "Welcome back." },
    { speaker: "Sam" as const, text: "Glad to be here." },
  ];

  it("speaks each line in the hosts' voices, replacing one it doesn't have, with no server", async () => {
    server.requests = [];
    const { audio } = await synthesizeScript(turns, settings({ localTtsEngine: "builtin", localTtsBaseUrl: "" }));
    expect(kokoro.said).toEqual([
      { text: "Welcome back.", voice: "af_heart" },
      { text: "Glad to be here.", voice: "am_michael" },
    ]);
    expect(audio?.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(server.requests).toHaveLength(0);
    // In script order though spoken side by side: Host's sample (positive) before the Co-Host's.
    const wav = Uint8Array.from(atob(audio!.slice(audio!.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBeGreaterThan(0);
    expect(view.getInt16(46, true)).toBeLessThan(0);
  });

  it("asks for the download when the voice isn't on this computer", async () => {
    kokoro.ready = false;
    const r = await synthesizeScript(turns, settings({ localTtsEngine: "builtin" }));
    expect(r.audio).toBeNull();
    expect(r.note).toMatch(/Download the built-in voice/);
  });
});
