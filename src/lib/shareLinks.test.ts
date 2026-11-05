import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; path: string; body?: unknown }[] = [];
let manifestConflicts = 0;
let stored: Uint8Array | null = null;
const rows: Record<string, unknown>[] = [];

vi.mock("../platform", () => ({
  platform: {
    fetch: async (url: string, init: RequestInit) => {
      const path = url.replace("https://sync.test", "");
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ method, path, body });
      const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (path === "/v1/shares" && method === "POST") return ok({ id: "f".repeat(32) });
      if (path.endsWith("/blobs/missing")) return ok({ missing: (body as { ids: string[] }).ids.slice(1) });
      if (path.includes("/manifest")) {
        if (manifestConflicts-- > 0) return ok({ error: "the link changed", version: 4 }, 409);
        stored = body as Uint8Array;
        return ok({ version: Number(/expect=(\d+)/.exec(path)![1]) + 1 });
      }
      return ok({ ok: true });
    },
  },
}));
vi.mock("./sync", () => ({ shareServer: () => ({ url: "https://sync.test", session: "s" }) }));
vi.mock("./blobs", async (orig) => ({
  ...(await orig<typeof import("./blobs")>()),
  mediaBytes: async (ref: string) => new TextEncoder().encode(`bytes of ${ref}`),
}));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (_sql: string, bind: unknown[]) => {
      rows.push({ id: bind[0], version: bind[3] });
      return { rowsAffected: 1 };
    },
    select: async () => [],
  }),
}));

const A = `brewblob:${"a".repeat(64)}.m4a`;
const B = `brewblob:${"b".repeat(64)}.pdf`;
const COVER = `brewblob:${"c".repeat(64)}.jpg`;
vi.mock("./share", async (orig) => ({
  ...(await orig<typeof import("./share")>()),
  readSnapshot: async () => ({
    format: "brewlm-notebook",
    version: 1,
    created_at: 1,
    notebook: { title: "T", description: "", cover: COVER, chat_bg: "", chat_bg_dim: 55, grounded: 1, constitution_on: 1 },
    sources: [
      { id: "s1", notebook_id: "nb", type: "audio", title: "A", content: A, mime: null, text: "", pinned: 0, created_at: 1 },
      { id: "s2", notebook_id: "nb", type: "pdf", title: "B", content: B, mime: null, text: "", pinned: 0, created_at: 2 },
    ],
    chunks: [],
    artifacts: [],
    chats: [],
    messages: [],
    images: [],
  }),
}));

import { decryptBlob } from "./vaultCrypto";
import {
  fromBase64Url,
  gunzip,
  MANIFEST_ID,
  parseShareUrl,
  publishShare,
  shareAppUrl,
  shareFileId,
  shareKeys,
  shareUrl,
  toBase64Url,
  type ShareManifest,
} from "./shareLinks";

const opts = { includeChats: false, includeMedia: true, sharedBy: " Sam ", expiresAt: null };

beforeEach(() => {
  calls.length = 0;
  rows.length = 0;
  manifestConflicts = 0;
  stored = null;
});

describe("links", () => {
  it("round-trips a link's id and key", () => {
    const key = new Uint8Array(32).map((_, i) => i * 7);
    const url = shareUrl({ id: "0123456789abcdef0123456789abcdef", share_key: toBase64Url(key) });
    expect(url).toMatch(/\/s\/0123456789abcdef0123456789abcdef#[A-Za-z0-9_-]{43}$/);
    const parsed = parseShareUrl(`  ${url}  `)!;
    expect(parsed.id).toBe("0123456789abcdef0123456789abcdef");
    expect([...parsed.secret]).toEqual([...key]);
  });

  it("points links at the web app that reads from the same server", () => {
    expect(shareAppUrl("https://sync.brewlm.com")).toBe("https://app.brewlm.com");
    expect(shareAppUrl("https://sync.brewlm.com/")).toBe("https://app.brewlm.com");
    expect(shareAppUrl("http://127.0.0.1:8787")).toBe("http://localhost:1430");
  });

  it("rejects things that aren't links", () => {
    expect(parseShareUrl("https://app.brewlm.com/s/xyz#abc")).toBeNull();
    expect(parseShareUrl("https://app.brewlm.com/s/0123456789abcdef0123456789abcdef")).toBeNull();
    expect(fromBase64Url("not base64!")).toBeNull();
  });
});

describe("publishShare", () => {
  it("uploads missing files, then an encrypted manifest a viewer can open, then sweeps", async () => {
    const row = await publishShare("nb", opts);
    expect(row.version).toBe(1);
    expect(row.shared_by).toBe("Sam");

    const keys = await shareKeys(fromBase64Url(row.share_key)!);
    const ids = await Promise.all([COVER, A, B].map((r) => shareFileId(keys, r)));
    // The server already had the first file it was asked about.
    const puts = calls.filter((c) => c.method === "PUT" && c.path.includes("/blobs/")).map((c) => c.path.split("/").pop());
    expect(puts.sort()).toEqual(ids.slice(1).sort());

    const manifest = JSON.parse(await gunzip(await decryptBlob(keys, MANIFEST_ID, stored!))) as ShareManifest;
    expect(manifest.sharedBy).toBe("Sam");
    expect(manifest.files.sort()).toEqual([A, B, COVER].sort());
    expect(manifest.snapshot.sources.map((s) => s.title)).toEqual(["A", "B"]);

    const sweep = calls.find((c) => c.path.endsWith("/sweep"))!;
    expect((sweep.body as { live: string[] }).live.sort()).toEqual(ids.sort());
  });

  it("leaves media out but keeps the cover when asked", async () => {
    await publishShare("nb", { ...opts, includeMedia: false });
    const asked = calls.find((c) => c.path.endsWith("/blobs/missing"))!;
    expect((asked.body as { ids: string[] }).ids).toHaveLength(1);
  });

  it("retries once over another device's update", async () => {
    manifestConflicts = 1;
    const row = await publishShare("nb", opts);
    expect(row.version).toBe(5);
    manifestConflicts = 2;
    await expect(publishShare("nb", opts)).rejects.toThrow(/another device/);
  });
});
