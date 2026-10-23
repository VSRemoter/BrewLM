import { applyD1Migrations, env } from "cloudflare:test";

// Each test file starts with the account tables in place.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
