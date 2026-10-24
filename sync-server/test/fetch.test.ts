import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_FETCHES_PER_HOUR, refuseUrl } from "../src/fetch";

const DEV = { authorization: "Bearer test-token" };

const fetchPage = (body: unknown, headers: Record<string, string> = DEV) =>
  exports.default.fetch("https://sync.test/v1/fetch", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("page fetcher (web app)", () => {
  it("needs an account (or the dev token)", async () => {
    expect((await fetchPage({ url: "https://page.test/hello" }, {})).status).toBe(401);
    const res = await fetchPage({ url: "https://page.test/hello" }, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-brewlm-fetch")).toBe("error");
  });

  it("returns the page with its status, type and final address", async () => {
    const res = await fetchPage({ url: "https://page.test/hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("x-final-url")).toBe("https://page.test/hello");
    expect(await res.text()).toContain("Hi there");
    // The site's own error codes come through as they are, not as ours.
    const teapot = await fetchPage({ url: "https://page.test/teapot" });
    expect(teapot.status).toBe(418);
    expect(teapot.headers.get("x-brewlm-fetch")).toBeNull();
  });

  it("refuses addresses that aren't public web pages", () => {
    const own = "sync.brewlm.com";
    for (const bad of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://10.0.0.5/admin",
      "http://localhost:8080/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://intranet/",
      "https://page.test:8443/",
      "https://user:pass@page.test/",
      "file:///etc/passwd",
      "ftp://page.test/",
      "https://sync.brewlm.com/v1/me",
      "not a url",
    ])
      expect(refuseUrl(bad, own), bad).not.toBeNull();
    expect(refuseUrl("https://en.wikipedia.org/wiki/Coffee", own)).toBeNull();
    expect(refuseUrl("http://example.com/a?b=c", own)).toBeNull();
  });

  it("follows redirects, checking each hop", async () => {
    const moved = await fetchPage({ url: "https://page.test/moved" });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("x-final-url")).toBe("https://page.test/hello");
    const sneaky = await fetchPage({ url: "https://page.test/to-local" });
    expect(sneaky.status).toBe(400);
    expect(((await sneaky.json()) as { error: string }).error).toMatch(/redirects/);
    expect((await fetchPage({ url: "https://page.test/loop" })).status).toBe(502);
  });

  it("passes only safe headers, and POST bodies", async () => {
    const res = await fetchPage({
      url: "https://page.test/echo",
      method: "POST",
      headers: { "User-Agent": "BrewLM-test", "Content-Type": "application/json", Cookie: "secret=1", Authorization: "Bearer x" },
      body: '{"videoId":"abc"}',
    });
    const echo = (await res.json()) as { method: string; body: string; headers: Record<string, string> };
    expect(echo.method).toBe("POST");
    expect(echo.body).toBe('{"videoId":"abc"}');
    expect(echo.headers["user-agent"]).toBe("BrewLM-test");
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers.authorization).toBeUndefined();
    expect((await fetchPage({ url: "https://page.test/echo", method: "DELETE" })).status).toBe(400);
    expect((await fetchPage({ url: "https://page.test/echo", body: "x" })).status).toBe(400); // a body needs POST
  });

  it("refuses pages over 25 MB", async () => {
    expect((await fetchPage({ url: "https://page.test/huge" })).status).toBe(413);
  });

  it("limits fetches per account per hour", async () => {
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: MAX_FETCHES_PER_HOUR }, () =>
        env.DB.prepare("INSERT INTO page_fetches (user_id, created_at) VALUES ('dev', ?)").bind(now)
      )
    );
    const res = await fetchPage({ url: "https://page.test/hello" });
    expect(res.status).toBe(429);
    await env.DB.prepare("DELETE FROM page_fetches").run();
  });

  it("lets the web app read the page's address", async () => {
    const res = await fetchPage({ url: "https://page.test/hello" }, { ...DEV, origin: "https://app.brewlm.com" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.brewlm.com");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-final-url");
  });
});
