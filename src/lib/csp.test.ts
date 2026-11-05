/**
 * The web app's Content-Security-Policy (public/_headers) lets index.html's
 * inline scripts run by their sha256 hash. Editing one of them changes its
 * hash, and the browser would then silently refuse to run it: this catches
 * that, and the two copies of the app's policy drifting apart.
 */
import { describe, expect, it } from "vitest";
import headersFile from "../../public/_headers?raw";
import indexHtml from "../../index.html?raw";

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

/** The Content-Security-Policy each path rule in _headers sets. */
function policies(headers: string): Map<string, string> {
  const out = new Map<string, string>();
  let path = "";
  for (const line of headers.split("\n")) {
    if (/^\/\S*$/.test(line)) path = line.trim();
    const m = /^\s+Content-Security-Policy:\s*(.+)$/.exec(line);
    if (m && path) out.set(path, m[1].trim());
  }
  return out;
}

describe("web app CSP", () => {
  const csp = policies(headersFile);

  it("sets the same policy on the app's page and on shared links", () => {
    expect(csp.get("/")).toBeTruthy();
    expect(csp.get("/s/*")).toBe(csp.get("/"));
  });

  it("allows each inline script in index.html by its current hash", async () => {
    const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const allowed = [...csp.get("/")!.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
    const hashes = await Promise.all(scripts.map(sha256));
    expect(allowed.sort()).toEqual(hashes.sort());
  });

  it("never lets the app's page run arbitrary inline script or eval", () => {
    const scriptSrc = /script-src ([^;]+)/.exec(csp.get("/")!)?.[1] ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("gives the interactive-page frame its own no-network policy", () => {
    expect(csp.get("/sandbox")).toContain("connect-src 'none'");
  });
});
