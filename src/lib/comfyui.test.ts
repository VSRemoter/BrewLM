import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fake ComfyUI: answers like the real one's HTTP API. */
const comfy = vi.hoisted(() => ({
  requests: [] as { path: string; method: string; body?: unknown }[],
  /** /history polls that come back empty before the result shows up. */
  pending: 1,
  result: "ok" as "ok" | "error" | "nothing",
  queued: null as unknown,
}));
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

vi.mock("./db", () => ({ getSetting: async () => "" }));
vi.mock("../platform", () => ({
  platform: {
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      comfy.requests.push({ path: u.pathname, method: init?.method ?? "GET", body });
      if (u.port !== "8188") return new Response("Not Found", { status: 404 });
      switch (u.pathname) {
        case "/system_stats":
          return Response.json({ system: { comfyui_version: "0.9.0" }, devices: [{ name: "mps" }] });
        case "/object_info/CheckpointLoaderSimple":
          return Response.json({
            CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_base.safetensors", "dreamshaper.safetensors"], {}] } } },
          });
        case "/upload/image":
          return Response.json({ name: "brewlm-1.png", subfolder: "", type: "input" });
        case "/prompt":
          comfy.queued = (body as { prompt: unknown }).prompt;
          return Response.json({ prompt_id: "p1", number: 1, node_errors: {} });
        case "/history/p1": {
          if (comfy.pending-- > 0) return Response.json({});
          if (comfy.result === "error")
            return Response.json({
              p1: { outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_error", { node_type: "KSampler", exception_message: "out of memory\n" }]] } },
            });
          return Response.json({
            p1: {
              outputs: comfy.result === "nothing" ? {} : { "9": { images: [{ filename: "BrewLM_00001_.png", subfolder: "", type: "output" }] } },
              status: { status_str: "success", completed: true, messages: [] },
            },
          });
        }
        case "/view":
          return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
        case "/interrupt":
        case "/queue":
          return Response.json({});
      }
      return new Response("Not Found", { status: 404 });
    },
  },
}));

import {
  builtInWorkflow,
  comboOptions,
  type ComfyWorkflow,
  fillWorkflow,
  parseWorkflow,
  planWorkflow,
  PROMPT_TOKEN,
  runComfyWorkflow,
  workflowProblems,
} from "./comfyui";
import { detectImageServer, generateLocalImages, localImageCanEdit } from "./localImage";

/** Flux dev as ComfyUI's own example graph has it: split files, a guider, a custom sampler. */
const FLUX: ComfyWorkflow = {
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["11", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["10", 0] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "Flux", images: ["8", 0] } },
  "10": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "11": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl_fp8.safetensors", clip_name2: "clip_l.safetensors", type: "flux" } },
  "12": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" } },
  "13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["25", 0], guider: ["22", 0], sampler: ["16", 0], sigmas: ["17", 0], latent_image: ["27", 0] } },
  "16": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  "17": { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 20, denoise: 1, model: ["12", 0] } },
  "22": { class_type: "BasicGuider", inputs: { model: ["12", 0], conditioning: ["26", 0] } },
  "25": { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
  "26": { class_type: "FluxGuidance", inputs: { guidance: 3.5, conditioning: ["6", 0] } },
  "27": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
};

/** SDXL with a negative prompt and no placeholder: only the positive text may change. */
const SDXL_NEG: ComfyWorkflow = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, ugly", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "5": {
    class_type: "KSampler",
    inputs: { seed: 1, steps: 25, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["6", 0] } },
};

const server = { root: "http://localhost:8188", key: "" };
const run = (over: Partial<Parameters<typeof runComfyWorkflow>[1]> = {}) =>
  runComfyWorkflow(server, { prompt: "a red apple", width: 1024, height: 768, n: 1, model: "", workflow: "", pollMs: 1, ...over });

beforeEach(() => {
  comfy.requests = [];
  comfy.pending = 1;
  comfy.result = "ok";
  comfy.queued = null;
});

describe("parseWorkflow", () => {
  it("takes the API export, also wrapped in {prompt}", () => {
    expect(Object.keys(parseWorkflow(JSON.stringify(FLUX)))).toHaveLength(13);
    expect(Object.keys(parseWorkflow(JSON.stringify({ prompt: FLUX })))).toHaveLength(13);
  });
  it("explains the editor's regular save and junk", () => {
    expect(() => parseWorkflow(JSON.stringify({ nodes: [], links: [] }))).toThrow(/Export \(API\)/);
    expect(() => parseWorkflow("not json")).toThrow(/isn't JSON/);
    expect(() => parseWorkflow(JSON.stringify({ a: 1 }))).toThrow(/No ComfyUI nodes/);
  });
  it("reads both forms of a combo list", () => {
    expect(comboOptions([["a", "b"], {}])).toEqual(["a", "b"]);
    expect(comboOptions(["COMBO", { options: ["c"] }])).toEqual(["c"]);
  });
});

describe("planWorkflow", () => {
  it("follows Flux's guider back to the prompt and finds size and seed", () => {
    const plan = planWorkflow(FLUX);
    expect(plan.prompt).toEqual([["6", "text"]]);
    expect(plan.size).toEqual(["27"]);
    expect(plan.seeds).toEqual([["25", "noise_seed"]]);
    expect(plan.loadImage).toEqual([]);
    expect(workflowProblems(plan)).toEqual([]);
  });
  it("never writes into the negative prompt", () => {
    const filled = fillWorkflow(SDXL_NEG, planWorkflow(SDXL_NEG), { prompt: "a dog", width: 832, height: 1216, n: 2, random: () => 0.5 });
    expect(filled["2"].inputs.text).toBe("a dog");
    expect(filled["3"].inputs.text).toBe("blurry, ugly");
    expect(filled["4"].inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 });
    expect(filled["5"].inputs.seed).toBe(2 ** 47);
  });
  it("uses the placeholder when the workflow has one, keeping the words around it", () => {
    const wf: ComfyWorkflow = { ...SDXL_NEG, "2": { class_type: "CLIPTextEncode", inputs: { text: `photo of ${PROMPT_TOKEN}, 35mm`, clip: ["1", 1] } } };
    const filled = fillWorkflow(wf, planWorkflow(wf), { prompt: "a dog", width: 1024, height: 1024, n: 1 });
    expect(filled["2"].inputs.text).toBe("photo of a dog, 35mm");
  });
  it("says so when it can't find the prompt", () => {
    const wf: ComfyWorkflow = { "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } } };
    expect(workflowProblems(planWorkflow(wf))[0]).toMatch(/\{\{prompt\}\}/);
  });
});

describe("runComfyWorkflow", () => {
  it("draws with the built-in workflow on the first checkpoint, waiting for it to finish", async () => {
    const images = await run();
    expect(images).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
    const wf = comfy.queued as ComfyWorkflow;
    expect(wf["4"].inputs.ckpt_name).toBe("sdxl_base.safetensors");
    expect(wf["6"].inputs.text).toBe("a red apple");
    expect(wf["5"].inputs).toMatchObject({ width: 1024, height: 768 });
    expect(comfy.requests.filter((r) => r.path === "/history/p1").length).toBe(2);
  });

  it("runs the user's own workflow as exported, filled in", async () => {
    await run({ workflow: JSON.stringify(FLUX), model: "ignored.safetensors" });
    const wf = comfy.queued as ComfyWorkflow;
    expect(wf["6"].inputs.text).toBe("a red apple");
    expect(wf["12"].inputs.unet_name).toBe("flux1-dev.safetensors");
    expect(wf["27"].inputs).toMatchObject({ width: 1024, height: 768 });
  });

  it("edits: uploads the picture, loads it, and sets the strength", async () => {
    await run({ reference: "data:image/png;base64,iVBORw0KGgo=", strength: 0.4, model: "dreamshaper.safetensors" });
    expect(comfy.requests.some((r) => r.path === "/upload/image" && r.method === "POST")).toBe(true);
    const wf = comfy.queued as ComfyWorkflow;
    expect(wf["10"].inputs.image).toBe("brewlm-1.png");
    expect(wf["3"].inputs.denoise).toBe(0.4);
    expect(wf["4"].inputs.ckpt_name).toBe("dreamshaper.safetensors");
  });

  it("won't edit with a workflow that can't load a picture", async () => {
    await expect(run({ reference: "data:image/png;base64,AA==", workflow: JSON.stringify(FLUX) })).rejects.toThrow(/only draw new pictures/);
  });

  it("passes on ComfyUI's own error, and a workflow with no picture", async () => {
    comfy.result = "error";
    await expect(run()).rejects.toThrow("ComfyUI couldn't finish the picture (KSampler): out of memory");
    comfy.pending = 0;
    comfy.result = "nothing";
    await expect(run()).rejects.toThrow(/Save Image/);
  });

  it("stops ComfyUI when cancelled", async () => {
    comfy.pending = 1000;
    const ctl = new AbortController();
    const p = run({ signal: ctl.signal, pollMs: 5 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow(/Abort/);
    expect(comfy.requests.some((r) => r.path === "/interrupt")).toBe(true);
    expect(comfy.requests.some((r) => r.path === "/queue")).toBe(true);
  });
});

describe("ComfyUI through the local image path", () => {
  it("is recognized, lists checkpoints, and draws", async () => {
    expect(await detectImageServer({ localImageBaseUrl: "http://localhost:8188", localImageKey: "" })).toEqual({
      api: "comfyui",
      models: ["sdxl_base.safetensors", "dreamshaper.safetensors"],
    });
    const { images } = await generateLocalImages(
      { localImageBaseUrl: "http://localhost:8188", localImageKey: "", localImageModel: "", localImageApi: "comfyui", localImageWorkflow: "" },
      { prompt: "a red apple", aspectRatio: "1:1" }
    );
    expect(images).toHaveLength(1);
  });

  it("edits with the built-in workflow, or a workflow that loads a picture", () => {
    expect(localImageCanEdit({ localImageApi: "comfyui", localImageWorkflow: "" })).toBe(true);
    expect(localImageCanEdit({ localImageApi: "comfyui", localImageWorkflow: JSON.stringify(FLUX) })).toBe(false);
    expect(localImageCanEdit({ localImageApi: "comfyui", localImageWorkflow: JSON.stringify(builtInWorkflow("m", true)) })).toBe(true);
  });
});
