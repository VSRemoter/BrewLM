/**
 * The desktop's chat rendering, bundled for the paired phone's page
 * (src-tauri/mobile.html), so phone replies look exactly as they do on the
 * computer: markdown, tables, LaTeX math (KaTeX), SVG drawings, and the
 * /fetch source cards. Built by scripts/build-phone-render.mjs; the sharing
 * server (src-tauri/src/server.rs) serves it at /assets/render.js.
 */
import { renderMarkdown } from "../lib/markdown";
import { parseFetchMessage, siteOf, urlKey } from "../lib/fetchList";

(window as unknown as { BrewRender: unknown }).BrewRender = { renderMarkdown, parseFetchMessage, siteOf, urlKey };
