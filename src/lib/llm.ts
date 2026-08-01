import type { Provider } from "./types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StreamOptions {
  provider: Provider;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
}

/**
 * Streams a chat completion, yielding text deltas.
 * All three providers are called directly from the webview — each allows
 * browser-direct access (Anthropic requires the dangerous-direct-browser-access header).
 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
  if (opts.provider === "anthropic") {
    yield* streamAnthropic(opts);
  } else {
    yield* streamOpenAICompatible(opts);
  }
}

/** Non-streaming helper — returns the full completion text. */
export async function complete(opts: StreamOptions): Promise<string> {
  let out = "";
  for await (const delta of streamChat(opts)) out += delta;
  return out;
}

async function* streamOpenAICompatible(opts: StreamOptions): AsyncGenerator<string> {
  const base =
    opts.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://openmind.app";
    headers["X-Title"] = "OpenMind";
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.jsonMode && opts.provider === "openai") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await apiError(res));
  if (!res.body) throw new Error("Empty response body");

  for await (const payload of sseLines(res.body)) {
    if (payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta: string | undefined =
        json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
      if (delta) yield delta;
    } catch {
      // partial JSON chunk — ignore
    }
  }
}

async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<string> {
  const system = opts.messages.filter((m) => m.role === "system");
  const rest = opts.messages.filter((m) => m.role !== "system");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
      system: system.map((m) => m.content).join("\n\n") || undefined,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(await apiError(res));
  if (!res.body) throw new Error("Empty response body");

  for await (const payload of sseLines(res.body)) {
    try {
      const json = JSON.parse(payload);
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        yield json.delta.text as string;
      } else if (json.type === "message_stop") {
        return;
      } else if (json.type === "error") {
        throw new Error(json.error?.message ?? "Anthropic stream error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          yield trimmed.slice(5).trim();
        }
      }
    }
    if (buffer.trim().startsWith("data:")) {
      yield buffer.trim().slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

async function apiError(res: Response): Promise<string> {
  let detail = "";
  try {
    const json = await res.json();
    detail = json.error?.message ?? JSON.stringify(json);
  } catch {
    detail = await res.text().catch(() => "");
  }
  return `API request failed (${res.status}): ${detail || res.statusText}`;
}

/** Extract the first complete JSON value from a model response. */
export function extractJson(text: string): string {
  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.search(/[[{]/);
  if (start === -1) return candidate.trim();
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(close);
  if (end === -1 || end < start) return candidate.trim();
  return candidate.slice(start, end + 1).trim();
}
