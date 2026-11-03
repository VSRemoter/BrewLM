import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: { fetch: vi.fn() } }));
/** Saved settings rows (Provider routing lives under "openrouterRouting"). */
const settingsRows = vi.hoisted(() => new Map<string, string>());
vi.mock("./db", () => ({ getSetting: async (key: string) => settingsRows.get(key) ?? "" }));
vi.mock("./local", () => ({
  budgetForContext: () => ({ maxOutput: 4096 }),
  loadLocalServer: async () => null,
  localHeaders: () => ({}),
}));

import { AUTO_OUTPUT_TOKENS, complete, extractJson, supportsTemperature, takesThinking, ThinkSplitter } from "./llm";

/** A streamed reply made of SSE `data:` lines. */
function sse(...events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(new Blob([text]).stream(), { status: 200 });
}

const openAiText = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ finish_reason: "stop" }] }, "[DONE]");
const openAiRanOut = () => sse({ choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]");
const anthropicText = (text: string) =>
  sse(
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" }
  );
const anthropicRanOut = () =>
  sse({ type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" });
const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

const CATALOG = {
  data: [
    {
      id: "think/big",
      context_length: 200_000,
      top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
      supported_parameters: ["max_tokens", "reasoning"],
    },
    {
      id: "plain/small",
      context_length: 20_000,
      top_provider: { context_length: 20_000, max_completion_tokens: 16_000 },
      supported_parameters: ["max_tokens"],
    },
    { id: "warm/chat", supported_parameters: ["max_tokens", "temperature"] },
    { id: "anthropic/claude-opus-4.7", supported_parameters: ["max_tokens", "reasoning", "temperature"] },
  ],
};

const EFFORTS = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } };
/** Models API replies by model id; any other id is a 404. */
const CLAUDE_MODELS: Record<string, unknown> = {
  "claude-effort": { max_input_tokens: 1_000_000, max_tokens: 64_000, capabilities: { effort: EFFORTS } },
  "claude-sonnet-4-6": {
    max_input_tokens: 1_000_000,
    max_tokens: 64_000,
    capabilities: { effort: EFFORTS, thinking: { supported: true, types: { adaptive: { supported: true } } } },
  },
  "claude-opus-4-7": {
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: { effort: EFFORTS, thinking: { supported: true, types: { adaptive: { supported: true } } } },
  },
  "claude-opus-5-5": {
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: { effort: EFFORTS, thinking: { supported: true, types: { adaptive: { supported: true } } } },
  },
};

/** Request bodies sent to the chat endpoints, in order. */
let sent: Record<string, any>[];
/** Replies for the chat endpoints, used in order. */
let replies: Response[];

beforeEach(() => {
  sent = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify(CATALOG));
      if (url.startsWith("https://api.anthropic.com/v1/models/")) {
        const model = CLAUDE_MODELS[url.slice("https://api.anthropic.com/v1/models/".length)];
        return model ? new Response(JSON.stringify(model)) : new Response("{}", { status: 404 });
      }
      sent.push(JSON.parse(String(init?.body)));
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected request to ${url}`);
      return reply;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  settingsRows.clear();
});

const ask = (over: Partial<Parameters<typeof complete>[0]>) =>
  complete({
    provider: "openrouter",
    apiKey: "k",
    model: "think/big",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  });

describe("OpenRouter provider routing", () => {
  it("sends no provider object by default", async () => {
    replies.push(openAiText("ok"));
    await ask({});
    expect(sent[0].provider).toBeUndefined();
  });

  it("sends the saved routing and reports who served the reply", async () => {
    settingsRows.set("openrouterRouting", JSON.stringify({ sort: "price", noTraining: true }));
    replies.push(sse({ provider: "DeepInfra", choices: [{ delta: { content: "ok" } }] }, { usage: { prompt_tokens: 3, completion_tokens: 1 } }, "[DONE]"));
    let usage: { servedBy?: string } = {};
    await ask({ onUsage: (u) => (usage = u) });
    expect(sent[0].provider).toEqual({ sort: "price", data_collection: "deny" });
    expect(usage.servedBy).toBe("DeepInfra");
  });

  it("says when the routing left no provider for the model", async () => {
    settingsRows.set("openrouterRouting", JSON.stringify({ pins: { "think/big": { order: ["groq"], only: true } } }));
    replies.push(errorResponse(404, "No allowed providers are available for the selected model."));
    await expect(ask({})).rejects.toThrow(/under your provider routing \(only groq\)/);
  });
});

describe("OpenRouter output sizing", () => {
  it("uses the automatic ceiling and sends the thinking level to a model that reasons", async () => {
    replies.push(openAiText("ok"));
    expect(await ask({ thinking: "high" })).toBe("ok");
    expect(sent[0].max_tokens).toBe(AUTO_OUTPUT_TOKENS);
    expect(sent[0].reasoning).toEqual({ effort: "high" });
  });

  it("stays within the model's limit and the room beside the prompt", async () => {
    replies.push(openAiText("ok"));
    // ~10,000 prompt tokens in a 20,000-token window.
    await ask({ model: "plain/small", thinking: "high", messages: [{ role: "user", content: "x".repeat(35_000) }] });
    expect(sent[0].max_tokens).toBe(20_000 - 10_000 - 256);
    expect(sent[0].reasoning).toBeUndefined();
  });

  it("lowers a custom limit the model can't take, and leaves Auto thinking unsent", async () => {
    replies.push(openAiText("ok"));
    await ask({ maxOutput: 131_072 });
    expect(sent[0].max_tokens).toBe(64_000);
    expect(sent[0].reasoning).toBeUndefined();
  });

  it("retries with more room and low effort when thinking used everything", async () => {
    replies.push(openAiRanOut(), openAiText("done"));
    expect(await ask({ thinking: "high" })).toBe("done");
    expect(sent[1].max_tokens).toBe(64_000);
    expect(sent[1].reasoning).toEqual({ effort: "low" });
  });

  it("explains how to fix it when the retry runs out too", async () => {
    replies.push(openAiRanOut(), openAiRanOut());
    await expect(ask({ thinking: "high" })).rejects.toThrow(/64,000-token output allowance.*Thinking effort to Low/);
  });

  it("retries under the limit a low credit balance allows", async () => {
    replies.push(errorResponse(402, "You requested up to 32000 tokens, but can only afford 5000."), openAiText("ok"));
    expect(await ask({})).toBe("ok");
    expect(sent[1].max_tokens).toBe(5000);
  });
});

describe("OpenAI output sizing", () => {
  it("sends no cap on Auto, and effort only to reasoning models", async () => {
    replies.push(openAiText("a"), openAiText("b"));
    await ask({ provider: "openai", model: "gpt-4o", thinking: "high" });
    await ask({ provider: "openai", model: "o4-mini", thinking: "medium" });
    expect(sent[0].max_tokens).toBeUndefined();
    expect(sent[0].reasoning_effort).toBeUndefined();
    expect(sent[1].max_completion_tokens).toBeUndefined();
    expect(sent[1].reasoning_effort).toBe("medium");
  });

  it("retries a custom limit at the model's maximum when it's too big", async () => {
    replies.push(
      errorResponse(400, "max_tokens is too large: 65536. This model supports at most 16384 completion tokens, whereas you provided 65536."),
      openAiText("ok")
    );
    await ask({ provider: "openai", model: "gpt-4o", maxOutput: 65_536 });
    expect(sent[0].max_tokens).toBe(65_536);
    expect(sent[1].max_tokens).toBe(16_384);
  });
});

describe("Anthropic output sizing", () => {
  it("sizes to the model and sends effort when the Models API says it's supported", async () => {
    replies.push(anthropicText("ok"));
    expect(await ask({ provider: "anthropic", model: "claude-effort", thinking: "medium" })).toBe("ok");
    expect(sent[0].max_tokens).toBe(AUTO_OUTPUT_TOKENS);
    expect(sent[0].output_config).toEqual({ effort: "medium" });
  });

  it("falls back to a safe cap and no effort when the model can't be looked up", async () => {
    replies.push(anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-unknown", thinking: "high" });
    expect(sent[0].max_tokens).toBe(8192);
    expect(sent[0].output_config).toBeUndefined();
  });

  it("retries with low effort, then explains, when thinking used everything", async () => {
    replies.push(anthropicRanOut(), anthropicRanOut());
    await expect(ask({ provider: "anthropic", model: "claude-effort", thinking: "high" })).rejects.toThrow(
      /32,000-token output allowance/
    );
    expect(sent[1].output_config).toEqual({ effort: "low" });
  });
});

describe("Claude thinking", () => {
  it("turns adaptive thinking on with an effort when the model asks for it", async () => {
    replies.push(anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high" });
    expect(sent[0].output_config).toEqual({ effort: "high" });
    expect(sent[0].thinking).toEqual({ type: "adaptive" });
  });

  it("leaves thinking to the model on Auto, or when the model doesn't list adaptive thinking", async () => {
    replies.push(anthropicText("ok"), anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-sonnet-4-6" });
    await ask({ provider: "anthropic", model: "claude-effort", thinking: "high" });
    expect(sent[0].thinking).toBeUndefined();
    expect(sent[1].thinking).toBeUndefined();
  });

  it("asks for a summary of the thinking from Claude 4.7 on, which otherwise sends it empty", async () => {
    replies.push(anthropicText("ok"), anthropicText("ok"), anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-opus-4-7", thinking: "high" });
    await ask({ provider: "anthropic", model: "claude-opus-4-7" });
    await ask({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(sent[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    // 4.7 on Auto doesn't think, so thinking stays off.
    expect(sent[1].thinking).toBeUndefined();
    // Later models think by default; asking only adds the summary.
    expect(sent[2].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent[2].output_config).toBeUndefined();
  });
});

describe("Reasoning", () => {
  /** Every onReasoning call, in order. */
  const watch = () => {
    const seen: string[] = [];
    return { seen, onReasoning: (r: string) => seen.push(r) };
  };

  it("reads Claude's thinking deltas apart from the answer", async () => {
    replies.push(
      sse(
        { type: "content_block_start", content_block: { type: "thinking" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Weigh A. " } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Then B." } },
        { type: "content_block_delta", delta: { type: "signature_delta", signature: "sig" } },
        { type: "content_block_start", content_block: { type: "text" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "B it is." } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" }
      )
    );
    const w = watch();
    const out = await ask({ provider: "anthropic", model: "claude-opus-5-5", onReasoning: w.onReasoning });
    expect(out).toBe("B it is.");
    expect(w.seen[w.seen.length - 1]).toBe("Weigh A. Then B.");
  });

  it("reads reasoning fields from local servers and OpenRouter", async () => {
    replies.push(
      sse(
        { choices: [{ delta: { reasoning_content: "llama.cpp " } }] },
        { choices: [{ delta: { reasoning: "ollama " } }] },
        // OpenRouter sends both forms; the plain one wins so nothing doubles.
        { choices: [{ delta: { reasoning: "or ", reasoning_details: [{ type: "reasoning.text", text: "or " }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", summary: "sum" }, { type: "reasoning.encrypted", data: "x" }] } }] },
        { choices: [{ delta: { content: "Answer" } }] },
        { choices: [{ finish_reason: "stop" }] },
        "[DONE]"
      )
    );
    const w = watch();
    expect(await ask({ onReasoning: w.onReasoning })).toBe("Answer");
    expect(w.seen[w.seen.length - 1]).toBe("llama.cpp ollama or sum");
  });

  it("splits an inline <think> block out of the answer, even across chunks", async () => {
    replies.push(
      sse(
        { choices: [{ delta: { content: "<thi" } }] },
        { choices: [{ delta: { content: "nk>Let me see.</th" } }] },
        { choices: [{ delta: { content: "ink>\n\n" } }] },
        { choices: [{ delta: { content: "It's 4." } }] },
        { choices: [{ finish_reason: "stop" }] },
        "[DONE]"
      )
    );
    const w = watch();
    expect(await ask({ onReasoning: w.onReasoning })).toBe("It's 4.");
    expect(w.seen[w.seen.length - 1]).toBe("Let me see.");
  });

  it("starts the reasoning over when it retries after thinking used everything", async () => {
    replies.push(
      sse({ choices: [{ delta: { reasoning: "long..." } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"),
      sse({ choices: [{ delta: { reasoning: "short" } }] }, { choices: [{ delta: { content: "done" } }] }, "[DONE]")
    );
    const w = watch();
    expect(await ask({ thinking: "high", onReasoning: w.onReasoning })).toBe("done");
    expect(w.seen).toEqual(["long...", "", "short"]);
  });
});

describe("ThinkSplitter", () => {
  const run = (...chunks: string[]) => {
    const s = new ThinkSplitter();
    let text = "";
    let reasoning = "";
    for (const c of [...chunks.map((c) => s.push(c)), s.flush()]) {
      text += c.text;
      reasoning += c.reasoning;
    }
    return { text, reasoning };
  };

  it("leaves a reply that only mentions the tag alone", () => {
    expect(run("Use ", "<think> tags like this.")).toEqual({ text: "Use <think> tags like this.", reasoning: "" });
    expect(run("<b>bold</b>")).toEqual({ text: "<b>bold</b>", reasoning: "" });
  });

  it("takes <thinking> too, and keeps an unfinished block as reasoning", () => {
    expect(run("  <Thinking>hm</thinking>Yes")).toEqual({ text: "Yes", reasoning: "hm" });
    expect(run("<think>cut off mid-tho", "ught")).toEqual({ text: "", reasoning: "cut off mid-thought" });
  });
});

describe("extractJson", () => {
  it("skips the reasoning in front of the JSON", () => {
    expect(extractJson('<think>maybe {"a": 0}?</think>\n{"a": 1}')).toBe('{"a": 1}');
    // Some DeepSeek-R1 builds put the opening tag in the prompt.
    expect(extractJson('thinking about [1]...\n</think>\n[2]')).toBe("[2]");
  });
});

describe("Temperature", () => {
  it("knows which models take one, including Claude models not released yet", () => {
    for (const model of ["gpt-4o", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5-20250929",
      "claude-opus-4-20250514", "claude-3-7-sonnet-latest", "anthropic/claude-sonnet-4.6", "anthropic/claude-3.7-sonnet:thinking"])
      expect(supportsTemperature(model), model).toBe(true);
    for (const model of ["o4-mini", "gpt-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5-5", "claude-sonnet-5-5",
      "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-6", "anthropic/claude-opus-4.7"])
      expect(supportsTemperature(model), model).toBe(false);
  });

  it("is sent to Claude models that take it, and left off the rest", async () => {
    replies.push(anthropicText("ok"), anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-sonnet-4-6", temperature: 0.3 });
    await ask({ provider: "anthropic", model: "claude-opus-5-5", temperature: 0.3 });
    expect(sent[0].temperature).toBe(0.3);
    expect(sent[1].temperature).toBeUndefined();
  });

  it("is left off while Claude is thinking", async () => {
    replies.push(anthropicText("ok"));
    await ask({ provider: "anthropic", model: "claude-sonnet-4-6", temperature: 0.3, thinking: "low" });
    expect(sent[0].temperature).toBeUndefined();
    expect(sent[0].thinking).toEqual({ type: "adaptive" });
  });

  it("follows OpenRouter's list of what each model takes", async () => {
    replies.push(openAiText("ok"), openAiText("ok"), openAiText("ok"), openAiText("ok"));
    await ask({ model: "warm/chat", temperature: 0.3 });
    await ask({ model: "plain/small", temperature: 0.3 });
    await ask({ model: "anthropic/claude-opus-4.7", temperature: 0.3 });
    await ask({ model: "not/listed", temperature: 0.3 });
    expect(sent.map((b) => b.temperature)).toEqual([0.3, undefined, undefined, 0.3]);
  });
});

describe("takesThinking", () => {
  it("says which models take a thinking level, and null when it can't tell", async () => {
    expect(await takesThinking("openrouter", "k", "think/big")).toBe(true);
    expect(await takesThinking("openrouter", "k", "plain/small")).toBe(false);
    expect(await takesThinking("anthropic", "k", "claude-effort")).toBe(true);
    expect(await takesThinking("anthropic", "k", "claude-unknown")).toBeNull();
    expect(await takesThinking("openai", "k", "o4-mini")).toBe(true);
    expect(await takesThinking("openai", "k", "gpt-4o")).toBe(false);
    expect(await takesThinking("local", "", "llama")).toBe(false);
  });
});
