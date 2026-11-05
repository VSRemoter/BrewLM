import { describe, expect, it, vi } from "vitest";
import html from "../../src-tauri/mobile.html?raw";
import { parseMindmap, type MindNode } from "./mindmap";
import { sandboxDoc } from "./interactive";

vi.mock("./llm", () => ({ streamChat: vi.fn() }));

/** A slice of the phone page's script (src-tauri/mobile.html), run on its own. */
function phoneCode<T>(from: string, to: string, names: string[]): T {
  const code = html.slice(html.indexOf(from), html.indexOf(to));
  const esc = (s: unknown) => String(s ?? "");
  return new Function("esc", `${code}; return { ${names.join(", ")} };`)(esc) as T;
}

type PhoneNode = { label: string; note: string; children: PhoneNode[] };
const phone = phoneCode<{
  parseMindmap: (data: string, title: string) => PhoneNode | null;
  mindTree: (root: PhoneNode) => string;
}>("const mmPlain", "async function loadMind(", ["parseMindmap", "mindTree"]);

const page = phoneCode<{ pageDoc: (html: string, dark: boolean) => string }>(
  "const PAGE_CSP",
  "let closeViewer",
  ["pageDoc"]
);

/** The desktop's tree without its session-only ids. */
const shape = (n: MindNode | null): PhoneNode | null =>
  n && { label: n.label, note: n.note, children: n.children.map((c) => shape(c)!) };

describe("phone page mind maps", () => {
  it.each([
    [
      "definitions and emphasis",
      `- Biological Psychology: How biology shapes behaviour
  - Neurophysiology
    - Threshold: Voltage trigger point
    - **Repolarization**: K+ efflux
  - Mind-Brain Problem
    - Monism — Mind and brain are inseparable`,
    ],
    ["several top-level branches", "- A\n    - A1\n- B"],
    ["tabs and continuation lines", "- Root\n\t- Child: first part\n\t  goes on here\n\t\t- Leaf"],
    ["no outline at all", "Just a paragraph."],
  ])("reads the outline as the desktop does (%s)", (_, outline) => {
    expect(phone.parseMindmap(outline, "My map")).toEqual(shape(parseMindmap(outline, "My map")));
  });

  it("opens the main branches and leaves deeper ones folded", () => {
    const tree = phone.mindTree(phone.parseMindmap("- Root\n  - Branch\n    - Twig\n      - Leaf", "t")!);
    expect(tree).toContain('<details open><summary><span class="lb">Branch</span>');
    expect(tree).toContain('<details><summary><span class="lb">Twig</span>');
    expect(tree).toContain('<div class="leaf"><span class="lb">Leaf</span>');
  });
});

describe("phone page interactive pages", () => {
  it.each([
    ["<!DOCTYPE html><html><head><title>x</title></head><body><script>go()</script></body></html>", true],
    ["<p>no head</p>", false],
  ])("sandboxes the page exactly as the desktop does (%#)", (doc, dark) => {
    expect(page.pageDoc(doc, dark)).toBe(sandboxDoc(doc, dark));
  });
});
