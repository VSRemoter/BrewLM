import { describe, expect, it, vi } from "vitest";
import { extractHtml, parseInteractive, sandboxDoc } from "./interactive";

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

  it("prepends when the page has no <head>", () => {
    expect(sandboxDoc("<html><body>hi</body></html>", false).startsWith("<meta http-equiv")).toBe(true);
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
