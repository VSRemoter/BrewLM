import { beforeEach, describe, expect, it, vi } from "vitest";

const platformFetch = vi.fn<(url: string, init: Record<string, unknown>) => Promise<Response>>();
vi.mock("../platform", () => ({ platform: { kind: "desktop", fetch: (u: string, i: Record<string, unknown>) => platformFetch(u, i) } }));
vi.mock("./sync", () => ({ fetchThroughServer: vi.fn() }));

import { decodeHtml } from "./source";
import { fetchWebPage, gunzipIfCompressed } from "./webFetch";

const PAGE = "<html><head><title>Amazon.com: MacBook Pro</title></head><body>Café ✓</body></html>";

function plugin(body: Uint8Array | string, headers: Record<string, string> = {}) {
  const res = new Response(body as BodyInit, { status: 200, headers });
  Object.defineProperty(res, "url", { value: "https://www.amazon.com/dp/B0GR1G1FY7" });
  return res;
}

beforeEach(() => platformFetch.mockReset());

async function compress(text: string, format: "gzip" | "deflate"): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("fetchWebPage (desktop)", () => {
  it("sends no Origin and leaves the rest of the request alone", async () => {
    platformFetch.mockResolvedValue(plugin(PAGE));
    await fetchWebPage("https://example.com", { headers: { "User-Agent": "UA" } });
    const init = platformFetch.mock.calls[0][1];
    expect(init.headers).toEqual({ "User-Agent": "UA", Origin: "" });
    expect(init.headers).not.toHaveProperty("Accept-Encoding");
  });

  it("unpacks a gzip body a site sent unasked (Amazon), keeping status and url", async () => {
    platformFetch.mockResolvedValue(plugin(await compress(PAGE, "gzip"), { "content-encoding": "gzip", "content-type": "text/html" }));
    const res = await fetchWebPage("https://www.amazon.com/dp/B0GR1G1FY7");
    expect(await res.text()).toBe(PAGE);
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://www.amazon.com/dp/B0GR1G1FY7");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("unpacks deflate", async () => {
    platformFetch.mockResolvedValue(plugin(await compress(PAGE, "deflate"), { "content-encoding": "deflate" }));
    expect(await (await fetchWebPage("https://x.org")).text()).toBe(PAGE);
  });

  it("passes an uncompressed page through untouched", async () => {
    const original = plugin(PAGE, { "content-type": "text/html" });
    platformFetch.mockResolvedValue(original);
    expect(await fetchWebPage("https://x.org")).toBe(original);
  });
});

describe("gunzipIfCompressed", () => {
  it("unpacks gzip bytes with no header to say so", async () => {
    expect(new TextDecoder().decode(await gunzipIfCompressed(await compress(PAGE, "gzip")))).toBe(PAGE);
  });
  it("leaves other bytes alone", async () => {
    const b = new TextEncoder().encode(PAGE);
    expect(await gunzipIfCompressed(b)).toBe(b);
  });
});

describe("decodeHtml", () => {
  const enc = new TextEncoder();
  it("reads UTF-8", () => {
    expect(decodeHtml(enc.encode(PAGE), "text/html")).toBe(PAGE);
  });
  it("honours a declared charset", () => {
    const latin = new Uint8Array([...enc.encode('<meta charset="windows-1252"><p>Caf'), 0xe9, ...enc.encode("</p>")]);
    expect(decodeHtml(latin, "text/html")).toContain("Café");
    expect(decodeHtml(latin.slice(29), "text/html; charset=ISO-8859-1")).toContain("Café");
  });
  it("reads an undeclared legacy page as Windows-1252", () => {
    const words = Array.from({ length: 50 }, () => [...enc.encode(" caf"), 0xe9]).flat();
    expect(decodeHtml(new Uint8Array([...enc.encode("<p>"), ...words]), "text/html")).toContain("café café");
  });
  it("refuses compressed or binary bytes instead of returning gibberish", async () => {
    const junk = await compress(Array.from({ length: 5000 }, (_, i) => `<p>row ${i * 7919} ${Math.sin(i)}</p>`).join(""), "gzip");
    expect(() => decodeHtml(junk, "text/html;charset=UTF-8")).toThrow(/couldn't read/);
  });
});
