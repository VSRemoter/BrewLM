/** Lazy mermaid rendering for ```mermaid blocks (chat bubbles, reports). */

let loader: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  loader ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    return m.default;
  });
  return loader;
}

let seq = 0;

/** Replace `.mermaid-block` placeholders under `root` with rendered svgs. */
export async function hydrateMermaid(root: HTMLElement | null): Promise<void> {
  if (!root) return;
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-hydrated])")
  );
  if (!blocks.length) return;
  // mark first so concurrent renders don't re-process the same block
  blocks.forEach((b) => (b.dataset.hydrated = "1"));
  const mermaid = await loadMermaid();
  for (const el of blocks) {
    const src = (el.textContent ?? "").trim();
    if (!src) {
      el.remove();
      continue;
    }
    try {
      const { svg } = await mermaid.render(`om-mmd-${seq++}`, src);
      el.classList.add("mermaid-done");
      el.innerHTML = svg;
    } catch {
      el.classList.add("mermaid-error"); // leave the source visible as code
    }
  }
}
