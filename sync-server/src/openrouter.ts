/**
 * OpenRouter's key-management API (https://openrouter.ai/docs/features/provisioning-api-keys),
 * called with OPENROUTER_MANAGEMENT_KEY. That key can create and delete every
 * key on the account, so it lives only as a Worker secret and is never logged
 * or returned. OPENROUTER_API_URL points tests at a stand-in.
 */

export interface OrKey {
  hash: string;
  /** Total spent on this key, in US dollars. */
  usage: number;
  limit: number | null;
  disabled: boolean;
}

export class OpenRouterError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function openRouterConfigured(env: Env): boolean {
  return !!env.OPENROUTER_MANAGEMENT_KEY && !!env.AI_KEY_SECRET;
}

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.OPENROUTER_MANAGEMENT_KEY) throw new OpenRouterError(503, "OpenRouter isn't configured on this server");
  const res = await fetch(`${env.OPENROUTER_API_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.OPENROUTER_MANAGEMENT_KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new OpenRouterError(res.status, `OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

function toKey(d: Record<string, unknown>): OrKey {
  return {
    hash: String(d.hash),
    usage: Number(d.usage) || 0,
    limit: typeof d.limit === "number" ? d.limit : null,
    disabled: d.disabled === true,
  };
}

/** Dollars rounded to a hundredth of a cent, as limits are sent. */
export const usd = (n: number) => Math.round(Math.max(0, n) * 10_000) / 10_000;

/**
 * A new key with a spending limit (no automatic reset: src/ai.ts sets each
 * month's limit itself) and an expiry as a backstop if a revocation is missed.
 */
export async function createKey(
  env: Env,
  opts: { name: string; limit: number; expiresAt: Date }
): Promise<{ key: string; info: OrKey }> {
  const res = await call<{ data: Record<string, unknown>; key: string }>(env, "POST", "/keys", {
    name: opts.name,
    limit: usd(opts.limit),
    include_byok_in_limit: false,
    expires_at: opts.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (typeof res.key !== "string" || !res.data) throw new OpenRouterError(502, "OpenRouter returned no key");
  return { key: res.key, info: toKey(res.data) };
}

/** The key's usage and limit; null when OpenRouter no longer has it. */
export async function getKey(env: Env, hash: string): Promise<OrKey | null> {
  try {
    return toKey((await call<{ data: Record<string, unknown> }>(env, "GET", `/keys/${encodeURIComponent(hash)}`)).data);
  } catch (e) {
    if (e instanceof OpenRouterError && e.status === 404) return null;
    throw e;
  }
}

export async function updateKey(env: Env, hash: string, patch: { limit?: number; disabled?: boolean }): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.limit !== undefined) body.limit = usd(patch.limit);
  if (patch.disabled !== undefined) body.disabled = patch.disabled;
  await call(env, "PATCH", `/keys/${encodeURIComponent(hash)}`, body);
}

/** Deletes the key; already gone counts as done. */
export async function deleteKey(env: Env, hash: string): Promise<void> {
  try {
    await call(env, "DELETE", `/keys/${encodeURIComponent(hash)}`);
  } catch (e) {
    if (!(e instanceof OpenRouterError && e.status === 404)) throw e;
  }
}

/* --------------------------- the key at rest (D1) -------------------------- */

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The OpenRouter key encrypted for D1: base64(iv ‖ ciphertext). */
export async function sealKey(env: Env, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env.AI_KEY_SECRET ?? ""), new TextEncoder().encode(key))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function openKey(env: Env, sealed: string): Promise<string> {
  const bytes = unb64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await aesKey(env.AI_KEY_SECRET ?? ""),
    bytes.slice(12)
  );
  return new TextDecoder().decode(plain);
}
