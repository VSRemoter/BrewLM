/**
 * The web app's Content-Security-Policy (public/_headers) lets index.html's
 * inline scripts run by their sha256 hash. Editing one of them changes its
 * hash, and the browser would then silently refuse to run it: this catches
 * that, and the two copies of the app's policy drifting apart.
 *
 * The desktop app's policy (tauri.conf.json) and file access (capabilities)
 * are checked too: there, script that slipped into the page could otherwise
 * read and write files anywhere on the computer.
 */
import { describe, expect, it } from "vitest";
import headersFile from "../../public/_headers?raw";
import indexHtml from "../../index.html?raw";
import tauriConf from "../../src-tauri/tauri.conf.json?raw";
import capabilities from "../../src-tauri/capabilities/default.json?raw";
import sandboxRs from "../../src-tauri/src/sandbox.rs?raw";

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

describe("desktop app CSP", () => {
  const security = JSON.parse(tauriConf).app.security as {
    csp: string | null;
    dangerousDisableAssetCspModification?: boolean | string[];
  };
  const directive = (name: string) => new RegExp(`(?:^|;)\\s*${name} ([^;]+)`).exec(security.csp ?? "")?.[1] ?? "";

  it("has a policy that never runs inline script or eval", () => {
    expect(security.csp).toBeTruthy();
    const scriptSrc = directive("script-src");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(directive("object-src")).toBe("'none'");
  });

  it("only gives up Tauri's own hashing for styles, never scripts", () => {
    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
  });

  it("allows the app's IPC, its media files and its interactive-page frame", () => {
    expect(directive("connect-src")).toContain("ipc:");
    expect(directive("connect-src")).toContain("http://ipc.localhost");
    expect(directive("media-src")).toContain("brewblob:");
    expect(directive("frame-src")).toContain("brewsandbox:");
    expect(directive("frame-src")).toContain("http://brewsandbox.localhost");
  });

  it("serves the interactive-page frame with the web app's frame policy", () => {
    const rust = /SANDBOX_CSP: &str = "([^"]+)"/.exec(sandboxRs)?.[1];
    expect(rust).toBe(policies(headersFile).get("/sandbox"));
  });
});

describe("desktop file access", () => {
  const perms = JSON.parse(capabilities).permissions as (string | { identifier: string; allow?: { path?: string }[] })[];
  const paths = perms.flatMap((p) => (typeof p === "string" ? [] : (p.allow ?? []).map((a) => [p.identifier, a.path])));

  it("never opens the whole disk to the page", () => {
    for (const [id, path] of paths) {
      if (!path) continue;
      expect(path, id).toMatch(/^\$APP(DATA|CONFIG|LOCALDATA|CACHE|LOG)\//);
    }
  });

  it("only writes the database by path (everything else goes through a save dialog)", () => {
    const writes = paths.filter(([id]) => id === "fs:allow-write-file").map(([, p]) => p);
    expect(writes).toEqual(["$APPDATA/brewlm.db", "$APPDATA/brewlm.db-wal", "$APPDATA/brewlm.db-shm"]);
  });
});
