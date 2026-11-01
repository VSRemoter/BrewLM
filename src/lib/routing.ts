/**
 * OpenRouter provider routing (Settings → AI Model → Provider routing, /provider).
 *
 * One OpenRouter model is usually served by several providers (DeepInfra,
 * Groq, Google Vertex…) at different prices, speeds and data policies. These
 * settings become the `provider` object OpenRouter reads on chat-completions
 * requests. Two layers:
 *  - global rules safe for any model: a priority sort, privacy filters, blocked providers;
 *  - per-model pins: providers to try first for one model, optionally only those.
 * A pin names providers that serve that model, so it never applies to another one.
 */
import { getSetting } from "./db";

export type RoutingSort = "" | "price" | "throughput" | "latency";

/** Providers to try first for one model. */
export interface ModelPin {
  /** Endpoint slugs (e.g. "deepinfra/turbo", "groq"), tried in this order. */
  order: string[];
  /** true = only these providers: the request fails instead of falling back to others. */
  only: boolean;
}

export interface OpenRouterRouting {
  /** "" = OpenRouter's default load balancing. */
  sort: RoutingSort;
  /** Skip providers that may train on or store prompts (data_collection: "deny"). */
  noTraining: boolean;
  /** Zero-data-retention endpoints only. */
  zdr: boolean;
  /** Provider slugs never to use, for any model. */
  ignore: string[];
  /** Model id (see pinKey) → its pinned providers. */
  pins: Record<string, ModelPin>;
}

export const DEFAULT_ROUTING: OpenRouterRouting = { sort: "", noTraining: false, zdr: false, ignore: [], pins: {} };

export const SORT_LABELS: Record<RoutingSort, string> = {
  "": "Balanced",
  price: "Cheapest",
  throughput: "Fastest",
  latency: "Quickest start",
};

const SORTS = Object.keys(SORT_LABELS) as RoutingSort[];

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))] : [];

/** Stored JSON → routing; anything missing or corrupt falls back to the default. */
export function parseRouting(raw: string): OpenRouterRouting {
  let parsed: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object") parsed = v;
  } catch {
    /* corrupt value → defaults */
  }
  const pins: Record<string, ModelPin> = {};
  if (parsed.pins && typeof parsed.pins === "object") {
    for (const [model, pin] of Object.entries(parsed.pins as Record<string, unknown>)) {
      const order = strings((pin as ModelPin | null)?.order);
      if (order.length) pins[model] = { order, only: (pin as ModelPin).only === true };
    }
  }
  return {
    sort: SORTS.includes(parsed.sort as RoutingSort) ? (parsed.sort as RoutingSort) : "",
    noTraining: parsed.noTraining === true,
    zdr: parsed.zdr === true,
    ignore: strings(parsed.ignore),
    pins,
  };
}

/** Routing → stored JSON; "" when everything is at its default. */
export function serializeRouting(r: OpenRouterRouting): string {
  return isDefaultRouting(r) ? "" : JSON.stringify(r);
}

export function isDefaultRouting(r: OpenRouterRouting): boolean {
  return !r.sort && !r.noTraining && !r.zdr && r.ignore.length === 0 && Object.keys(r.pins).length === 0;
}

/**
 * The model a pin belongs to. `:nitro`, `:floor` and `:online` are routing
 * variants of the same model (same providers), so they share its pin; `:free`
 * is a separate model with its own providers.
 */
export function pinKey(model: string): string {
  return model.trim().replace(/:(nitro|floor|online)$/i, "");
}

export function pinFor(r: OpenRouterRouting, model: string): ModelPin | undefined {
  return r.pins[pinKey(model)];
}

/** The routing with `model`'s pin replaced (or removed when `pin` is null or empty). */
export function withPin(r: OpenRouterRouting, model: string, pin: ModelPin | null): OpenRouterRouting {
  const pins = { ...r.pins };
  if (pin && pin.order.length) pins[pinKey(model)] = pin;
  else delete pins[pinKey(model)];
  return { ...r, pins };
}

/**
 * The `provider` object for one request, or undefined when nothing is set.
 * A pin is the user's explicit choice for this model, so it overrides the
 * global sort, and a pinned provider is never also blocked.
 */
export function providerPrefs(r: OpenRouterRouting, model: string): Record<string, unknown> | undefined {
  const prefs: Record<string, unknown> = {};
  const pin = pinFor(r, model);
  if (pin) {
    prefs.order = pin.order;
    if (pin.only) prefs.allow_fallbacks = false;
  } else if (r.sort) {
    prefs.sort = r.sort;
  }
  if (r.noTraining) prefs.data_collection = "deny";
  if (r.zdr) prefs.zdr = true;
  const pinned = new Set((pin?.order ?? []).map(baseSlug));
  const ignore = r.ignore.filter((s) => !pinned.has(baseSlug(s)));
  if (ignore.length) prefs.ignore = ignore;
  return Object.keys(prefs).length ? prefs : undefined;
}

/** "deepinfra/turbo" → "deepinfra". */
export function baseSlug(slug: string): string {
  return slug.split("/")[0];
}

export async function loadRouting(): Promise<OpenRouterRouting> {
  return parseRouting(await getSetting("openrouterRouting"));
}

/** The `provider` object to send with an OpenRouter chat request for `model`, from saved settings. */
export async function openRouterPrefs(model: string): Promise<Record<string, unknown> | undefined> {
  return providerPrefs(await loadRouting(), model);
}

/** The rules that can leave a model with no provider at all, in words. */
export function restrictions(r: OpenRouterRouting, model: string): string[] {
  const out: string[] = [];
  const pin = pinFor(r, model);
  if (pin?.only) out.push(`only ${pin.order.join(", ")}`);
  if (r.noTraining) out.push("no providers that train on your data");
  if (r.zdr) out.push("zero data retention only");
  const blocked = providerPrefs(r, model)?.ignore as string[] | undefined;
  if (blocked?.length) out.push(`blocked: ${blocked.join(", ")}`);
  return out;
}

/**
 * When OpenRouter found no provider for a request and the user's routing rules
 * could be why, a message saying so and how to loosen them; otherwise null.
 */
export async function routingError(detail: string, model: string): Promise<string | null> {
  if (!/no (allowed )?(endpoints|providers)|no endpoints found|data policy/i.test(detail)) return null;
  const why = restrictions(await loadRouting(), model);
  if (why.length === 0) return null;
  return (
    `No provider can run “${model}” under your provider routing (${why.join("; ")}). ` +
    "Loosen it in Settings → AI Model → Provider routing, or type `/provider off` to clear it."
  );
}

/* ----------------------- Who served it (shown by /provider) ----------------------- */

const servedBy = new Map<string, string>();

/** Remember which provider OpenRouter used for a model (from the response's `provider` field). */
export function noteServedBy(model: string, provider: unknown): void {
  if (typeof provider === "string" && provider) servedBy.set(pinKey(model), provider);
}

export function lastServedBy(model: string): string | undefined {
  return servedBy.get(pinKey(model));
}

/* ------------------------- OpenRouter's public provider data ------------------------- */

/** One provider serving a model, from GET /models/{id}/endpoints. */
export interface ModelEndpoint {
  /** What `order` takes, e.g. "deepinfra/turbo". */
  slug: string;
  name: string;
  quantization: string;
  /** USD per million tokens. */
  promptPrice: number;
  completionPrice: number;
  context: number;
  /** Below 0 = degraded or down right now. */
  status: number;
}

const endpointCache = new Map<string, Promise<ModelEndpoint[] | null>>();

/** Who serves `model` on OpenRouter right now (public endpoint, cached per session). Null when unreachable or unknown. */
export function loadModelEndpoints(model: string): Promise<ModelEndpoint[] | null> {
  const id = pinKey(model);
  let hit = endpointCache.get(id);
  if (!hit) {
    hit = fetch(`https://openrouter.ai/api/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const list = json?.data?.endpoints;
        if (!Array.isArray(list)) return null;
        return list
          .filter((e) => typeof e?.tag === "string")
          .map((e): ModelEndpoint => ({
            slug: e.tag,
            name: typeof e.provider_name === "string" ? e.provider_name : e.tag,
            quantization: typeof e.quantization === "string" && e.quantization !== "unknown" ? e.quantization : "",
            promptPrice: Number(e.pricing?.prompt) * 1e6 || 0,
            completionPrice: Number(e.pricing?.completion) * 1e6 || 0,
            context: Number(e.context_length) || 0,
            status: typeof e.status === "number" ? e.status : 0,
          }));
      })
      .catch(() => null)
      .then((list) => {
        if (!list) endpointCache.delete(id); // retry next time
        return list;
      });
    endpointCache.set(id, hit);
  }
  return hit;
}

export interface ProviderInfo {
  slug: string;
  name: string;
}

let providerList: Promise<ProviderInfo[]> | null = null;

/** Every provider on OpenRouter, for the block list (public endpoint, cached per session). */
export function loadProviders(): Promise<ProviderInfo[]> {
  return (providerList ??= fetch("https://openrouter.ai/api/v1/providers")
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      const list: ProviderInfo[] = (Array.isArray(json?.data) ? json.data : [])
        .filter((p: { slug?: unknown }) => typeof p?.slug === "string")
        .map((p: { slug: string; name?: unknown }) => ({ slug: p.slug, name: typeof p.name === "string" ? p.name : p.slug }));
      if (list.length === 0) providerList = null;
      return list.sort((a, b) => a.name.localeCompare(b.name));
    })
    .catch(() => {
      providerList = null;
      return [];
    }));
}

/** Match what someone typed ("Groq", "deep infra", "deepinfra/turbo") to a provider slug. */
export function findProvider(list: ProviderInfo[], query: string): ProviderInfo | undefined {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = squash(baseSlug(query.trim()));
  if (!q) return undefined;
  return (
    list.find((p) => squash(p.slug) === q) ??
    list.find((p) => squash(p.name) === q) ??
    list.find((p) => squash(p.name).startsWith(q) || squash(p.slug).startsWith(q))
  );
}

/**
 * The slug to pin for what someone typed, among the providers serving a model:
 * an exact endpoint slug ("deepinfra/turbo") stays as typed; a provider name or
 * base slug ("Google", "deepinfra") pins the provider's base slug, which covers
 * all its variants and regions.
 */
export function matchEndpoint(endpoints: ModelEndpoint[], query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = endpoints.find((e) => e.slug.toLowerCase() === q);
  if (exact) return exact.slug;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sq = squash(q);
  const hit =
    endpoints.find((e) => squash(baseSlug(e.slug)) === sq || squash(e.name) === sq) ??
    endpoints.find((e) => squash(e.name).startsWith(sq) || squash(e.slug).startsWith(sq));
  return hit && baseSlug(hit.slug);
}
