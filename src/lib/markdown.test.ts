import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("headings", () => {
  it("renders all six levels, with or without closing hashes", () => {
    expect(renderMarkdown("# One")).toBe("<h1>One</h1>");
    expect(renderMarkdown("#### **Solutions**")).toBe("<h4><strong>Solutions</strong></h4>");
    expect(renderMarkdown("###### Six ##")).toBe("<h6>Six</h6>");
  });

  it("leaves seven hashes, or no space after them, as text", () => {
    expect(renderMarkdown("####### Seven")).not.toContain("<h");
    expect(renderMarkdown("####tag")).not.toContain("<h");
  });
});

describe("lists", () => {
  it("keeps a numbered list whole when items have indented explanations", () => {
    const md = [
      "1. **Long-term profitability**",
      "",
      "   EV is the average amount you expect to win.",
      "",
      "2. **Benchmark against other plays**",
      "",
      "   Folding has EV = 0.",
      "",
      "3. **Win-rate**",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("<li><strong>Long-term profitability</strong><p>EV is the average amount you expect to win.</p></li>");
  });

  it("keeps the model's numbers when an unindented paragraph splits the list", () => {
    const html = renderMarkdown("1. One\n\nAbout one.\n\n2. Two\n\nAbout two.\n\n3. Three");
    expect(html).toContain("<ol><li>One</li></ol>");
    expect(html).toContain('<ol start="2"><li>Two</li></ol>');
    expect(html).toContain('<ol start="3"><li>Three</li></ol>');
  });

  it("keeps blank-separated items in one list", () => {
    expect(renderMarkdown("1. a\n\n2. b\n\n3. c")).toBe("<ol><li>a</li><li>b</li><li>c</li></ol>");
    expect(renderMarkdown("- a\n\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("nests indented sub-items under their item", () => {
    expect(renderMarkdown("1. Steps\n   - mix\n   - bake\n2. Serve")).toBe(
      "<ol><li>Steps<ul><li>mix</li><li>bake</li></ul></li><li>Serve</li></ol>"
    );
  });

  it("runs text directly under an item on as part of it", () => {
    expect(renderMarkdown("- first line\ncontinued")).toBe("<ul><li>first line continued</li></ul>");
  });

  it("still ends the list at a following heading or paragraph", () => {
    expect(renderMarkdown("- a\n\nAfter.")).toBe("<ul><li>a</li></ul><p>After.</p>");
    expect(renderMarkdown("- a\n## Next")).toBe("<ul><li>a</li></ul><h2>Next</h2>");
  });
});
