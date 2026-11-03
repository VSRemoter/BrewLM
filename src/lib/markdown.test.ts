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
