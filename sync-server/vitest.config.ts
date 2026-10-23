import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  test: { setupFiles: ["./test/setup.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SYNC_DEV_TOKEN: "test-token",
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
