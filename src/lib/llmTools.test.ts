/** Tool calling in llm.ts: what goes over the wire to each provider, and what comes back. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: { fetch: vi.fn() } }));
vi.mock("./db", () => ({ getSetting: async () => "" }));
vi.mock("./local", () => ({
  budgetForContext: () => ({ maxOutput: 4096 }),
  loadLocalServer: async () => null,
  localHeaders: () => ({}),
  ensureServerContext: async () => {},
  effectiveContext: () => 8192,
}));

import { complete, ReasoningDetails, ToolCallCollector, type LlmMessage, type ToolCall, type ToolSpec } from "./llm";

function sse(...events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(new Blob([text]).stream(), { status: 200 });
}

const TOOLS: ToolSpec[] = [
  { name: "search_sources", description: "Search.", parameters: { type: "object", properties: { query: { type: "string" } } } },
];

let sent: Record<string, any>[];
let replies: Response[];

beforeEach(() => {
  sent = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [] }));
      if (url.startsWith("https://api.anthropic.com/v1/models/")) return new Response("{}", { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected request to ${url}`);
      return reply;
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

async function call(provider: "openrouter" | "anthropic", model: string, messages: LlmMessage[], tools = TOOLS) {
  let asked: { calls: ToolCall[]; replay: unknown[] } | null = null;
  const text = await complete({
    provider,
    apiKey: "k",
    model,
    messages,
    tools,
    onToolCalls: (calls, replay) => {
      asked = { calls, replay };
    },
  });
  return { text, asked: asked as { calls: ToolCall[]; replay: unknown[] } | null };
}

describe("OpenAI-format providers (OpenRouter, OpenAI, BrewLM AI)", () => {
  it("sends tools and assembles a call streamed in pieces, with its reasoning details", async () => {
    replies.push(
      sse(
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "Need ", index: 0 }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a search.", index: 0, signature: "sig" }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_sources", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"dose"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      )
    );
    const r = await call("openrouter", "x/model", [{ role: "user", content: "q" }]);
    expect(sent[0].tools).toEqual([{ type: "function", function: TOOLS[0] }]);
    expect(sent[0].tool_choice).toBe("auto");
    expect(r.asked?.calls).toEqual([{ id: "call_1", name: "search_sources", arguments: '{"query":"dose"}' }]);
    expect(r.asked?.replay).toEqual([{ type: "reasoning.text", text: "Need a search.", index: 0, signature: "sig" }]);
  });

  it("sends calls and results back in OpenAI's shape, reasoning details included", async () => {
    replies.push(sse({ choices: [{ delta: { content: "5 mg" } }] }, "[DONE]"));
    await call("openrouter", "x/model", [
      { role: "system", content: "rules" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "search_sources", arguments: '{"query":"dose"}' }], replay: [{ type: "reasoning.text", text: "t" }] },
      { role: "tool", toolCallId: "call_1", content: "The dose is 5 mg." },
    ]);
    expect(sent[0].messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search_sources", arguments: '{"query":"dose"}' } }],
        reasoning_details: [{ type: "reasoning.text", text: "t" }],
      },
      { role: "tool", tool_call_id: "call_1", content: "The dose is 5 mg." },
    ]);
  });

  it("puts the cache breakpoint on the newest tool result for Claude", async () => {
    replies.push(sse({ choices: [{ delta: { content: "ok" } }] }, "[DONE]"));
    await complete({
      provider: "openrouter",
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      tools: TOOLS,
      cacheHistory: true,
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "q" },
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "search_sources", arguments: "{}" }] },
        { role: "tool", toolCallId: "c", content: "result" },
      ],
    });
    expect(sent[0].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c",
      content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }],
    });
  });

  it("sends no tool fields and reports no calls without tools", async () => {
    replies.push(sse({ choices: [{ delta: { content: "hi", tool_calls: [{ index: 0, id: "x", function: { name: "n" } }] } }] }, "[DONE]"));
    const r = await call("openrouter", "x/model", [{ role: "user", content: "q" }], []);
    expect(sent[0].tools).toBeUndefined();
    expect(sent[0].tool_choice).toBeUndefined();
    expect(r.asked).toBeNull();
    expect(r.text).toBe("hi");
  });
});

describe("Anthropic", () => {
  it("sends tools as input_schema and returns calls with their signed thinking", async () => {
    replies.push(
      sse(
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Search it." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking." } },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "search_sources", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query"' } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"dose"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
        { type: "message_stop" }
      )
    );
    const r = await call("anthropic", "claude-x", [{ role: "user", content: "q" }]);
    expect(sent[0].tools).toEqual([{ name: "search_sources", description: "Search.", input_schema: TOOLS[0].parameters }]);
    expect(sent[0].tool_choice).toEqual({ type: "auto" });
    expect(r.text).toBe("Checking.");
    expect(r.asked?.calls).toEqual([{ id: "toolu_1", name: "search_sources", arguments: '{"query":"dose"}' }]);
    expect(r.asked?.replay).toEqual([{ type: "thinking", thinking: "Search it.", signature: "SIG" }]);
  });

  it("sends thinking + tool_use back, results grouped in one user message, breakpoint on the last", async () => {
    replies.push(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "5 mg" } }, { type: "message_stop" }));
    await complete({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-x",
      tools: TOOLS,
      toolChoice: "none",
      cacheHistory: true,
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [
            { id: "t1", name: "search_sources", arguments: '{"query":"dose"}' },
            { id: "t2", name: "search_sources", arguments: "{bad" },
          ],
          replay: [{ type: "thinking", thinking: "Search it.", signature: "SIG" }],
        },
        { role: "tool", toolCallId: "t1", content: "r1" },
        { role: "tool", toolCallId: "t2", content: "r2" },
      ],
    });
    expect(sent[0].tool_choice).toEqual({ type: "none" });
    expect(sent[0].messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Search it.", signature: "SIG" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "t1", name: "search_sources", input: { query: "dose" } },
          { type: "tool_use", id: "t2", name: "search_sources", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r1" },
          { type: "tool_result", tool_use_id: "t2", content: "r2", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
  });
});

describe("collectors", () => {
  it("joins calls by index, by id, and gives calls without ids one", () => {
    const c = new ToolCallCollector();
    c.add([{ index: 1, id: "b", function: { name: "read_source", arguments: '{"source":"S1"}' } }]);
    c.add([{ index: 0, id: "a", function: { name: "list_sources", arguments: "{}" } }]);
    c.add([{ function: { name: "search_sources", arguments: { query: "x" } } }]);
    const done = c.done();
    expect(done.map((x) => x.name)).toEqual(["list_sources", "read_source", "search_sources"]);
    // A whole call with no index or id is a new call; object arguments are stringified, and it gets an id.
    expect(done[2].arguments).toBe('{"query":"x"}');
    expect(done[2].id).toMatch(/^call_2_/);
    // A piece with neither index, id nor name continues the last call's arguments.
    const d = new ToolCallCollector();
    d.add([{ id: "z", function: { name: "read_source", arguments: '{"source":' } }]);
    d.add([{ function: { arguments: '"S2"}' } }]);
    expect(d.done()).toEqual([{ id: "z", name: "read_source", arguments: '{"source":"S2"}' }]);
  });

  it("merges reasoning details by index and type", () => {
    const d = new ReasoningDetails();
    d.add([{ type: "reasoning.encrypted", data: "AB", index: 0 }]);
    d.add([{ type: "reasoning.encrypted", data: "CD", index: 0, id: "r1" }]);
    d.add([{ type: "reasoning.text", text: "x", index: 1 }]);
    expect(d.done()).toEqual([
      { type: "reasoning.encrypted", data: "ABCD", index: 0, id: "r1" },
      { type: "reasoning.text", text: "x", index: 1 },
    ]);
  });
});
