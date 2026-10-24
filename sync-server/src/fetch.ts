/**
 * POST /v1/fetch — reads a web page for the web app (BrewLM on a phone).
 * Browsers refuse to read most sites from another site's page (CORS), so a
 * link or YouTube video added on the phone is fetched here instead. The
 * desktop app fetches directly and never calls this.
 *
 *   { url, method?: "GET" | "POST", headers?: {...}, body?: string }
 *   → the page as fetched: its status, content type and bytes, with the
 *     address it ended at (after redirects) in `x-final-url`.
 *   Errors of this server's own are JSON and carry `x-brewlm-fetch: error`.
 *
 * Guards: an account with an active trial or plan; public http(s) addresses
 * only (no IP addresses, local names, other ports, credentials, or this
 * server), re-checked on every redirect; a few safe request headers; 20 s,
 * 25 MB and 120 fetches an hour per account.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
export const MAX_FETCHES_PER_HOUR = 120;
/** Request headers passed through; everything else (cookies, auth…) is dropped. */
const PASS_HEADERS = ["user-agent", "accept", "accept-language", "content-type"];
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/** An error of this server's own (not the site's), marked so the app can tell. */
export const fetchFail = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-brewlm-fetch": "error" },
  });

/** Why this address may not be fetched, or null if it may. */
export function refuseUrl(raw: string, ownHost: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid address";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "only http and https addresses";
  if (url.username || url.password) return "addresses with a user name or password aren't allowed";
  if (url.port) return "only the standard ports";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(":") || /^\[/.test(host)) return "IP addresses aren't allowed";
  if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))
    return "local network addresses aren't allowed";
  if (host === ownHost) return "can't fetch this server";
  return null;
}

/** Stops after MAX_BYTES, failing the stream (the page is cut off rather than half-read). */
function capped(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES) ctl.error(new Error("page larger than 25 MB"));
        else ctl.enqueue(chunk);
      },
    })
  );
}

export async function pageFetch(req: Request, env: Env, userId: string): Promise<Response> {
  const body = await req
    .json<{ url?: unknown; method?: unknown; headers?: unknown; body?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const method = body.method === undefined ? "GET" : String(body.method).toUpperCase();
  if (typeof body.url !== "string") return fetchFail(400, "bad url");
  if (method !== "GET" && method !== "POST") return fetchFail(400, "only GET and POST");
  if (body.body !== undefined && (typeof body.body !== "string" || method !== "POST" || body.body.length > 1_000_000))
    return fetchFail(400, "bad body");
  const ownHost = new URL(env.PUBLIC_URL).hostname;
  const refused = refuseUrl(body.url, ownHost);
  if (refused) return fetchFail(400, `Can't fetch that address: ${refused}.`);

  const now = Date.now();
  const recent = await env.DB.prepare("SELECT count(*) AS n FROM page_fetches WHERE user_id = ? AND created_at > ?")
    .bind(userId, now - 60 * 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FETCHES_PER_HOUR) return fetchFail(429, "Too many pages fetched this hour. Try again later.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO page_fetches (user_id, created_at) VALUES (?, ?)").bind(userId, now),
    env.DB.prepare("DELETE FROM page_fetches WHERE created_at < ?").bind(now - 24 * 60 * 60 * 1000),
  ]);

  const headers = new Headers();
  if (body.headers && typeof body.headers === "object")
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>))
      if (PASS_HEADERS.includes(k.toLowerCase()) && typeof v === "string") headers.set(k, v);

  let url = body.url;
  let res: Response;
  let currentMethod = method;
  let currentBody = body.body as string | undefined;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetch(url, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return fetchFail(502, timedOut ? "The site took too long to answer." : "Couldn't reach that site.");
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    if (hop >= MAX_REDIRECTS) return fetchFail(502, "Too many redirects.");
    const next = new URL(location, url).toString();
    const why = refuseUrl(next, ownHost);
    if (why) return fetchFail(400, `That page redirects somewhere BrewLM can't fetch: ${why}.`);
    url = next;
    // As browsers do: a POST answered with 301/302/303 is followed with a GET.
    if (res.status !== 307 && res.status !== 308) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }

  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return fetchFail(413, "That page is larger than 25 MB.");
  // Some sites answer with codes outside HTTP's range, which a Response can't carry.
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
  return new Response(res.body ? capped(res.body) : null, {
    status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "x-final-url": url,
      "cache-control": "no-store",
    },
  });
}
