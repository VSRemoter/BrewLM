import { describe, expect, it, vi } from "vitest";
import { buildStoryboardPrompt, extractHtml, PAGE_SCROLL_STYLE, PAGE_SYSTEM, parseInteractive, sandboxDoc, STORYBOARD_ROLE } from "./interactive";

// The page builder streams through llm.ts, which needs the app's platform layer; these helpers don't.
vi.mock("./llm", () => ({ streamChat: vi.fn() }));

const PAGE = "<!DOCTYPE html>\n<html><head><title>AP</title></head><body><script>1</script></body></html>";

describe("extractHtml", () => {
  it("returns a bare document unchanged", () => {
    expect(extractHtml(PAGE)).toBe(PAGE);
  });

  it("strips fences and preamble", () => {
    expect(extractHtml(`Here is the page:\n\n\`\`\`html\n${PAGE}\n\`\`\`\nEnjoy!`)).toBe(PAGE);
  });

  it("drops trailing commentary after </html>", () => {
    expect(extractHtml(`${PAGE}\n\nLet me know if you want changes.`)).toBe(PAGE);
  });

  it("rejects a page cut off before </html>", () => {
    expect(() => extractHtml(PAGE.slice(0, 60))).toThrow(/cut off/);
  });

  it("rejects a reply with no page", () => {
    expect(() => extractHtml("Sorry, I can't do that.")).toThrow(/didn't return a web page/);
  });
});

describe("sandboxDoc", () => {
  it("injects CSP, theme and error reporter at the top of <head>", () => {
    const doc = sandboxDoc(PAGE, true);
    const head = doc.indexOf("<head>") + "<head>".length;
    expect(doc.slice(head)).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    expect(doc).toContain('setAttribute("data-theme","dark")');
    expect(doc).toContain("connect-src 'none'");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>1</script>"));
  });

  it("lets a too-wide page scroll sideways even when it hides overflow itself", () => {
    const page = "<!DOCTYPE html><html><head><style>body{overflow-x:hidden}</style></head><body></body></html>";
    const doc = sandboxDoc(page, false);
    expect(doc).toContain(PAGE_SCROLL_STYLE);
    expect(doc.indexOf(PAGE_SCROLL_STYLE)).toBeLessThan(doc.indexOf("body{overflow-x:hidden}"));
    expect(PAGE_SCROLL_STYLE).toContain("!important");
  });

  it("applies the app's Text size inside the page, and nothing extra at 100%", () => {
    expect(sandboxDoc(PAGE, false, 1.4)).toContain("<style>html{zoom:1.4}</style>");
    expect(sandboxDoc(PAGE, false)).not.toContain("html{zoom");
    expect(sandboxDoc(PAGE, false, 1)).toBe(sandboxDoc(PAGE, false));
  });

  it("prepends when the page has no <head>", () => {
    expect(sandboxDoc("<html><body>hi</body></html>", false).startsWith("<meta http-equiv")).toBe(true);
  });
});

describe("design direction", () => {
  it("plans one focused page around a main visual, without LaTeX", () => {
    const plan = buildStoryboardPrompt({ topic: "attention" });
    expect(plan).toContain("ONE main visual");
    expect(plan).toMatch(/usually 2–5/);
    expect(plan).not.toMatch(/every number/);
    expect(STORYBOARD_ROLE.rules).toMatch(/never LaTeX/);
    expect(STORYBOARD_ROLE.persona).not.toMatch(/study assistant/);
  });

  it("builds the main visual first, not a dashboard, in readable code", () => {
    expect(PAGE_SYSTEM).toMatch(/No dashboards/);
    expect(PAGE_SYSTEM).toMatch(/never LaTeX/);
    expect(PAGE_SYSTEM).not.toMatch(/Keep the code compact/);
    expect(PAGE_SYSTEM).not.toMatch(/Label every structure/);
  });
});

describe("PAGE_SYSTEM", () => {
  it("asks for a layout that fits narrow panels instead of hiding overflow", () => {
    expect(PAGE_SYSTEM).toContain("minmax(0,1fr)");
    expect(PAGE_SYSTEM).toMatch(/Never set overflow hidden/);
    expect(PAGE_SYSTEM).not.toMatch(/No horizontal scrolling/);
  });

  it("keeps a drawing's text readable in a narrow panel instead of shrinking it", () => {
    expect(PAGE_SYSTEM).toMatch(/at least 12px as rendered/);
    expect(PAGE_SYSTEM).toMatch(/never just scale the whole drawing down/);
  });
});

describe("parseInteractive", () => {
  it("reads stored data", () => {
    expect(parseInteractive(JSON.stringify({ html: PAGE, storyboard: "s" }))).toEqual({ html: PAGE, storyboard: "s" });
  });

  it("returns null for malformed data", () => {
    expect(parseInteractive("not json")).toBeNull();
    expect(parseInteractive(JSON.stringify({ html: "" }))).toBeNull();
  });
});
