import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** A stand-in website for the page fetcher's tests (src/fetch.ts). */
async function fakeSite(req: Request, url: URL): Promise<Response> {
  switch (url.pathname) {
    case "/hello":
      return new Response("<html><title>Hello</title><p>Hi there</p></html>", { headers: { "content-type": "text/html" } });
    case "/moved":
      return new Response(null, { status: 302, headers: { location: "/hello" } });
    case "/to-local":
      return new Response(null, { status: 302, headers: { location: "http://localhost/admin" } });
    case "/loop":
      return new Response(null, { status: 302, headers: { location: "/loop" } });
    case "/huge":
      return new Response("x", { headers: { "content-length": String(30 * 1024 * 1024) } });
    case "/echo":
      return Response.json({
        method: req.method,
        body: req.method === "POST" ? await req.text() : null,
        headers: Object.fromEntries(req.headers),
      });
    case "/teapot":
      return new Response("short and stout", { status: 418 });
    default:
      return new Response("not found", { status: 404 });
  }
}

/**
 * A stand-in for OpenRouter (src/openrouter.ts, the proxy in src/ai.ts): the
 * key-management API, and inference endpoints that answer on a provisioned
 * key. Test-only routes: POST /__usage { hash, usage } sets what a key has
 * spent, GET /__keys lists the keys that exist, GET /__last is the last
 * inference request, POST /__broke { on } makes the whole account run out of credit.
 */
/** Polar calls that change something (plan changes), for tests to inspect via GET https://polar.test/__calls. */
const polarCalls: { path: string; body: unknown }[] = [];

const orKeys = new Map<string, { key: string; name: string; limit: number | null; usage: number; disabled: boolean; expires_at: string }>();
let orLast: { path: string; auth: string | null; referer: string | null; body: unknown } | null = null;
let orBroke = false;
const INFERENCE = ["/chat/completions", "/audio/speech", "/embeddings", "/images"];
async function fakeOpenRouter(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  if (path === "/__last") return Response.json(orLast);
  if (path === "/__broke") {
    orBroke = ((await req.json()) as { on: boolean }).on;
    return Response.json({ ok: true });
  }
  if (INFERENCE.includes(path)) {
    const body = (await req.json()) as { model: string; stream?: boolean };
    orLast = { path, auth: req.headers.get("authorization"), referer: req.headers.get("http-referer"), body };
    const k = [...orKeys.values()].find((x) => `Bearer ${x.key}` === req.headers.get("authorization"));
    if (!k || k.disabled) return Response.json({ error: { message: "User not found.", code: 401 } }, { status: 401 });
    if (orBroke || (k.limit !== null && k.usage >= k.limit))
      return Response.json({ error: { message: "Insufficient credits", code: 402 } }, { status: 402 });
    if (body.stream)
      return new Response(`data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "x-secret-upstream": "1" },
      });
    return Response.json({ model: body.model, data: [{ embedding: [0.1, 0.2] }] });
  }
  if (path === "/__usage") {
    const { hash, usage } = (await req.json()) as { hash: string; usage: number };
    const k = orKeys.get(hash);
    if (k) k.usage = usage;
    return Response.json({ ok: !!k });
  }
  if (path === "/__keys") return Response.json([...orKeys].map(([hash, k]) => ({ hash, ...k })));
  if (req.headers.get("authorization") !== "Bearer or-mgmt-test") return Response.json({ error: "unauthorized" }, { status: 401 });
  const info = (hash: string) => {
    const k = orKeys.get(hash)!;
    return { hash, name: k.name, label: `${k.key.slice(0, 12)}...`, limit: k.limit, usage: k.usage, disabled: k.disabled, limit_reset: null };
  };
  if (path === "/keys" && req.method === "POST") {
    const body = (await req.json()) as { name: string; limit: number; expires_at: string };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(body.expires_at)) return Response.json({ error: "bad expires_at" }, { status: 400 });
    const hash = crypto.randomUUID().replace(/-/g, "");
    const key = `sk-or-v1-${crypto.randomUUID().replace(/-/g, "")}`;
    orKeys.set(hash, { key, name: body.name, limit: body.limit, usage: 0, disabled: false, expires_at: body.expires_at });
    return Response.json({ data: info(hash), key }, { status: 201 });
  }
  const m = /^\/keys\/([0-9a-f]+)$/.exec(path);
  if (!m || !orKeys.has(m[1])) return Response.json({ error: "not found" }, { status: 404 });
  if (req.method === "GET") return Response.json({ data: info(m[1]) });
  if (req.method === "PATCH") {
    Object.assign(orKeys.get(m[1])!, (await req.json()) as object);
    return Response.json({ data: info(m[1]) });
  }
  if (req.method === "DELETE") {
    orKeys.delete(m[1]);
    return Response.json({ deleted: true });
  }
  return Response.json({ error: "method" }, { status: 405 });
}

export default defineConfig(async () => ({
  test: { setupFiles: ["./test/setup.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SYNC_DEV_TOKEN: "test-token",
          PUBLIC_URL: "http://127.0.0.1:8787",
          // Tests never send mail, even when .dev.vars holds a real key.
          RESEND_API_KEY: "",
          REPORT_EMAIL: "",
          ADMIN_TOKEN: "admin-test-token",
          // The deployed list, whatever .dev.vars allows for local testing.
          CORS_ORIGINS: "https://app.brewlm.com,http://localhost:1430",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          POLAR_ACCESS_TOKEN: "polar_oat_test",
          POLAR_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=",
          POLAR_API_URL: "https://polar.test",
          POLAR_PRODUCT_SYNC_MONTHLY: "prod-sync-m",
          POLAR_PRODUCT_SYNC_YEARLY: "prod-sync-y",
          POLAR_PRODUCT_PLUS_MONTHLY: "prod-plus-m",
          POLAR_PRODUCT_PLUS_YEARLY: "prod-plus-y",
          POLAR_PRODUCT_PRO_MONTHLY: "prod-pro-m",
          POLAR_PRODUCT_PRO_YEARLY: "prod-pro-y",
          POLAR_PRODUCT_MAX_MONTHLY: "prod-max-m",
          POLAR_PRODUCT_MAX_YEARLY: "prod-max-y",
          POLAR_PRODUCT_AI_TOPUP: "prod-ai-topup",
          OPENROUTER_API_URL: "https://openrouter.test/api/v1",
          OPENROUTER_MANAGEMENT_KEY: "or-mgmt-test",
          AI_KEY_SECRET: "ai-test-secret",
        },
        // A stand-in for Polar's API: echoes what was asked for into the URL it returns.
        outboundService: async (req: Request) => {
          const url = new URL(req.url);
          if (url.host === "page.test") return fakeSite(req, url);
          if (url.host === "openrouter.test") return fakeOpenRouter(req, url);
          if (url.host !== "polar.test") return new Response("no network in tests", { status: 503 });
          if (url.pathname === "/__calls") return Response.json(polarCalls);
          const body = (await req.json()) as Record<string, unknown>;
          // Plan changes (POST /v1/billing/change). A subscription id containing
          // "declined" fails like a card that won't take the prorated charge.
          const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
          if (sub && req.method === "PATCH") {
            polarCalls.push({ path: url.pathname, body });
            if (sub[1].includes("declined") && body.product_id)
              return Response.json({ detail: "payment failed" }, { status: 422 });
            return Response.json({ id: sub[1], ...body });
          }
          if (url.pathname === "/v1/checkouts/")
            return Response.json({
              url: `https://polar.test/checkout?product=${(body.products as string[])[0]}&customer=${body.external_customer_id}&auth=${req.headers.get("authorization")}`,
            });
          if (url.pathname === "/v1/customer-sessions/")
            return Response.json({ customer_portal_url: `https://polar.test/portal?customer=${body.external_customer_id}` });
          return new Response("unknown", { status: 404 });
        },
      },
    }),
  ],
}));
