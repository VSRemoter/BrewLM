import { describe, expect, it } from "vitest";
import {
  PRESETS,
  dropZone,
  insertLeaf,
  isLayoutNode,
  layoutRects,
  leaves,
  moveLeaf,
  normalizeLayout,
  presetOf,
  removeLeaf,
  resizeAt,
  swapLeaves,
  type LayoutNode,
} from "./chatLayout";

const third = 1 / 3;

describe("chat layout", () => {
  it("splits a lone pane, then joins the row evenly", () => {
    const two = insertLeaf("a", "b", "a", "right");
    expect(two).toEqual({ dir: "row", sizes: [0.5, 0.5], children: ["a", "b"] });
    const three = insertLeaf(two, "c", "b", "right");
    expect(three).toEqual({ dir: "row", sizes: [third, third, third], children: ["a", "b", "c"] });
  });

  it("splits a pane the other way into a nested column", () => {
    const t = insertLeaf(PRESETS.cols.build(["a", "b"]), "c", "b", "bottom");
    expect(presetOf(t)).toBe("left1");
    expect(leaves(t)).toEqual(["a", "b", "c"]);
  });

  it("inserts before the target on the left or top edge", () => {
    expect(leaves(insertLeaf("a", "b", "a", "left"))).toEqual(["b", "a"]);
    expect(leaves(insertLeaf("a", "b", "a", "top"))).toEqual(["b", "a"]);
  });

  it("collapses a split left with one pane", () => {
    const t = PRESETS.top2.build(["a", "b", "c"]); // col(row(a, b), c)
    const r = removeLeaf(t, "b");
    expect(r).toEqual({ dir: "col", sizes: [0.5, 0.5], children: ["a", "c"] });
    expect(removeLeaf(removeLeaf(r!, "a")!, "c")).toBeNull();
  });

  it("folds same-direction nesting when a pane leaves", () => {
    const t: LayoutNode = { dir: "row", sizes: [0.5, 0.5], children: ["a", { dir: "col", sizes: [0.5, 0.5], children: ["b", { dir: "row", sizes: [0.5, 0.5], children: ["c", "d"] }] }] };
    const r = removeLeaf(t, "b");
    expect(r).toEqual({ dir: "row", sizes: [0.5, 0.25, 0.25], children: ["a", "c", "d"] });
  });

  it("moves three columns into two on top and one wide below", () => {
    const t = moveLeaf(PRESETS.cols.build(["a", "b", "c"]), "c", "a", "bottom");
    // c leaves the row, then a splits: row(col(a, c), b)
    expect(presetOf(t)).toBe("right1");
    expect(leaves(t)).toEqual(["a", "c", "b"]);
    const wide = moveLeaf(PRESETS.cols.build(["a", "b"]), "a", "b", "top");
    expect(presetOf(wide)).toBe("rows");
  });

  it("swaps two panes", () => {
    expect(leaves(swapLeaves(PRESETS.left1.build(["a", "b", "c"]), "a", "c"))).toEqual(["c", "b", "a"]);
  });

  it("keeps a saved layout in step with the open panes", () => {
    const saved = PRESETS.top2.build(["a", "b", "c"]);
    expect(normalizeLayout(saved, ["a", "b", "c"])).toEqual(saved);
    expect(normalizeLayout(saved, ["a", "c"])).toEqual({ dir: "col", sizes: [0.5, 0.5], children: ["a", "c"] });
    expect(leaves(normalizeLayout(saved, ["a", "c", "d"]))).toEqual(["a", "c", "d"]);
    expect(normalizeLayout(null, ["a"])).toBe("a");
    expect(normalizeLayout(null, [])).toBeNull();
  });

  it("lays out areas and dividers", () => {
    const { panes, dividers } = layoutRects(PRESETS.bottom2.build(["a", "b", "c"]));
    expect(panes).toEqual([
      { id: "a", rect: { x: 0, y: 0, w: 1, h: 0.5 } },
      { id: "b", rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
      { id: "c", rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    ]);
    expect(dividers.map((d) => [d.dir, d.at, d.path])).toEqual([
      ["col", 0.5, []],
      ["row", 0.5, [1]],
    ]);
  });

  it("resizes within limits", () => {
    const t = PRESETS.cols.build(["a", "b"]);
    const sizes = (d: number) => (resizeAt(t, [], 0, d, 0.2) as { sizes: number[] }).sizes.map((x) => +x.toFixed(6));
    expect(sizes(0.2)).toEqual([0.7, 0.3]);
    expect(sizes(0.9)).toEqual([0.8, 0.2]);
    expect(sizes(-0.9)).toEqual([0.2, 0.8]);
  });

  it("names presets and drop zones", () => {
    for (const p of ["cols", "rows", "top2", "bottom2", "left1", "right1"] as const)
      expect(presetOf(PRESETS[p].build(["a", "b", "c"]))).toBe(p);
    expect(presetOf("a")).toBeNull();
    expect(dropZone(0.1, 0.5)).toBe("left");
    expect(dropZone(0.5, 0.95)).toBe("bottom");
    expect(dropZone(0.5, 0.5)).toBe("center");
  });

  it("rejects malformed saved layouts", () => {
    expect(isLayoutNode({ dir: "row", sizes: [1], children: ["a", "b"] })).toBe(false);
    expect(isLayoutNode({ dir: "diag", sizes: [], children: [] })).toBe(false);
    expect(isLayoutNode(PRESETS.top2.build(["a", "b", "c"]))).toBe(true);
  });
});
