// Bundle the desktop's chat renderer for the paired phone's page
// (src/phone/render.ts → src-tauri/phone-render/), gzipped, plus Mermaid for
// diagrams. The sharing server embeds these (src-tauri/build.rs) and serves
// them at /assets/…. Runs on npm install and before every dev/build.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const out = "src-tauri/phone-render";
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: { render: "src/phone/render.ts" },
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari15"],
  write: false,
  outdir: out,
  // KaTeX's fonts: woff2 inline (every phone browser takes it); the older
  // formats listed after it are never fetched, so they're left out.
  loader: { ".woff2": "dataurl", ".woff": "empty", ".ttf": "empty" },
  legalComments: "eof",
  logLevel: "warning",
});

const gz = (name, bytes) => writeFileSync(`${out}/${name}.gz`, gzipSync(bytes, { level: 9 }));
for (const f of result.outputFiles) gz(f.path.split("/").pop(), f.contents);
gz("mermaid.js", readFileSync("node_modules/mermaid/dist/mermaid.min.js"));
