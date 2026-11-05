// @vitest-environment jsdom
/**
 * ```svg fences render inline, so they must hold against hostile input: an AI
 * answer steered by a source, or a shared notebook someone else wrote. Each
 * payload is rendered, put in the page the way the app does (innerHTML), and
 * the result checked for anything that could run or phone home.
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

const fence = (svg: string) => "```svg\n" + svg + "\n```";

/** Render like ChatPanel/ArtifactView do (dangerouslySetInnerHTML), return the container. */
function mount(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el;
}

/** Everything in the rendered page that could run script, frame content or load from outside. */
function dangers(el: HTMLElement): string[] {
  const found: string[] = [];
  for (const node of el.querySelectorAll("*")) {
    const tag = node.localName.toLowerCase();
    if (["script", "iframe", "img", "object", "embed", "foreignobject", "a", "set", "animate", "handler"].includes(tag))
      found.push(`<${tag}>`);
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) found.push(`${tag} ${name}`);
      if (/(^|:)href$/.test(name) && !attr.value.trim().startsWith("#")) found.push(`${tag} ${name}=${attr.value}`);
      if (/javascript:/i.test(attr.value)) found.push(`${tag} ${name}=${attr.value}`);
    }
  }
  return found;
}

const PAYLOADS = [
  // The one that got past the old regex filter: attributes split by "/".
  `<svg><img/src="x"/onerror="alert(1)"></svg>`,
  `<svg/onload=alert(1)>`,
  `<svg onload="alert(1)"><circle r="5"/></svg>`,
  `<svg><script>alert(1)</script></svg>`,
  `<svg><script href="data:text/javascript,alert(1)"/></svg>`,
  `<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"/></svg>`,
  `<svg><set attributeName="href" to="javascript:alert(1)"/></svg>`,
  `<svg><a xlink:href="javascript:alert(1)"><text x="5" y="20">click</text></a></svg>`,
  `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
  `<svg><use href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"/></svg>`,
  `<svg><image href="https://tracker.example/pixel.png"/></svg>`,
  `<svg><style><img src=x onerror=alert(1)></style></svg>`,
  `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>"></svg>`,
  `<svg><title><img src=x onerror=alert(1)></title></svg>`,
  `<svg><desc><![CDATA[</desc><img src=x onerror=alert(1)>]]></desc></svg>`,
  `<svg><math><mi xlink:href="javascript:alert(1)">x</mi></math></svg>`,
  `<svg><feImage href="https://tracker.example/x.svg"/></svg>`,
  `<svg><handler xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load">alert(1)</handler></svg>`,
];

describe("svg fences", () => {
  it.each(PAYLOADS)("leave nothing active: %s", (payload) => {
    expect(dangers(mount(fence(payload)))).toEqual([]);
  });

  it("keeps an ordinary drawing", () => {
    const el = mount(
      fence(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f60"/><stop offset="1" stop-color="#fc0"/></linearGradient></defs>
  <style>.label { font: 12px sans-serif; }</style>
  <rect id="box" x="10" y="10" width="80" height="40" rx="6" fill="url(#g)"/>
  <use href="#box" x="100"/>
  <text class="label" x="20" y="35">Input</text>
  <path d="M90 30 L110 30" stroke="currentColor" marker-end="url(#arrow)"/>
</svg>`)
    );
    const svg = el.querySelector(".svg-embed > svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(svg?.querySelector("linearGradient#g stop")).not.toBeNull();
    expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe("url(#g)");
    expect(svg?.querySelector("use")?.getAttribute("href")).toBe("#box");
    expect(svg?.querySelector("text")?.textContent).toBe("Input");
    expect(svg?.querySelector("style")?.textContent).toContain(".label");
  });

  it("accepts an XML declaration before the drawing", () => {
    const el = mount(fence(`<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>`));
    expect(el.querySelector(".svg-embed circle")).not.toBeNull();
  });

  it("shows anything that isn't a drawing as code", () => {
    const el = mount(fence(`<img src=x onerror=alert(1)>`));
    expect(el.querySelector("pre code")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(dangers(el)).toEqual([]);
  });

  it("doesn't let math or other text be substituted inside a drawing", () => {
    const el = mount(`Area $x^2$.\n\n${fence(`<svg><text data-x="%%MATH0%%">%%MATH0%%</text></svg>`)}`);
    const text = el.querySelector(".svg-embed text");
    expect(text?.textContent).toBe("%%MATH0%%");
    expect(text?.getAttribute("data-x")).toBe("%%MATH0%%");
    expect(el.querySelector("p .katex")).not.toBeNull();
  });

  it("can't be forged from text outside a fence", () => {
    const el = mount(`${fence("<svg><circle r='1'/></svg>")}\n\nsee 0 and [x](https://e.example/0)`);
    expect(el.querySelectorAll("svg")).toHaveLength(1);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://e.example/0");
  });
});
