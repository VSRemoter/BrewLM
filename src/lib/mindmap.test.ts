import { describe, expect, it } from "vitest";
import {
  findNode,
  insertNode,
  layoutMindmap,
  makeNode,
  parseMindmap,
  removeNode,
  serializeMindmap,
  updateNode,
} from "./mindmap";

const OUTLINE = `- Biological Psychology: How biology shapes behaviour
  - Neurophysiology
    - Threshold: Voltage trigger point
    - **Repolarization**: K+ efflux
  - Mind-Brain Problem
    - Monism — Mind and brain are inseparable`;

describe("parseMindmap", () => {
  it("splits labels from definitions", () => {
    const root = parseMindmap(OUTLINE, "Title")!;
    expect(root.label).toBe("Biological Psychology");
    expect(root.note).toBe("How biology shapes behaviour");
    const [neuro, mind] = root.children;
    expect(neuro.label).toBe("Neurophysiology");
    expect(neuro.note).toBe("");
    expect(neuro.children.map((c) => [c.label, c.note])).toEqual([
      ["Threshold", "Voltage trigger point"],
      ["Repolarization", "K+ efflux"],
    ]);
    expect(mind.children[0]).toMatchObject({ label: "Monism", note: "Mind and brain are inseparable" });
  });

  it("gives older multi-branch outlines the title as their centre", () => {
    const root = parseMindmap("- A\n    - A1\n- B", "My map")!;
    expect(root.label).toBe("My map");
    expect(root.children.map((c) => c.label)).toEqual(["A", "B"]);
    expect(root.children[0].children[0].label).toBe("A1");
  });

  it("returns null when there is no outline", () => {
    expect(parseMindmap("just text", "x")).toBeNull();
  });
});

describe("serializeMindmap", () => {
  it("round-trips, keeping colons inside labels", () => {
    const root = parseMindmap(OUTLINE, "Title")!;
    const renamed = updateNode(root, root.children[0].id, (n) => ({ ...n, label: "Ratio: 3 to 1" }));
    const again = parseMindmap(serializeMindmap(renamed), "Title")!;
    expect(again.children[0].label.replace(/\u00a0/g, " ")).toBe("Ratio: 3 to 1");
    expect(again.children[0].note).toBe("");
    expect(serializeMindmap(again)).toBe(serializeMindmap(renamed));
  });
});

describe("tree edits", () => {
  it("inserts and removes without touching the original", () => {
    const root = parseMindmap(OUTLINE, "Title")!;
    const added = insertNode(root, root.id, makeNode("New"), 0);
    expect(added.children[0].label).toBe("New");
    expect(root.children[0].label).toBe("Neurophysiology");
    const removed = removeNode(added, added.children[1].id);
    expect(removed.children.map((c) => c.label)).toEqual(["New", "Mind-Brain Problem"]);
    expect(removeNode(root, root.id)).toBe(root);
    expect(findNode(removed, root.children[0].id)).toBeNull();
  });
});

describe("layoutMindmap", () => {
  it("puts each depth in its own column and centres parents on children", () => {
    const root = parseMindmap(OUTLINE, "Title")!;
    const pos = layoutMindmap(root, () => true, () => ({ w: 100, h: 30 }));
    const r = pos.get(root.id)!;
    const [a, b] = root.children.map((c) => pos.get(c.id)!);
    expect(a.x).toBeGreaterThan(r.x + r.w);
    expect(a.x).toBe(b.x);
    expect(b.y).toBeGreaterThan(a.y);
    expect(r.y + r.h / 2).toBeCloseTo((a.y + a.h / 2 + b.y + b.h / 2) / 2, 5);
  });

  it("skips collapsed branches", () => {
    const root = parseMindmap(OUTLINE, "Title")!;
    const pos = layoutMindmap(root, (n) => n.id === root.id, () => ({ w: 100, h: 30 }));
    expect(pos.size).toBe(3);
  });
});
