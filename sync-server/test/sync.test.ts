import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const DEV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTH = { authorization: "Bearer test-token" };

const hlc = (ms: number, device: string, counter = 0) =>
  `${String(ms).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;

function push(vault: string, device: string, changes: unknown[], headers: Record<string, string> = AUTH) {
  return exports.default.fetch(`https://sync.test/v1/vaults/${vault}/push`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ device, changes }),
  });
}

async function pull(vault: string, since = 0, limit?: number) {
  const q = new URLSearchParams({ since: String(since), ...(limit ? { limit: String(limit) } : {}) });
  const res = await exports.default.fetch(`https://sync.test/v1/vaults/${vault}/pull?${q}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    changes: { key: string; seq: number; hlc: string; device: string; payload: string }[];
    cursor: number;
    more: boolean;
  };
}

describe("auth and validation", () => {
  it("rejects a missing or wrong token", async () => {
    expect((await push("v1", DEV_A, [], {})).status).toBe(401);
    expect((await push("v1", DEV_A, [], { authorization: "Bearer nope-token" })).status).toBe(401);
  });

  it("rejects malformed input", async () => {
    expect((await push("v1", "not-a-uuid", [])).status).toBe(400);
    expect((await push("v1", DEV_A, [{ key: "k", hlc: "123", payload: "x" }])).status).toBe(400);
    expect((await push("Bad_Vault", DEV_A, [])).status).toBe(400);
    const big = { key: "k", hlc: hlc(1, DEV_A), payload: "x".repeat(1_500_001) };
    expect((await push("v1", DEV_A, [big])).status).toBe(400);
  });
});

describe("web app access (CORS)", () => {
  const APP = "https://app.brewlm.com";

  it("answers preflights only for allowed origins", async () => {
    const pre = (origin: string) =>
      exports.default.fetch("https://sync.test/v1/vaults/v1/push", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
    const ok = await pre(APP);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-methods")).toContain("PUT");
    const bad = await pre("https://evil.example");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("labels responses, errors included, for allowed origins only", async () => {
    const res = await push("v1", DEV_A, [], { ...AUTH, origin: APP });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("vary")).toContain("Origin");
    const unauthorized = await push("v1", DEV_A, [], { origin: APP });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe(APP);
    const other = await push("v1", DEV_A, [], { ...AUTH, origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const desktop = await push("v1", DEV_A, [], AUTH);
    expect(desktop.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("push and pull", () => {
  it("returns changes in order with a cursor and paging", async () => {
    const res = await push("v2", DEV_A, [
      { key: "notebooks:1", hlc: hlc(1000, DEV_A), payload: "a" },
      { key: "notebooks:2", hlc: hlc(1001, DEV_A), payload: "b" },
      { key: "notebooks:3", hlc: hlc(1002, DEV_A), payload: "c" },
    ]);
    expect(await res.json()).toEqual({ accepted: 3, stale: [], cursor: 3 });

    const page1 = await pull("v2", 0, 2);
    expect(page1.changes.map((c) => c.key)).toEqual(["notebooks:1", "notebooks:2"]);
    expect(page1.more).toBe(true);
    const page2 = await pull("v2", page1.cursor, 2);
    expect(page2.changes.map((c) => c.payload)).toEqual(["c"]);
    expect(page2.more).toBe(false);
    expect(page2.changes[0].device).toBe(DEV_A);
    expect((await pull("v2", page2.cursor)).changes).toEqual([]);
  });

  it("keeps the newest version per key (last writer wins on HLC)", async () => {
    await push("v3", DEV_A, [{ key: "chats:x", hlc: hlc(2000, DEV_A), payload: "from A" }]);
    const { cursor } = await pull("v3");

    // An older edit from B loses and is reported stale.
    const older = await push("v3", DEV_B, [{ key: "chats:x", hlc: hlc(1999, DEV_B), payload: "old B" }]);
    expect(((await older.json()) as { stale: string[] }).stale).toEqual(["chats:x"]);

    // A newer edit replaces it and moves to a new seq, so devices past the old cursor see it.
    await push("v3", DEV_B, [{ key: "chats:x", hlc: hlc(2001, DEV_B), payload: "new B" }]);
    const after = await pull("v3", cursor);
    expect(after.changes).toHaveLength(1);
    expect(after.changes[0]).toMatchObject({ payload: "new B", device: DEV_B });

    // A fresh device sees only the current version.
    const full = await pull("v3");
    expect(full.changes.map((c) => c.payload)).toEqual(["new B"]);
  });

  it("ties on time are broken by device id, the same way everywhere", async () => {
    await push("v4", DEV_B, [{ key: "k", hlc: hlc(5000, DEV_B), payload: "B" }]);
    const res = await push("v4", DEV_A, [{ key: "k", hlc: hlc(5000, DEV_A), payload: "A" }]);
    expect(((await res.json()) as { stale: string[] }).stale).toEqual(["k"]);
  });

  it("keeps vaults apart", async () => {
    await push("v5", DEV_A, [{ key: "k", hlc: hlc(1, DEV_A), payload: "mine" }]);
    expect((await pull("v6")).changes).toEqual([]);
  });
});

describe("blobs", () => {
  const blob = (vault: string, id: string, init?: RequestInit) =>
    exports.default.fetch(`https://sync.test/v1/vaults/${vault}/blobs/${id}`, {
      ...init,
      headers: { ...AUTH, ...(init?.headers ?? {}) },
    });
  const missing = async (vault: string, ids: string[]) =>
    (
      (await (
        await exports.default.fetch(`https://sync.test/v1/vaults/${vault}/blobs/missing`, {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        })
      ).json()) as { missing: string[] }
    ).missing;

  it("stores, reports and returns files per vault", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(await missing("b1", ["abc.m4a", "def.jpg"])).toEqual(["abc.m4a", "def.jpg"]);
    const put = await blob("b1", "abc.m4a", { method: "PUT", body: bytes, headers: { "content-length": "5" } });
    expect(put.status).toBe(204);
    expect(await missing("b1", ["abc.m4a", "def.jpg"])).toEqual(["def.jpg"]);

    const got = await blob("b1", "abc.m4a");
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    // Another vault can't see it.
    expect((await blob("b2", "abc.m4a")).status).toBe(404);
    expect(await missing("b2", ["abc.m4a"])).toEqual(["abc.m4a"]);
  });

  it("guards ids and auth", async () => {
    expect((await blob("b1", "..%2Fsecret")).status).toBe(400);
    const res = await exports.default.fetch("https://sync.test/v1/vaults/b1/blobs/abc.m4a");
    expect(res.status).toBe(401);
  });
});

describe("key envelope", () => {
  const keys = (vault: string, init?: RequestInit) =>
    exports.default.fetch(`https://sync.test/v1/vaults/${vault}/keys`, {
      ...init,
      headers: { ...AUTH, "content-type": "application/json" },
    });
  const put = (vault: string, envelope: string, expectVersion: number) =>
    keys(vault, { method: "PUT", body: JSON.stringify({ envelope, expectVersion }) });

  it("is created once and replaced only from the current version", async () => {
    expect(await (await keys("k1")).json()).toEqual({ envelope: null, version: 0 });
    expect((await put("k1", '{"v":1}', 0)).status).toBe(200);
    // A second device setting up at the same time loses instead of overwriting.
    const clash = await put("k1", '{"v":1,"other":true}', 0);
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ version: 1 });
    expect((await put("k1", '{"v":1,"pw":2}', 1)).status).toBe(200);
    expect(await (await keys("k1")).json()).toEqual({ envelope: '{"v":1,"pw":2}', version: 2 });
  });

  it("rejects junk", async () => {
    expect((await put("k2", "", 0)).status).toBe(400);
    expect((await put("k2", "x".repeat(16 * 1024 + 1), 0)).status).toBe(400);
  });
});

describe("device links", () => {
  const ID = "a".repeat(64);
  const link = (vault: string, path = "", init?: RequestInit) =>
    exports.default.fetch(`https://sync.test/v1/vaults/${vault}/links/${ID}${path}`, {
      ...init,
      headers: { ...AUTH, "content-type": "application/json" },
    });
  const status = async (vault: string) => ((await (await link(vault, "/status")).json()) as { pending: boolean }).pending;

  it("hands the sealed key over exactly once", async () => {
    expect(await status("l1")).toBe(false);
    const put = await link("l1", "", { method: "PUT", body: JSON.stringify({ sealed: "ciphertext" }) });
    expect(put.status).toBe(200);
    expect(await status("l1")).toBe(true);
    const got = await link("l1");
    expect(await got.json()).toEqual({ sealed: "ciphertext" });
    expect((await link("l1")).status).toBe(404); // single use
    expect(await status("l1")).toBe(false);
  });

  it("can be cancelled, and stays inside its vault", async () => {
    await link("l2", "", { method: "PUT", body: JSON.stringify({ sealed: "x" }) });
    expect((await link("l3")).status).toBe(404);
    expect((await link("l2", "", { method: "DELETE" })).status).toBe(204);
    expect((await link("l2")).status).toBe(404);
  });

  it("caps open links and rejects bad ids", async () => {
    for (let i = 0; i < 5; i++) {
      const id = String(i).repeat(64);
      const res = await exports.default.fetch(`https://sync.test/v1/vaults/l4/links/${id}`, {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ sealed: "x" }),
      });
      expect(res.status).toBe(200);
    }
    const sixth = await link("l4", "", { method: "PUT", body: JSON.stringify({ sealed: "x" }) });
    expect(sixth.status).toBe(429);
    const bad = await exports.default.fetch("https://sync.test/v1/vaults/l4/links/not-hex", { headers: AUTH });
    expect(bad.status).toBe(404);
  });
});
