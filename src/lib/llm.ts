import { platform } from "../platform";
import { budgetForContext, loadLocalServer, localHeaders } from "./local";
import { modelLimits, STANDARD_EFFORTS, type ModelLimits } from "./modelLimits";
import { noteServedBy, openRouterPrefs, routingError } from "./routing";
import { openRouterApi, speaksOpenRouter } from "./brewlmAi";
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
  /** The provider OpenRouter routed the request to (e.g. "DeepInfra"). */
  servedBy?: string;
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
  /**
   * Called as the model's reasoning streams in, with all of it so far ("" =
   * start over, after a retry). Reasoning is never part of the yielded text.
   */
  onReasoning?: (reasoning: string) => void;
  /**
   * Groups requests that share a prompt prefix (the notebook id), so providers
   * that route between servers send them to the same one and its cache:
   * OpenRouter's `session_id`, OpenAI's `prompt_cache_key`.
   */
  cacheKey?: string;
  /**
   * Multi-turn chat: also cache the conversation up to the newest message, so
   * the next turn re-reads the whole history from cache, not just the system
   * prompt. Off for one-off requests (Studio), where it would only add the
   * cache-write surcharge on text that is never read again.
   */
  cacheHistory?: boolean;
}

/**
 * Prompt caching follows the message layout callers send. Leading system
 * messages are the prompt's prefix, in order: the FIRST is the stable part
 * (rules, sources) and gets the cache breakpoint; any later ones hold what
 * changes between messages (@-mentions), after the breakpoint so they never
 * invalidate it. Providers without explicit caching see them joined into one
 * system message, byte-identical to sending a single one.
 */
function leadingSystem(messages: LlmMessage[]): { system: string[]; rest: LlmMessage[] } {
  let i = 0;
  while (i < messages.length && messages[i].role === "system") i++;
  return {
    system: messages.slice(0, i).map((m) => m.content).filter((t) => t.length > 0),
    rest: messages.slice(i),
  };
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** Text blocks for a system prompt, the breakpoint on the stable first one. */
function cachedSystemBlocks(system: string[]) {
  return system.map((text, i) => (i === 0 ? { type: "text", text, cache_control: EPHEMERAL } : { type: "text", text }));
}

/** The conversation, with a breakpoint on the newest message when `cacheHistory` asks for one. */
function cachedTurns(rest: LlmMessage[], cacheHistory: boolean | undefined) {
  return rest.map((m, i) =>
    cacheHistory && i === rest.length - 1 && m.content
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] }
      : { role: m.role, content: m.content }
  );
}

/**
 * Reasoning-model families (o1/o3/o4, gpt-5) reject sampling params and
 * `max_tokens` — the settings UI uses supportsTemperature() to hint, and
 * request builders use isReasoningModel() to send max_completion_tokens.
 */
function isReasoningModel(model: string): boolean {
  return /^(openai\/)?(o1|o3|o4|gpt-5)/i.test(model.trim());
}

/** A Claude model, on Anthropic ("claude-…") or OpenRouter ("anthropic/claude-…"). */
function isClaude(model: string): boolean {
  return /^(anthropic\/)?claude-/i.test(model.trim());
}

/**
 * Claude models that take a custom temperature: Claude 2 and 3, and Claude 4
 * up to 4.6. Later ones reject it (or take only the default), so any model
 * not listed, including ones released later, is sent none.
 */
function claudeTakesTemperature(model: string): boolean {
  const id = model.trim().replace(/^anthropic\//i, "");
  return /^claude-(?:(?:2|3|instant)[-.]|(?:opus|sonnet|haiku)-4(?:[-.][0-6])?(?:-\d{8})?(?:$|[@:[]))/i.test(id);
}

/** Reasoning-model families and newer Claude models reject sampling params like temperature. */
export function supportsTemperature(model: string): boolean {
  return !isReasoningModel(model) && (!isClaude(model) || claudeTakesTemperature(model));
}

/**
 * The temperature to send, or undefined to leave the model's default. A Claude
 * model that's thinking takes none either.
 */
function temperatureFor(opts: StreamOptions, limits: ModelLimits | null, effort: string | undefined): number | undefined {
  if (opts.temperature == null || !supportsTemperature(opts.model) || limits?.temperature === false) return undefined;
  if (effort && isClaude(opts.model)) return undefined;
  return opts.temperature;
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
  if (opts.provider !== "local" && !opts.model.trim())
    throw new Error("Pick a model in Settings → AI Model, or type one with /model.");
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
    (speaksOpenRouter(opts.provider) || (opts.provider === "openai" && isReasoningModel(opts.model)) ? STANDARD_EFFORTS : []);
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

/** Longest tail of `text` that could be the start of `tag` (a tag cut at a chunk edge). */
function partialTagLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let k = Math.min(tag.length - 1, lower.length); k > 0; k--) {
    if (lower.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Splits a streamed answer into reasoning and the answer proper, for models
 * that write their reasoning inline as <think>…</think> (Qwen3, DeepSeek-R1
 * and others, when the server doesn't separate it). Only a tag at the very
 * start counts, so a reply that talks about the tag isn't swallowed. A tag cut
 * at a chunk edge is held back until the next chunk shows what it is.
 */
export class ThinkSplitter {
  private state: "start" | "inside" | "text" = "start";
  private pending = "";
  private close = "";
  /** Just left a think block: drop the blank lines before the answer. */
  private trimLead = false;

  push(chunk: string): { text: string; reasoning: string } {
    this.pending += chunk;
    let reasoning = "";
    for (;;) {
      if (this.state === "start") {
        const lead = this.pending.trimStart().toLowerCase();
        if (!lead) return { text: "", reasoning };
        const open = /^<(think|thinking)>/.exec(lead);
        if (open) {
          this.state = "inside";
          this.close = `</${open[1]}>`;
          this.pending = this.pending.trimStart().slice(open[0].length);
          continue;
        }
        if ("<thinking>".startsWith(lead)) return { text: "", reasoning };
        this.state = "text";
        continue;
      }
      if (this.state === "inside") {
        const end = this.pending.toLowerCase().indexOf(this.close);
        if (end >= 0) {
          reasoning += this.pending.slice(0, end);
          this.pending = this.pending.slice(end + this.close.length);
          this.state = "text";
          this.trimLead = true;
          continue;
        }
        const keep = partialTagLength(this.pending, this.close);
        reasoning += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        return { text: "", reasoning };
      }
      if (this.trimLead) {
        this.pending = this.pending.trimStart();
        if (!this.pending) return { text: "", reasoning };
        this.trimLead = false;
      }
      const text = this.pending;
      this.pending = "";
      return { text, reasoning };
    }
  }

  /** Whatever was held back, once the stream has ended. */
  flush(): { text: string; reasoning: string } {
    const rest = this.pending;
    this.pending = "";
    return this.state === "inside" ? { text: "", reasoning: rest } : { text: this.trimLead ? rest.trimStart() : rest, reasoning: "" };
  }
}

/**
 * Reasoning in one OpenAI-style delta or message: `reasoning_content`
 * (llama.cpp, LM Studio, DeepSeek), `reasoning` (Ollama, OpenRouter), or
 * OpenRouter's `reasoning_details` when that's all a chunk carries.
 */
function reasoningOf(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.reasoning_content === "string") return p.reasoning_content;
  if (typeof p.reasoning === "string") return p.reasoning;
  if (!Array.isArray(p.reasoning_details)) return "";
  return p.reasoning_details
    .map((d) => (d?.type === "reasoning.text" ? d.text : d?.type === "reasoning.summary" ? d.summary : ""))
    .filter((s): s is string => typeof s === "string")
    .join("");
}

/**
 * The `thinking` field of an Anthropic request. Claude 4.6 to 4.8 only think
 * when asked (an effort level is set); later models think by default, so
 * asking changes nothing but `display`: from 4.7 on, thinking text comes back
 * empty unless a summary is asked for. The raw chain of thought is never sent.
 */
function claudeThinking(model: string, limits: ModelLimits | null, effort: string | undefined): Record<string, unknown> {
  if (!limits?.adaptiveThinking) return {};
  const claude4 = /claude-(?:opus|sonnet|haiku)-4[-.](\d+)/i.exec(model);
  if (claude4 && !effort) return {};
  const summarized = !claude4 || Number(claude4[1]) >= 7;
  return { thinking: summarized ? { type: "adaptive", display: "summarized" } : { type: "adaptive" } };
}

/** Non-streaming helper — returns the full completion text. */
export async function complete(opts: StreamOptions): Promise<string> {
  let out = "";
  for await (const delta of streamChat(opts)) out += delta;
  return out;
}

/** Anthropic-family models routed via OpenRouter (or BrewLM AI) take explicit cache breakpoints. */
function openRouterClaude(opts: Pick<StreamOptions, "provider" | "model">): boolean {
  return speaksOpenRouter(opts.provider) && /anthropic|claude/i.test(opts.model);
}

/** Endpoint, headers and body of an OpenAI-compatible chat request (streamed). */
async function openAICompatibleRequest(opts: StreamOptions) {
  const local = opts.provider === "local" ? await loadLocalServer() : null;
  if (local && !local.baseUrl) throw new Error("Set your local server address in Settings → AI Model.");
  if (local && !opts.model.trim()) throw new Error("Pick a local model in Settings → AI Model.");
  const or = speaksOpenRouter(opts.provider) ? openRouterApi(opts.provider, opts.apiKey) : null;
  const base = local
    ? `${local.baseUrl}/chat/completions`
    : or
      ? `${or.base}/chat/completions`
      : "https://api.openai.com/v1/chat/completions";

  const headers: Record<string, string> = local
    ? localHeaders(local.key)
    : { "Content-Type": "application/json", Authorization: `Bearer ${or?.key ?? opts.apiKey}`, ...or?.headers };

  // Anthropic-family models routed via OpenRouter support explicit prompt
  // caching: a breakpoint after the stable system prefix (so repeat turns and
  // new chats in a notebook re-read the sources at ~10% cost), and in chats one
  // on the newest message (so the next turn re-reads the history too). Other
  // providers cache prefixes on their own; they get one plain system message.
  const { system, rest } = leadingSystem(opts.messages);
  const messages = openRouterClaude(opts)
    ? [
        ...(system.length ? [{ role: "system", content: cachedSystemBlocks(system) }] : []),
        ...cachedTurns(rest, opts.cacheHistory),
      ]
    : [...(system.length ? [{ role: "system", content: system.join("\n\n") }] : []), ...rest];

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Same key → same server → its cache. OpenRouter pins the provider from the
  // very first request (otherwise only after a cache hit, so turn 2 could land
  // on a provider whose cache is empty).
  if (opts.cacheKey && or) body.session_id = opts.cacheKey;
  if (opts.cacheKey && opts.provider === "openai") body.prompt_cache_key = opts.cacheKey;
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
    if (or) body.reasoning = { effort };
    else body.reasoning_effort = effort;
  };
  const effort = local ? undefined : effortFor(opts, limits);
  if (effort) setEffort(effort);
  if (opts.jsonMode && opts.provider === "openai") {
    body.response_format = { type: "json_object" };
  }
  // Ask for token usage in the final stream chunk (cost visibility).
  if (opts.provider === "openai") body.stream_options = { include_usage: true };
  if (or) body.usage = { include: true };
  if (opts.provider === "openrouter") {
    // Settings → AI Model → Provider routing: who may serve this model, in what order.
    const prefs = await openRouterPrefs(opts.model);
    if (prefs) body.provider = prefs;
  }
  // Image-generation models (e.g. gemini-*-image) need both modalities requested.
  if (or && /image/i.test(opts.model)) {
    body.modalities = ["image", "text"];
  }
  const temperature = temperatureFor(opts, limits, effort);
  if (temperature != null) body.temperature = temperature;
  return { local, base, headers, body, capField, limits, effort, setEffort };
}

/**
 * Write the stable system prefix into the prompt cache before the real
 * request, while the user is still typing, so the first message of a chat
 * starts answering at once instead of first reading every source. It sends
 * exactly what the real request will (system prompt, thinking and effort
 * settings, so the entry matches) with a placeholder for the conversation, and
 * asks for no answer. Explicit caches only: Claude on Anthropic or OpenRouter.
 * Elsewhere it does nothing, since those providers cache prefixes from real
 * requests on their own. Returns the billed usage, or null when nothing was
 * sent or it failed; it never throws.
 */
export async function prewarmCache(opts: StreamOptions): Promise<StreamUsage | null> {
  const system = opts.messages.filter((m) => m.role === "system" && m.content);
  if (system.length === 0) return null;
  const warm: StreamOptions = {
    ...opts,
    messages: [...system, { role: "user", content: "warmup" }],
    cacheHistory: false,
  };
  try {
    if (opts.provider === "anthropic" && opts.model.trim()) {
      const { body } = await anthropicRequest(warm);
      // max_tokens 0: prefill only (the cache write), no reply and no output billed.
      body.max_tokens = 0;
      body.stream = false;
      const res = await fetch(ANTHROPIC_MESSAGES, {
        method: "POST",
        headers: anthropicHeaders(opts.apiKey),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!res.ok) return null;
      const u = ((await res.json()) as { usage?: Record<string, number> }).usage ?? {};
      return { input: u.input_tokens, output: u.output_tokens ?? 0, cachedRead: u.cache_read_input_tokens, cachedWrite: u.cache_creation_input_tokens };
    }
    if (openRouterClaude(opts)) {
      const { base, headers, body, capField } = await openAICompatibleRequest(warm);
      // OpenRouter wants at least one output token; one is all it may write.
      body[capField] = 1;
      body.stream = false;
      delete body.stream_options;
      const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
      if (!res.ok) return null;
      const u = ((await res.json()) as { usage?: Record<string, any> }).usage ?? {};
      return {
        input: u.prompt_tokens,
        output: u.completion_tokens,
        cachedRead: u.prompt_tokens_details?.cached_tokens,
        cachedWrite: u.prompt_tokens_details?.cache_write_tokens,
        costUsd: typeof u.cost === "number" ? u.cost : undefined,
      };
    }
  } catch {
    /* warming is best-effort: the real request simply reads cold */
  }
  return null;
}

/** Whether prewarmCache can do anything for this provider and model. */
export function canPrewarm(provider: Provider, model: string): boolean {
  return (provider === "anthropic" && !!model.trim()) || openRouterClaude({ provider, model });
}

async function* streamOpenAICompatible(opts: StreamOptions): AsyncGenerator<string> {
  const { local, base, headers, body, capField, limits, effort, setEffort } = await openAICompatibleRequest(opts);

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
      throw new Error((opts.provider === "openrouter" && (await routingError(message, opts.model))) || message);
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
    let servedBy: string | undefined;
    let wroteText = false;
    let finishReason: string | undefined;
    // Reasoning arrives in its own field, or inline as <think>…</think>.
    if (retriedThinking) opts.onReasoning?.("");
    let reasoning = "";
    const addReasoning = (r: string) => {
      if (!r) return;
      reasoning += r;
      opts.onReasoning?.(reasoning);
    };
    const split = new ThinkSplitter();

    for await (const payload of sseLines(res.body)) {
      if (payload === "[DONE]") break;
      try {
        const json = JSON.parse(payload);
        if (speaksOpenRouter(opts.provider) && typeof json.provider === "string") servedBy = json.provider;
        const choice = json.choices?.[0];
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        addReasoning(reasoningOf(choice?.delta ?? choice?.message));
        const delta = choice?.delta?.content ?? choice?.message?.content;
        // some providers stream content as typed parts
        const texts = typeof delta === "string" ? [delta] : [];
        if (Array.isArray(delta)) {
          for (const part of delta) {
            if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
            else pushImage(imagePartUrl(part));
          }
        }
        for (const t of texts) {
          const out = split.push(t);
          addReasoning(out.reasoning);
          if (out.text) {
            wroteText = true;
            yield out.text;
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
            cachedWrite: u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? usage.cachedWrite,
            // OpenRouter reports the real billed amount when usage:include is set.
            costUsd: typeof u.cost === "number" ? u.cost : usage.costUsd,
          };
        }
      } catch {
        // partial JSON chunk — ignore
      }
    }
    const tail = split.flush();
    addReasoning(tail.reasoning);
    if (tail.text) {
      wroteText = true;
      yield tail.text;
    }
    if (servedBy) noteServedBy(opts.model, servedBy);
    if (usage.input !== undefined || usage.output !== undefined) opts.onUsage?.({ ...usage, servedBy });
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

const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Body of an Anthropic Messages request (streamed). */
async function anthropicRequest(opts: StreamOptions) {
  const system = opts.messages.filter((m) => m.role === "system" && m.content).map((m) => m.content);
  const rest = opts.messages.filter((m) => m.role !== "system");

  const limits = await modelLimits("anthropic", opts.apiKey, opts.model);
  const effort = effortFor(opts, limits);
  const temperature = temperatureFor(opts, limits, effort);
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
    ...(temperature != null ? { temperature } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...claudeThinking(opts.model, limits, effort),
    // A breakpoint at the end of the stable system prefix: repeat turns and new
    // chats re-read the sources at ~10% input cost. In chats a second one on
    // the newest message caches the history for the next turn.
    system: system.length ? cachedSystemBlocks(system) : undefined,
    messages: cachedTurns(rest, opts.cacheHistory),
  };
  return { body, limits, effort };
}

async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<string> {
  const { body, limits, effort } = await anthropicRequest(opts);

  // Same recovery as the OpenAI-compatible path: shrink to a cap the API names,
  // or retry once with thinking turned down when it ran out before writing.
  let retriedThinking = false;
  let shrinks = 0;
  for (;;) {
    const res = await fetch(ANTHROPIC_MESSAGES, {
      method: "POST",
      headers: anthropicHeaders(opts.apiKey),
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

    if (retriedThinking) opts.onReasoning?.("");
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
  let reasoning = "";
  for await (const payload of sseLines(stream)) {
    try {
      const json = JSON.parse(payload);
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        if (json.delta.text) wroteText = true;
        yield json.delta.text as string;
      } else if (json.type === "content_block_delta" && json.delta?.type === "thinking_delta") {
        if (typeof json.delta.thinking === "string" && json.delta.thinking) {
          reasoning += json.delta.thinking;
          opts.onReasoning?.(reasoning);
        }
      } else if (json.type === "content_block_start" && json.content_block?.type === "thinking") {
        // Interleaved thinking: several blocks in one reply, each its own paragraph.
        if (reasoning && !reasoning.endsWith("\n\n")) reasoning += "\n\n";
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

/**
 * Drop inline reasoning from a finished response: a leading <think>…</think>
 * block, or everything up to a stray </think> whose opening tag was part of
 * the prompt template (some DeepSeek-R1 builds).
 */
export function stripThinking(text: string): string {
  return text.replace(/^\s*(?:<(think|thinking)>[\s\S]*?<\/\1>|[\s\S]*?<\/think(?:ing)?>)\s*/i, "");
}

/** Extract the first complete JSON value from a model response. */
export function extractJson(text: string): string {
  text = stripThinking(text);
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
