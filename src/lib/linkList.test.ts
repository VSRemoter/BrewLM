import { describe, expect, it } from "vitest";
import { parseLinkList } from "./linkList";

describe("parseLinkList", () => {
  it("reads one link per line", () => {
    expect(parseLinkList("https://www.youtube.com\nhttps://amazon.com\nhttps://wsj.com\nhttps://google.com\n")).toEqual([
      "https://www.youtube.com",
      "https://amazon.com",
      "https://wsj.com",
      "https://google.com",
    ]);
  });

  it("accepts spaces, commas, bare domains and wrapping punctuation", () => {
    expect(parseLinkList("example.com, <https://a.org/x?y=1>  (b.net/page).")).toEqual([
      "example.com",
      "https://a.org/x?y=1",
      "b.net/page",
    ]);
  });

  it("skips words and duplicate links", () => {
    expect(parseLinkList("read these:\nhttps://a.org/\na.org\nhello\nHTTPS://A.ORG")).toEqual(["https://a.org/"]);
  });
});
