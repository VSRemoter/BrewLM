/**
 * The desktop's chat rendering, bundled for the paired phone's page
 * (src-tauri/mobile.html), so phone replies look exactly as they do on the
 * computer: markdown, tables, LaTeX math (KaTeX), SVG drawings, and the
 * /fetch source cards; plus the mind map outline format and the constitution
 * templates' names. Built by scripts/build-phone-render.mjs; the sharing
 * server (src-tauri/src/server.rs) serves it at /assets/render.js.
 */
import { renderMarkdown } from "../lib/markdown";
import { parseFetchMessage, siteOf, urlKey } from "../lib/fetchList";
import { parseMindmap, serializeMindmap } from "../lib/mindmap";
import { CONSTITUTION_TEMPLATES } from "../lib/constitution";

(window as unknown as { BrewRender: unknown }).BrewRender = {
  renderMarkdown,
  parseFetchMessage,
  siteOf,
  urlKey,
  // Mind maps edited on the phone are read and written back as the desktop does.
  parseMindmap,
  serializeMindmap,
  // Add constitution: the desktop's templates, by name (the computer adds the body).
  constitutions: CONSTITUTION_TEMPLATES.map(({ id, name, tagline }) => ({ id, name, tagline })),
};
