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
