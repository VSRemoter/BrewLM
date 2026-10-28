import { platform } from "../platform";
import { budgetForContext, loadLocalServer, localHeaders } from "./local";
import { modelLimits, STANDARD_EFFORTS, type ModelLimits } from "./modelLimits";
import type { Provider, Thinking } from "./types";

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
  /** Hard cap for deliberately short replies. Omit it: replies are sized to the model. */
  maxTokens?: number;
  jsonMode?: boolean;
  /** Sampling temperature (0–1). Undefined = provider default: never sent. */
  temperature?: number;
  /** Settings → Thinking effort. "auto" or undefined = the model's default: never sent. */
  thinking?: Thinking;
  /** Settings → Max output, in tokens. null or undefined = automatic. */
  maxOutput?: number | null;
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

/** Whether a model takes a Thinking effort level; null when its limits can't be looked up. */
export async function takesThinking(provider: Provider, apiKey: string, model: string): Promise<boolean | null> {
  if (provider === "local") return false;
  if (provider === "openai") return isReasoningModel(model);
  const limits = await modelLimits(provider, apiKey, model);
  return limits ? limits.efforts.length > 0 : null;
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
 * Output ceiling when Max output is automatic, lowered to what the model
 * allows. Reasoning models spend part of it thinking, so it's generous. It's a
 * cap, not a cost: only the tokens actually written are billed.
 */
export const AUTO_OUTPUT_TOKENS = 32_000;
/** Anthropic needs a cap even when the model's limits can't be looked up; every current Claude model allows this. */
const FALLBACK_ANTHROPIC_OUTPUT = 8192;
/** Below this, a reply is too short to be worth retrying for. */
const MIN_USEFUL_OUTPUT = 1024;

/** Rough prompt size in tokens (~3.5 characters each). */
function promptTokens(messages: LlmMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5);
}

/**
 * Tokens the model may write: `want` (Max output or the automatic ceiling),
 * never above a short-reply cap, the model's own limit, or the room left
 * beside the prompt in its context window. undefined = send no cap at all.
 */
function outputCap(want: number | undefined, opts: StreamOptions, ceiling?: number, context?: number): number | undefined {
  const room = context ? context - promptTokens(opts.messages) - 256 : undefined;
  const caps = [want, opts.maxTokens, ceiling, room].filter((n): n is number => typeof n === "number");
  return caps.length ? Math.max(256, Math.floor(Math.min(...caps))) : undefined;
}

/** The effort level to send, or undefined when Thinking is Auto or the model takes none. */
function effortFor(opts: StreamOptions, limits: ModelLimits | null, level = opts.thinking): string | undefined {
  if (!level || level === "auto") return undefined;
  // Unknown limits: OpenRouter drops parameters a model doesn't take; OpenAI only takes effort on reasoning models.
  const accepted =
    limits?.efforts ??
    (opts.provider === "openrouter" || (opts.provider === "openai" && isReasoningModel(opts.model)) ? STANDARD_EFFORTS : []);
  return accepted.includes(level) ? level : undefined;
}

/**
 * An output limit a provider's error says the request went over, so it can be
 * retried under it: low OpenRouter credit, OpenAI's and Anthropic's per-model
 * caps, or a prompt plus cap that overflows the context window.
 */
function allowedOutput(message: string): number | undefined {
  const m =
    /can only afford (\d+)/i.exec(message) ??
    /supports at most (\d+) completion tokens/i.exec(message) ??
    /> (\d+), which is the maximum allowed/i.exec(message);
  if (m) return Number(m[1]);
  const ctx = /maximum context length is (\d+) tokens.*?\((\d+) in the messages/is.exec(message);
  if (ctx) return Number(ctx[1]) - Number(ctx[2]);
  return undefined;
}

function ranOutThinking(model: string, room: number | undefined): Error {
  const allowance = room ? `${room.toLocaleString()}-token output allowance` : "output allowance";
  return new Error(
    `“${model}” spent its whole ${allowance} thinking and never wrote an answer. ` +
      "Try again, set Thinking effort to Low in Settings → AI Model, or use a model that thinks less (or not at all) for this."
  );
}

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
  const limits = local ? null : await modelLimits(opts.provider, opts.apiKey, opts.model);
  // Local windows are small: the budget keeps room for the answer. OpenAI
  // publishes no limits, so automatic sends no cap and it allows the model's maximum.
  const maxTokens = local
    ? outputCap(opts.maxOutput ?? budgetForContext(local.context).maxOutput, opts, undefined, local.context)
    : outputCap(opts.maxOutput ?? (opts.provider === "openai" ? undefined : AUTO_OUTPUT_TOKENS), opts, limits?.maxOutput, limits?.context);
  // o1/o3/gpt-5-class models reject `max_tokens` outright — the request fails.
  const capField = isReasoningModel(opts.model) ? "max_completion_tokens" : "max_tokens";
  if (maxTokens) body[capField] = maxTokens;
  const setEffort = (effort: string) => {
    if (opts.provider === "openrouter") body.reasoning = { effort };
    else body.reasoning_effort = effort;
  };
  const effort = local ? undefined : effortFor(opts, limits);
  if (effort) setEffort(effort);
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
  // once more with more room (within the model's limit) and its thinking turned down.
  let retriedThinking = false;
  let shrinks = 0;
  for (;;) {
    const res = await (local ? platform.fetch : fetch)(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    }).catch((e) => {
      if (local && !isAbortError(e)) throw new Error(`Couldn't reach your local server at ${local.baseUrl}. Is it running?`);
      throw e;
    });
    if (!res.ok) {
      const message = await apiError(res);
      // Asked for more output than the model, the context window or the credit allows: retry under that.
      const allowed = allowedOutput(message);
      const current = body[capField] as number | undefined;
      if (shrinks < 2 && allowed !== undefined && allowed >= MIN_USEFUL_OUTPUT && (current === undefined || allowed < current)) {
        body[capField] = allowed;
        shrinks++;
        continue;
      }
      throw new Error(message);
    }
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

    const ranOut = finishReason === "length" && !wroteText && images.length === 0;
    if (!ranOut) return;
    const room = body[capField] as number | undefined;
    if (!retriedThinking && !local) {
      retriedThinking = true;
      const more = room && outputCap(room * 2, { ...opts, maxTokens: undefined }, limits?.maxOutput, limits?.context);
      if (more) body[capField] = more;
      const low = effortFor(opts, limits, "low");
      if (low) setEffort(low);
      // Retry only if it changes something.
      if (more !== room || (low && low !== effort)) continue;
    }
    throw ranOutThinking(opts.model, room);
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

  const limits = await modelLimits("anthropic", opts.apiKey, opts.model);
  const effort = effortFor(opts, limits);
  const body: Record<string, unknown> = {
    model: opts.model,
    // Anthropic requires a cap: the model's own limit, or one every Claude model allows.
    max_tokens: outputCap(
      opts.maxOutput ?? AUTO_OUTPUT_TOKENS,
      opts,
      limits?.maxOutput ?? FALLBACK_ANTHROPIC_OUTPUT,
      limits?.context
    ),
    stream: true,
    // All Claude models accept temperature; only sent when the user set one.
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    // One ephemeral cache breakpoint at the end of the (large, stable)
    // system prompt: repeat turns re-read the sources at ~10% input cost.
    system: systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : undefined,
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
  };

  // Same recovery as the OpenAI-compatible path: shrink to a cap the API names,
  // or retry once with thinking turned down when it ran out before writing.
  let retriedThinking = false;
  let shrinks = 0;
  for (;;) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const message = await apiError(res);
      const allowed = allowedOutput(message);
      if (shrinks < 2 && allowed !== undefined && allowed >= MIN_USEFUL_OUTPUT && allowed < (body.max_tokens as number)) {
        body.max_tokens = allowed;
        shrinks++;
        continue;
      }
      throw new Error(message);
    }
    if (!res.body) throw new Error("Empty response body");

    const { wroteText, stopReason } = yield* readAnthropicStream(res.body, opts);
    if (stopReason !== "max_tokens" || wroteText) return;
    const low = effortFor(opts, limits, "low");
    if (!retriedThinking && low && low !== effort) {
      retriedThinking = true;
      body.output_config = { effort: low };
      continue;
    }
    throw ranOutThinking(opts.model, body.max_tokens as number);
  }
}

/** Yield one Anthropic stream's text; report whether any was written and why it stopped. */
async function* readAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  opts: StreamOptions
): AsyncGenerator<string, { wroteText: boolean; stopReason?: string }> {
  const usage: StreamUsage = {};
  let wroteText = false;
  let stopReason: string | undefined;
  for await (const payload of sseLines(stream)) {
    try {
      const json = JSON.parse(payload);
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        if (json.delta.text) wroteText = true;
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
        if (typeof json.delta?.stop_reason === "string") stopReason = json.delta.stop_reason;
        const u = json.usage;
        if (u) {
          // message_delta carries cumulative output tokens (and possibly cache stats).
          usage.output = u.output_tokens ?? usage.output;
          usage.cachedRead = u.cache_read_input_tokens ?? usage.cachedRead;
          usage.cachedWrite = u.cache_creation_input_tokens ?? usage.cachedWrite;
          usage.input = u.input_tokens ?? usage.input;
        }
      } else if (json.type === "message_stop") {
        break;
      } else if (json.type === "error") {
        throw new Error(json.error?.message ?? "Anthropic stream error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  opts.onUsage?.(usage);
  return { wroteText, stopReason };
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
