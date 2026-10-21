// Copies Excalidraw's fonts into public/ so drawings render offline.
// Xiaolai (the 12 MB Chinese/Japanese/Korean handwriting font) is left out;
// Excalidraw downloads it from its CDN only if such text is drawn.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const from = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const to = "public/excalidraw/fonts";
const skip = new Set(["Xiaolai"]);

if (!existsSync(from)) {
  console.warn("copy-excalidraw-fonts: Excalidraw isn't installed, skipping");
  process.exit(0);
}
rmSync(to, { recursive: true, force: true });
for (const family of readdirSync(from)) {
  if (!skip.has(family)) cpSync(join(from, family), join(to, family), { recursive: true });
}
console.log("copy-excalidraw-fonts: copied to", to);
