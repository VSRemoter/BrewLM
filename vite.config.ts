import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const appVersion: string = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")
).version;

// https://vite.dev/config/
// `--mode web` builds the browser app (the phone app): `npm run dev:web`,
// `npm run build:web` → dist-web/. Anything else is the Tauri desktop app.
export default defineConfig(async ({ mode, command }) => {
  const web = mode === "web";
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@platform-impl": fileURLToPath(new URL(`./src/platform/${web ? "web" : "desktop"}.ts`, import.meta.url)),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      // Names this build's offline cache (public/sw.js).
      __BUILD_ID__: JSON.stringify(`${appVersion}-${Date.now().toString(36)}`),
      // A built web app always syncs with sync.brewlm.com: the dev settings in
      // .env.web.local (a local server, the dev token) never reach a deployed build.
      ...(command === "build"
        ? {
            "import.meta.env.VITE_SYNC_URL": "undefined",
            "import.meta.env.VITE_SYNC_TOKEN": "undefined",
            "import.meta.env.VITE_SYNC_VAULT": "undefined",
          }
        : {}),
    },

    ...(web
      ? {
          // public/sw.js (the service worker) ships in both builds; only the web one registers it.
          build: { outDir: "dist-web" },
          // SQLite's WebAssembly build loads its own .wasm file; pre-bundling breaks that.
          optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
          worker: { format: "es" as const },
          server: { port: 1430, strictPort: true },
        }
      : {
          // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
          //
          // 1. prevent Vite from obscuring rust errors
          clearScreen: false,
          // 2. tauri expects a fixed port, fail if that port is not available
          server: {
            port: 1420,
            strictPort: true,
            host: host || false,
            hmr: host
              ? {
                  protocol: "ws",
                  host,
                  port: 1421,
                }
              : undefined,
            watch: {
              // 3. tell Vite to ignore watching `src-tauri` (and the web build's output)
              ignored: ["**/src-tauri/**", "**/dist-web/**"],
            },
          },
        }),
  };
});
