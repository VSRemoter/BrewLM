import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./db", () => ({ getDb: async () => null, uid: () => "" }));

import { MEDIA_NOT_SHARED, omitMedia, remapSnapshot, snapshotBlobRefs, SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type NotebookSnapshot } from "./share";

const AUDIO = `brewblob:${"a".repeat(64)}.m4a`;
const COVER = `brewblob:${"c".repeat(64)}.jpg`;
const PIC = `brewblob:${"d".repeat(64)}.png`;

function snap(): NotebookSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    created_at: 1,
    notebook: { title: "T", description: "", cover: COVER, chat_bg: "", chat_bg_dim: 55, grounded: 1, constitution_on: 1 },
    sources: [
      { id: "s1", notebook_id: "nb", type: "text", title: "One", content: "hello", mime: null, text: "", pinned: 0, created_at: 1 },
      { id: "s2", notebook_id: "nb", type: "audio", title: "Two", content: AUDIO, mime: "audio/mp4", text: "", pinned: 1, created_at: 2 },
    ],
    chunks: [
      { id: "k1", source_id: "s1", notebook_id: "nb", seq: 0, page: null, text: "hello", embedding: "[1,2]" },
      { id: "k2", source_id: "gone", notebook_id: "nb", seq: 0, page: null, text: "x", embedding: "" },
    ],
    artifacts: [
      { id: "a1", notebook_id: "nb", kind: "notes", title: "N", data: "see ![x](brewimg:i1) and ![y](brewimg:other)", pinned: 0, created_at: 3 },
    ],
    chats: [{ id: "c1", notebook_id: "nb", title: "Chat", pinned: 0, created_at: 4, updated_at: 5 }],
    messages: [
      { id: "m1", notebook_id: "nb", chat_id: "c1", role: "assistant", content: "![cat](brewimg:i2)", created_at: 6 },
      { id: "m2", notebook_id: "nb", chat_id: "elsewhere", role: "user", content: "hi", created_at: 7 },
    ],
    images: [
      { id: "i1", notebook_id: "nb", chat_id: "c1", prompt: "", model: "", mime: "image/png", data: PIC, width: 1, height: 1, parent_id: "", created_at: 8 },
      { id: "i2", notebook_id: "old", chat_id: "c9", prompt: "", model: "", mime: "image/png", data: PIC, width: 1, height: 1, parent_id: "i1", created_at: 9 },
    ],
  };
}

function counter() {
  let n = 0;
  return () => `new${++n}`;
}

describe("remapSnapshot", () => {
  const original = snap();
  const out = remapSnapshot(original, "NB", counter());
  const allIds = [out.sources, out.chunks, out.artifacts, out.chats, out.messages, out.images].flat().map((r) => r.id);

  it("gives every row a fresh, unique id under the new notebook", () => {
    expect(allIds.every((id) => id.startsWith("new"))).toBe(true);
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const r of [out.sources, out.chunks, out.artifacts, out.chats, out.messages, out.images].flat())
      expect(r.notebook_id).toBe("NB");
  });

  it("keeps chunks with their source and drops chunks of missing sources", () => {
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].source_id).toBe(out.sources[0].id);
    expect(out.chunks[0].embedding).toBe("[1,2]");
  });

  it("points messages and images at the copied chats, clearing outside links", () => {
    expect(out.messages[0].chat_id).toBe(out.chats[0].id);
    expect(out.messages[1].chat_id).toBeNull();
    expect(out.images[0].chat_id).toBe(out.chats[0].id);
    expect(out.images[1].chat_id).toBe("");
    expect(out.images[1].parent_id).toBe(out.images[0].id);
  });

  it("rewrites image references it copied and leaves the rest alone", () => {
    expect(out.messages[0].content).toBe(`![cat](brewimg:${out.images[1].id})`);
    expect(out.artifacts[0].data).toBe(`see ![x](brewimg:${out.images[0].id}) and ![y](brewimg:other)`);
  });

  it("keeps order, content and the original snapshot untouched", () => {
    expect(out.sources.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(out.sources[1].content).toBe(AUDIO);
    expect(out.sources[1].pinned).toBe(1);
    expect(original).toEqual(snap());
  });
});

describe("snapshotBlobRefs", () => {
  it("lists each media file once", () => {
    expect(snapshotBlobRefs(snap()).sort()).toEqual([AUDIO, COVER, PIC].sort());
  });
});

describe("omitMedia", () => {
  it("marks files the owner left out and keeps the ones that came", () => {
    const s = snap();
    s.artifacts.push({ id: "a2", notebook_id: "nb", kind: "audio", title: "Pod", data: JSON.stringify({ audio: AUDIO, script: [{ speaker: "Alex", text: "Hi" }] }), pinned: 0, created_at: 4 });
    const out = omitMedia(s, new Set([COVER]));
    expect(out.notebook.cover).toBe(COVER);
    expect(out.sources[0].content).toBe("hello");
    expect(out.sources[1].content).toBe(MEDIA_NOT_SHARED);
    const pod = JSON.parse(out.artifacts[1].data);
    expect(pod.audio).toBeNull();
    expect(pod.script).toHaveLength(1);
    expect(out.images).toHaveLength(0);

    const all = omitMedia(s, new Set([AUDIO, COVER, PIC]));
    expect(all.sources[1].content).toBe(AUDIO);
    expect(all.images).toHaveLength(2);
    expect(all.artifacts[1].data).toBe(s.artifacts[1].data);
  });
});
