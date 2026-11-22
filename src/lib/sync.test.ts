import { beforeEach, describe, expect, it, vi } from "vitest";

const MB = 1024 * 1024;
/** Files on "this device": name → size. */
const sizes = new Map<string, number>();
/** Uploads the "server" received, by file id. */
const uploaded: string[] = [];
/** The server's own per-file limit (100 MB, like sync-server's MAX_BLOB). */
let serverLimit = 100 * MB;

vi.mock("../platform", () => ({
  platform: {
    kind: "desktop",
    sync: { log: vi.fn() },
    fetch: vi.fn(async (url: string, init: { method?: string; body?: unknown }) => {
      if (url.endsWith("/blobs/missing")) {
        const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
        return new Response(JSON.stringify({ missing: ids }), { status: 200 });
      }
      if (init.method === "PUT") {
        const size = (init.body as Uint8Array).length;
        if (size > serverLimit) return new Response(JSON.stringify({ error: "blob too large" }), { status: 413 });
        uploaded.push(url.slice(url.lastIndexOf("/") + 1));
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }),
  },
}));
vi.mock("./blobs", async (orig) => ({
  ...(await orig<typeof import("./blobs")>()),
  mediaFileSize: vi.fn(async (name: string) => sizes.get(name) ?? 0),
  // The bytes, as small stand-ins unless a test wants the real size.
  mediaBytes: vi.fn(async (ref: string) => new Uint8Array(Math.min(sizes.get(ref.slice("brewblob:".length)) ?? 0, 2 * MB))),
}));
vi.mock("./db", () => ({ getDb: vi.fn(), referencedBlobRefs: vi.fn(async () => []), SYNCED_TABLES: {}, uid: () => "id" }));

import { mediaBytes } from "./blobs";
import { filesTooLargeToSync, getSyncStatus, syncTesting } from "./sync";
import { deriveKeys, newVaultKey } from "./vaultCrypto";

const cfg = { url: "https://sync.test", token: "t", vault: "v" };
const { media, uploadMedia } = syncTesting;

beforeEach(() => {
  sizes.clear();
  uploaded.length = 0;
  serverLimit = 100 * MB;
  media.toUpload.clear();
  media.onServer.clear();
  media.tooLarge.clear();
  vi.mocked(mediaBytes).mockClear();
});

describe("uploadMedia", () => {
  it("skips a file over 100 MB without reading it, and still uploads the rest", async () => {
    const keys = await deriveKeys(newVaultKey());
    sizes.set("a.jpg", 1 * MB);
    sizes.set("huge.m4a", 1000 * 1024 * MB);
    sizes.set("b.png", 2 * MB);
    for (const n of sizes.keys()) media.toUpload.add(n);

    await uploadMedia(cfg, keys);

    expect(uploaded).toHaveLength(2);
    expect([...filesTooLargeToSync()]).toEqual(["huge.m4a"]);
    expect(getSyncStatus().tooLarge).toBe(1);
    expect(media.toUpload.size).toBe(0);
    expect(vi.mocked(mediaBytes).mock.calls.map((c) => c[0])).not.toContain("brewblob:huge.m4a");

    // Later cycles leave it alone instead of failing on it again.
    media.toUpload.add("huge.m4a");
    await uploadMedia(cfg, keys);
    expect(uploaded).toHaveLength(2);
    expect(media.toUpload.size).toBe(0);
  });

  it("treats the server's 'blob too large' answer as a skip, not a failed cycle", async () => {
    const keys = await deriveKeys(newVaultKey());
    serverLimit = 1 * MB; // a server stricter than this build knows
    sizes.set("big.jpg", 1.5 * MB);
    sizes.set("small.jpg", 0.5 * MB);
    media.toUpload.add("big.jpg");
    media.toUpload.add("small.jpg");

    await expect(uploadMedia(cfg, keys)).resolves.toBeUndefined();

    expect(uploaded).toHaveLength(1);
    expect(filesTooLargeToSync().has("big.jpg")).toBe(true);
    expect(filesTooLargeToSync().has("small.jpg")).toBe(false);
  });
});
