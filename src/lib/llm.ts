import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { budgetForContext, loadLocalServer, localHeaders } from "./local";
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
  /** Real billed cost in USD, when the provider reports it (OpenRouter). */
  costUsd?: number;
}

interface StreamOptions {
  provider: Provider;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  /** Sampling temperature (0–1). Undefined = provider default: never sent. */
  temperature?: number;
  /** Abort mid-request to cancel generation; fetch + stream stop promptly. */
  signal?: AbortSignal;
  /** Called once the stream ends with provider-reported token usage (if any). */
  onUsage?: (usage: StreamUsage) => void;
}

/**
 * Reasoning-model families (o1/o3/o4, gpt-5) reject sampling params and
 * `max_tokens` — the settings UI uses supportsTemperature() to hint, and
 * request builders use isReasoningModel() to send max_completion_tokens.
 */
function isReasoningModel(model: string): boolean {
  return /^(openai\/)?(o1|o3|o4|gpt-5)/i.test(model.trim());
}

/** Reasoning-model families reject sampling params like temperature. */
export function supportsTemperature(model: string): boolean {
  return !isReasoningModel(model);
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
 * Cloud providers are called directly from the webview — each allows
 * browser-direct access (Anthropic requires the dangerous-direct-browser-access header).
 * Local servers go through the Rust backend instead (no CORS setup needed).
 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
  if (opts.provider === "anthropic") {
    yield* streamAnthropic(opts);
  } else {
    yield* streamOpenAICompatible(opts);
  }
}

/**
 * Output ceiling for long-form generations (reports, mind maps, Studio decks,
 * podcast scripts, research write-ups). Reasoning models spend part of it
 * thinking, so 4096 could run out before the answer. It's a cap, not a cost —
 * only the tokens actually written are billed.
 */
export const LONG_OUTPUT_TOKENS = 8192;

/** Non-streaming helper — returns the full completion text. */
export async function complete(opts: StreamOptions): Promise<string> {
  let out = "";
  for await (const delta of streamChat(opts)) out += delta;
  return out;
}

async function* streamOpenAICompatible(opts: StreamOptions): AsyncGenerator<string> {
  const local = opts.provider === "local" ? await loadLocalServer() : null;
  if (local && !local.baseUrl) throw new Error("Set your local server address in Settings → AI Model.");
  if (local && !opts.model.trim()) throw new Error("Pick a local model in Settings → AI Model.");
  const base = local
    ? `${local.baseUrl}/chat/completions`
    : opts.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";

  const headers: Record<string, string> = local
    ? localHeaders(local.key)
    : { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` };
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
    stream_options: { include_usage: true },
  };
  // Local windows are small: never ask for more output than the budget leaves room for.
  const maxTokens = local
    ? Math.min(opts.maxTokens ?? 4096, budgetForContext(local.context).maxOutput)
    : opts.maxTokens ?? 4096;
  // o1/o3/gpt-5-class models reject `max_tokens` outright — the request fails.
  if (isReasoningModel(opts.model)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
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
  if (opts.temperature != null && supportsTemperature(opts.model)) {
    body.temperature = opts.temperature;
  }

  // A reasoning model can spend the whole output allowance thinking and stop
  // ("length") before writing a word. Nothing has been shown yet then, so try
  // once more with twice the room and its thinking turned down.
  for (let attempt = 0; ; attempt++) {
    const res = await (local ? tauriFetch : fetch)(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    }).catch((e) => {
      if (local && !isAbortError(e)) throw new Error(`Couldn't reach your local server at ${local.baseUrl}. Is it running?`);
      throw e;
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
    let wroteText = false;
    let finishReason: string | undefined;

    for await (const payload of sseLines(res.body)) {
      if (payload === "[DONE]") break;
      try {
        const json = JSON.parse(payload);
        const choice = json.choices?.[0];
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice?.delta?.content ?? choice?.message?.content;
        if (typeof delta === "string") {
          if (delta) {
            wroteText = true;
            yield delta;
          }
        } else if (Array.isArray(delta)) {
          // some providers stream content as typed parts
          for (const part of delta) {
            if (part?.type === "text" && typeof part.text === "string") {
              if (part.text) wroteText = true;
              yield part.text;
            } else pushImage(imagePartUrl(part));
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
            // OpenRouter reports the real billed amount when usage:include is set.
            costUsd: typeof u.cost === "number" ? u.cost : usage.costUsd,
          };
        }
      } catch {
        // partial JSON chunk — ignore
      }
    }
    if (usage.input !== undefined || usage.output !== undefined) opts.onUsage?.(usage);
    for (const url of images) yield `\n\n![generated image](${url})\n\n`;

    const ranOutThinking = finishReason === "length" && !wroteText && images.length === 0;
    if (!ranOutThinking) return;
    const room = (body.max_completion_tokens ?? body.max_tokens) as number;
    if (attempt === 0 && !local) {
      if (body.max_completion_tokens) body.max_completion_tokens = room * 2;
      else body.max_tokens = room * 2;
      if (opts.provider === "openrouter") body.reasoning = { effort: "low" };
      else if (isReasoningModel(opts.model)) body.reasoning_effort = "low";
      continue;
    }
    throw new Error(
      `“${opts.model}” spent its whole ${room.toLocaleString()}-token output allowance thinking and never wrote an answer. ` +
        "Try again, or use a model that thinks less (or not at all) for this — reasoning models can run out of room on long outputs like reports and mind maps."
    );
  }
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
      // All Claude models accept temperature; only sent when the user set one.
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
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
    detail = json.error?.message ?? (typeof json.error === "string" ? json.error : JSON.stringify(json));
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
