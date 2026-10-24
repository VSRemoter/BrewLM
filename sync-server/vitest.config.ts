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
        },
        // A stand-in for Polar's API: echoes what was asked for into the URL it returns.
        outboundService: async (req: Request) => {
          const url = new URL(req.url);
          if (url.host === "page.test") return fakeSite(req, url);
          if (url.host !== "polar.test") return new Response("no network in tests", { status: 503 });
          const body = (await req.json()) as Record<string, unknown>;
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
