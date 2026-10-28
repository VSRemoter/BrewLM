import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: { fetch: vi.fn() } }));
vi.mock("./local", () => ({
  budgetForContext: () => ({ maxOutput: 4096 }),
  loadLocalServer: async () => null,
  localHeaders: () => ({}),
}));

import { AUTO_OUTPUT_TOKENS, complete, takesThinking } from "./llm";

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
  ],
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
      if (url === "https://api.anthropic.com/v1/models/claude-effort")
        return new Response(
          JSON.stringify({
            max_input_tokens: 1_000_000,
            max_tokens: 64_000,
            capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } },
          })
        );
      if (url.startsWith("https://api.anthropic.com/v1/models/")) return new Response("{}", { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected request to ${url}`);
      return reply;
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

const ask = (over: Partial<Parameters<typeof complete>[0]>) =>
  complete({
    provider: "openrouter",
    apiKey: "k",
    model: "think/big",
    messages: [{ role: "user", content: "hi" }],
    ...over,
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
