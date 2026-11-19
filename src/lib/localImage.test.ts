import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fake image server: "a1111" (Forge/Draw Things), "openai" (LocalAI), or "none". */
const server = vi.hoisted(() => ({
  kind: "a1111" as "a1111" | "openai" | "none" | "down",
  openaiUrlReply: false,
  requests: [] as { url: string; method: string; body?: Record<string, unknown> }[],
}));
const PNG = "iVBORw0KGgo" + "A".repeat(200);

vi.mock("./db", () => ({ getSetting: async () => "" }));
vi.mock("../platform", () => ({
  platform: {
    fetch: async (url: string, init?: RequestInit) => {
      server.requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (server.kind === "down") throw new TypeError("connection refused");
      const path = new URL(url).pathname;
      if (server.kind === "a1111") {
        if (path === "/sdapi/v1/sd-models") return Response.json([{ title: "sdxl_base.safetensors [31e35c80fc]" }, { model_name: "dreamshaper" }]);
        if (path === "/sdapi/v1/txt2img" || path === "/sdapi/v1/img2img") return Response.json({ images: [PNG, PNG, PNG] });
        if (path === "/sdapi/v1/interrupt") return Response.json({});
      }
      if (server.kind === "openai") {
        if (path === "/v1/models") return Response.json({ data: [{ id: "llama3" }, { id: "stablediffusion" }] });
        if (path === "/v1/images/generations")
          return Response.json({ data: [server.openaiUrlReply ? { url: "http://localhost:8080/generated/1.png" } : { b64_json: PNG }] });
        if (path === "/generated/1.png") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
      }
      return new Response("Not Found", { status: 404 });
    },
  },
}));

import { imageRoute } from "./featureRoute";
import { detectImageServer, generateLocalImages, imageServerRoot, ratioOf, sizeFor } from "./localImage";
import type { Settings } from "./types";

const s = (over: Partial<Settings> = {}) =>
  ({ localImageBaseUrl: "http://localhost:7860", localImageKey: "", localImageModel: "", localImageApi: "", ...over }) as Settings;

beforeEach(() => {
  server.kind = "a1111";
  server.openaiUrlReply = false;
  server.requests = [];
});

describe("imageRoute", () => {
  const r = (over: Partial<Settings>) =>
    imageRoute({ provider: "openrouter", imageRunsOn: "auto", localImageBaseUrl: "", openrouterKey: "", ...over } as Settings);

  it("Automatic keeps the old behavior for cloud providers", () => {
    expect(r({ openrouterKey: "k" })).toEqual({ via: "openrouter" });
    expect(r({ provider: "brewlm" })).toEqual({ via: "brewlm" });
    expect(r({})).toHaveProperty("error", expect.stringMatching(/OpenRouter API key/));
  });

  it("Automatic with a local chat model draws locally, never on a saved OpenRouter key", () => {
    expect(r({ provider: "local", openrouterKey: "k" })).toHaveProperty("error", expect.stringMatching(/no image server/));
    expect(r({ provider: "local", localImageBaseUrl: "http://localhost:7860" })).toEqual({ via: "local" });
  });

  it("an explicit choice wins", () => {
    expect(r({ provider: "local", imageRunsOn: "openrouter", openrouterKey: "k" })).toEqual({ via: "openrouter" });
    expect(r({ provider: "brewlm", imageRunsOn: "local", localImageBaseUrl: "x" })).toEqual({ via: "local" });
  });
});

describe("sizes and addresses", () => {
  it("sizes a ratio to about a megapixel in steps of 64", () => {
    expect(sizeFor(undefined, "sdxl")).toEqual({ width: 1024, height: 1024 });
    expect(sizeFor("16:9", "flux")).toEqual({ width: 1344, height: 768 });
    expect(sizeFor("9:16", "")).toEqual({ width: 768, height: 1344 });
    expect(sizeFor("1:1", "v1-5-pruned-emaonly")).toEqual({ width: 512, height: 512 });
    expect(sizeFor("100:1", "")).toEqual({ width: 2048, height: 512 }); // clamped to 4:1
    expect(sizeFor("nonsense", "")).toEqual({ width: 1024, height: 1024 });
  });

  it("finds a picture's ratio", () => {
    expect(ratioOf(1344, 768)).toBe("7:4");
    expect(ratioOf(0, 10)).toBeUndefined();
  });

  it("finds the server root", () => {
    expect(imageServerRoot("localhost:7860/")).toBe("http://localhost:7860");
    expect(imageServerRoot("http://h:8080/v1")).toBe("http://h:8080");
    expect(imageServerRoot("http://h:7860/sdapi/v1")).toBe("http://h:7860");
  });
});

describe("detectImageServer", () => {
  it("recognises an Automatic1111-style server and its checkpoints", async () => {
    expect(await detectImageServer(s())).toEqual({ api: "a1111", models: ["sdxl_base.safetensors [31e35c80fc]", "dreamshaper"] });
  });

  it("recognises an OpenAI-style server, image models first", async () => {
    server.kind = "openai";
    expect(await detectImageServer(s({ localImageBaseUrl: "http://localhost:8080/v1" }))).toEqual({
      api: "openai",
      models: ["stablediffusion", "llama3"],
    });
  });

  it("explains a server that's neither, or down", async () => {
    server.kind = "none";
    await expect(detectImageServer(s())).rejects.toThrow(/--api/);
    server.kind = "down";
    await expect(detectImageServer(s())).rejects.toThrow(/Couldn't reach your image server at http:\/\/localhost:7860/);
  });
});

describe("generateLocalImages", () => {
  it("A1111: detects once, draws at the ratio's size, picks the checkpoint, keeps only what was asked", async () => {
    const detected: string[] = [];
    const out = await generateLocalImages(s({ localImageModel: "dreamshaper" }), { prompt: "a fox", aspectRatio: "16:9" }, (a) => detected.push(a));
    expect(detected).toEqual(["a1111"]);
    expect(out.images).toEqual([`data:image/png;base64,${PNG}`]);
    const draw = server.requests.find((r) => r.url.endsWith("/txt2img"))!;
    expect(draw.body).toMatchObject({
      prompt: "a fox",
      width: 1344,
      height: 768,
      batch_size: 1,
      override_settings: { sd_model_checkpoint: "dreamshaper" },
    });
  });

  it("A1111: an edit sends the picture to img2img without its data: prefix", async () => {
    await generateLocalImages(s({ localImageApi: "a1111" }), { prompt: "stormy sky", reference: "data:image/jpeg;base64,QUJD", strength: 0.6 });
    const edit = server.requests.find((r) => r.url.endsWith("/img2img"))!;
    expect(edit.body).toMatchObject({ init_images: ["QUJD"], denoising_strength: 0.6 });
    expect(server.requests.some((r) => r.url.endsWith("/sd-models"))).toBe(false); // already known
  });

  it("A1111: cancelling also stops the server", async () => {
    const ctrl = new AbortController();
    const p = generateLocalImages(s({ localImageApi: "a1111" }), { prompt: "x", signal: ctrl.signal });
    ctrl.abort();
    await p.catch(() => {});
    expect(server.requests.some((r) => r.url.endsWith("/sdapi/v1/interrupt"))).toBe(true);
  });

  it("OpenAI-style: draws at /v1/images/generations, and fetches a file link", async () => {
    server.kind = "openai";
    const settings = s({ localImageBaseUrl: "http://localhost:8080/v1", localImageApi: "openai", localImageModel: "stablediffusion" });
    const out = await generateLocalImages(settings, { prompt: "a fox", aspectRatio: "1:1" });
    expect(out.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(server.requests[0]).toMatchObject({
      url: "http://localhost:8080/v1/images/generations",
      body: { model: "stablediffusion", prompt: "a fox", n: 1, size: "1024x1024", response_format: "b64_json" },
    });
    server.openaiUrlReply = true;
    expect((await generateLocalImages(settings, { prompt: "a fox" })).images[0]).toBe("data:image/png;base64,iVBORw==");
  });

  it("OpenAI-style: says it can't edit", async () => {
    await expect(
      generateLocalImages(s({ localImageApi: "openai" }), { prompt: "x", reference: "data:image/png;base64,QQ==" })
    ).rejects.toThrow(/only draw new pictures/);
  });
});
