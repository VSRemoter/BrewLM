import type { Provider } from "./types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Token accounting for one completion, when the provider reports it. */
export interface StreamUsage {
  input?: number;
  output?: number;
  /** Input tokens served from the provider's prompt cache (~90% cheaper). */
  cachedRead?: number;
  /** Input tokens written into the provider's prompt cache. */
  cachedWrite?: number;
}

interface StreamOptions {
  provider: Provider;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  /** Abort mid-request to cancel generation; fetch + stream stop promptly. */
  signal?: AbortSignal;
  /** Called once the stream ends with provider-reported token usage (if any). */
  onUsage?: (usage: StreamUsage) => void;
}

/** True when an error came from an intentional AbortController cancel. */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || e.message === "The operation was aborted.")
  );
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
    headers["HTTP-Referer"] = "https://brewlm.app";
    headers["X-Title"] = "BrewLM";
  }

  // Anthropic-family models routed via OpenRouter support explicit prompt
  // caching: mark the (large, stable) system message as cacheable so repeat
  // turns in a notebook re-read the sources at ~10% cost instead of 100%.
  const cacheable = opts.provider === "openrouter" && /anthropic|claude/i.test(opts.model);
  const messages = cacheable
    ? opts.messages.map((m) =>
        m.role === "system"
          ? {
              role: m.role,
              content: [
                { type: "text", text: m.content, cache_control: { type: "ephemeral" } },
              ],
            }
          : m
      )
    : opts.messages;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.jsonMode && opts.provider === "openai") {
    body.response_format = { type: "json_object" };
  }
  // Ask for token usage in the final stream chunk (cost visibility).
  if (opts.provider === "openai") body.stream_options = { include_usage: true };
  if (opts.provider === "openrouter") body.usage = { include: true };
  // Image-generation models (e.g. gemini-*-image) need both modalities requested.
  if (opts.provider === "openrouter" && /image/i.test(opts.model)) {
    body.modalities = ["image", "text"];
  }

  const res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await apiError(res));
  if (!res.body) throw new Error("Empty response body");

  // Image-capable models return binary output in `images` (or typed content
  // parts), not in `content` — collect them and emit as markdown image embeds
  // after the text stream ends.
  const images: string[] = [];
  const pushImage = (url: string | null) => {
    if (url && !images.includes(url)) images.push(url);
  };
  let usage: StreamUsage = {};

  for await (const payload of sseLines(res.body)) {
    if (payload === "[DONE]") break;
    try {
      const json = JSON.parse(payload);
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content;
      if (typeof delta === "string") {
        if (delta) yield delta;
      } else if (Array.isArray(delta)) {
        // some providers stream content as typed parts
        for (const part of delta) {
          if (part?.type === "text" && typeof part.text === "string") yield part.text;
          else pushImage(imagePartUrl(part));
        }
      }
      const imgs = choice?.delta?.images ?? choice?.message?.images;
      if (Array.isArray(imgs)) for (const img of imgs) pushImage(imagePartUrl(img));
      // Final usage chunk (arrives with empty choices when include_usage is set).
      const u = json.usage;
      if (u && typeof u === "object") {
        usage = {
          input: u.prompt_tokens ?? u.input_tokens ?? usage.input,
          output: u.completion_tokens ?? u.output_tokens ?? usage.output,
          cachedRead: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? usage.cachedRead,
        };
      }
    } catch {
      // partial JSON chunk — ignore
    }
  }
  if (usage.input !== undefined || usage.output !== undefined) opts.onUsage?.(usage);
  for (const url of images) yield `\n\n![generated image](${url})\n\n`;
}

/** Pull an image URL/data-URI out of an OpenAI-style image part. */
function imagePartUrl(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  const nested = p.image_url as Record<string, unknown> | string | undefined;
  const url =
    (typeof nested === "string" ? nested : (nested?.url as string | undefined)) ??
    (typeof p.url === "string" ? p.url : undefined);
  if (url && (url.startsWith("data:image/") || url.startsWith("http"))) return url;
  if (typeof p.b64_json === "string") return `data:image/png;base64,${p.b64_json}`;
  return null;
}

async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<string> {
  const system = opts.messages.filter((m) => m.role === "system");
  const rest = opts.messages.filter((m) => m.role !== "system");
  const systemText = system.map((m) => m.content).join("\n\n");

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
      // One ephemeral cache breakpoint at the end of the (large, stable)
      // system prompt: repeat turns re-read the sources at ~10% input cost.
      system: systemText
        ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
        : undefined,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await apiError(res));
  if (!res.body) throw new Error("Empty response body");

  const usage: StreamUsage = {};
  for await (const payload of sseLines(res.body)) {
    try {
      const json = JSON.parse(payload);
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        yield json.delta.text as string;
      } else if (json.type === "message_start") {
        const u = json.message?.usage;
        if (u) {
          usage.input = u.input_tokens ?? usage.input;
          usage.output = u.output_tokens ?? usage.output;
          usage.cachedRead = u.cache_read_input_tokens ?? usage.cachedRead;
          usage.cachedWrite = u.cache_creation_input_tokens ?? usage.cachedWrite;
        }
      } else if (json.type === "message_delta") {
        const u = json.usage;
        if (u) {
          // message_delta carries cumulative output tokens (and possibly cache stats).
          usage.output = u.output_tokens ?? usage.output;
          usage.cachedRead = u.cache_read_input_tokens ?? usage.cachedRead;
          usage.cachedWrite = u.cache_creation_input_tokens ?? usage.cachedWrite;
          usage.input = u.input_tokens ?? usage.input;
        }
      } else if (json.type === "message_stop") {
        opts.onUsage?.(usage);
        return;
      } else if (json.type === "error") {
        throw new Error(json.error?.message ?? "Anthropic stream error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  opts.onUsage?.(usage);
}

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
    // Close the network stream when iteration ends early (break or abort).
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
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
