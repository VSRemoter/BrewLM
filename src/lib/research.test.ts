import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./settings", () => ({}));
vi.mock("./usage", () => ({}));
vi.mock("./source", () => ({}));
vi.mock("./brewlmAi", () => ({}));

const { linksInText } = await import("./research");

describe("links in a search reply without citations", () => {
  it("takes markdown links and bare URLs, once each, without trailing punctuation", () => {
    const text = `Here are results:
1. **Docs:** [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) is the reference.
2. The plans page: https://www.cloudflare.com/plans/developer-platform/.
3. Again https://developers.cloudflare.com/workers/platform/pricing/ (same page).
4. Not a link: http://localhost and ftp://x.org`;
    expect(linksInText(text)).toEqual([
      { title: "Workers pricing", url: "https://developers.cloudflare.com/workers/platform/pricing/" },
      { title: "https://www.cloudflare.com/plans/developer-platform/", url: "https://www.cloudflare.com/plans/developer-platform/" },
    ]);
  });

  it("finds nothing in plain text", () => {
    expect(linksInText("No links here.")).toEqual([]);
  });
});
