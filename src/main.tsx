import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

/** Last-resort error surface so a startup failure never shows a blank window. */
function showFatal(detail: string) {
  if (document.getElementById("fatal-overlay")) return;
  const el = document.createElement("div");
  el.id = "fatal-overlay";
  el.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--color-canvas,#fafafa);font-family:var(--font-sans,-apple-system,sans-serif);padding:32px;";
  el.innerHTML = `<div style="max-width:480px;text-align:center;">
    <p style="font-size:16px;font-weight:600;color:var(--color-ink,#171717);margin:0 0 8px;">OpenMind hit a snag while starting</p>
    <p style="font-size:13px;color:var(--color-ink-3,#8a8a8a);margin:0 0 12px;">Please relaunch the app. If this keeps happening, share the message below.</p>
    <pre style="font-size:11px;color:var(--color-danger,#b91c1c);background:var(--color-danger-bg,#fef2f2);border:1px solid var(--color-danger-edge,#fecaca);border-radius:10px;padding:12px;text-align:left;white-space:pre-wrap;word-break:break-word;">${detail
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .slice(0, 800)}</pre>
  </div>`;
  document.body.appendChild(el);
}

window.addEventListener("error", (e) => showFatal(e.message || "Unknown script error"));
window.addEventListener("unhandledrejection", (e) =>
  showFatal(e.reason instanceof Error ? e.reason.message : String(e.reason))
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
