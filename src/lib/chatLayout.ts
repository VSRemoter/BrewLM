/**
 * How a notebook arranges its side-by-side chats: a small split tree, like a
 * code editor's split panes. A leaf is a pane id; a split lays its children
 * out in a row (side by side) or a column (stacked), each taking a share
 * (`sizes`, summing to 1) of the space. With at most three chats the tree is
 * never more than two levels deep, but nothing here depends on that.
 */

export type Edge = "left" | "right" | "top" | "bottom";
export type Split = { dir: "row" | "col"; sizes: number[]; children: LayoutNode[] };
export type LayoutNode = string | Split;
/** Fractions of the chat area (0–1). */
export type Rect = { x: number; y: number; w: number; h: number };
export type Divider = {
  /** Child indexes from the root down to the split this divider belongs to. */
  path: number[];
  /** Between children `index` and `index + 1`. */
  index: number;
  dir: "row" | "col";
  /** Where it sits along the split's direction (x for rows, y for columns). */
  at: number;
  /** The split's own area. */
  span: Rect;
};

/** Ready-made arrangements, by name. */
export type Preset = "cols" | "rows" | "top2" | "bottom2" | "left1" | "right1";

const clone = (n: LayoutNode): LayoutNode =>
  typeof n === "string" ? n : { dir: n.dir, sizes: [...n.sizes], children: n.children.map(clone) };
const equalSizes = (k: number) => Array.from({ length: k }, () => 1 / k);
const normSizes = (s: number[]) => {
  const total = s.reduce((a, b) => a + b, 0);
  return total > 0 ? s.map((v) => v / total) : equalSizes(s.length);
};
const dirOf = (e: Edge): Split["dir"] => (e === "left" || e === "right" ? "row" : "col");
const isAfter = (e: Edge) => e === "right" || e === "bottom";

/** Pane ids in reading order (left to right, top to bottom). */
export function leaves(n: LayoutNode | null): string[] {
  if (n === null) return [];
  return typeof n === "string" ? [n] : n.children.flatMap(leaves);
}

/** A stored value that really is a layout tree. */
export function isLayoutNode(v: unknown): v is LayoutNode {
  if (typeof v === "string") return true;
  const s = v as Split;
  return (
    !!s &&
    (s.dir === "row" || s.dir === "col") &&
    Array.isArray(s.children) &&
    Array.isArray(s.sizes) &&
    s.children.length === s.sizes.length &&
    s.sizes.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) &&
    s.children.every(isLayoutNode)
  );
}

type Loose = string | null | { dir: Split["dir"]; sizes: number[]; children: Loose[] };

/**
 * Drop removed panes (nulls), collapse a split left with one child, and fold
 * a split into a parent going the same way (sizes multiply through).
 */
function tidy(n: Loose): LayoutNode | null {
  if (n === null || typeof n === "string") return n;
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const t = tidy(c);
    if (t === null) return;
    const share = n.sizes[i] ?? 1 / n.children.length;
    if (typeof t !== "string" && t.dir === n.dir) {
      t.children.forEach((g, j) => {
        kids.push(g);
        sizes.push(share * t.sizes[j]);
      });
    } else {
      kids.push(t);
      sizes.push(share);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { dir: n.dir, sizes: normSizes(sizes), children: kids };
}

function strip(n: LayoutNode, keep: (id: string) => boolean): Loose {
  if (typeof n === "string") return keep(n) ? n : null;
  return { dir: n.dir, sizes: n.sizes, children: n.children.map((c) => strip(c, keep)) };
}

export function removeLeaf(n: LayoutNode, id: string): LayoutNode | null {
  return tidy(strip(n, (x) => x !== id));
}

/** Put `id` at the end of the root, side by side with what's there. */
export function appendLeaf(n: LayoutNode | null, id: string): LayoutNode {
  if (n === null) return id;
  if (typeof n !== "string" && n.dir === "row") {
    const t = clone(n) as Split;
    t.children.push(id);
    t.sizes = equalSizes(t.children.length);
    return t;
  }
  return { dir: "row", sizes: [0.5, 0.5], children: [clone(n), id] };
}

/**
 * Put `id` on one edge of the `target` pane. Joining a row or column that
 * already goes that way shares its space out evenly; otherwise the target
 * pane splits in half.
 */
export function insertLeaf(n: LayoutNode, id: string, target: string, edge: Edge): LayoutNode {
  const dir = dirOf(edge);
  const pair: Split = { dir, sizes: [0.5, 0.5], children: isAfter(edge) ? [target, id] : [id, target] };
  if (n === target) return pair;
  const t = clone(n);
  const walk = (s: Split): boolean => {
    const i = s.children.indexOf(target);
    if (i >= 0) {
      if (s.dir === dir) {
        s.children.splice(i + (isAfter(edge) ? 1 : 0), 0, id);
        s.sizes = equalSizes(s.children.length);
      } else {
        s.children[i] = pair;
      }
      return true;
    }
    return s.children.some((c) => typeof c !== "string" && walk(c));
  };
  if (typeof t === "string" || !walk(t)) return appendLeaf(n, id);
  return t;
}

/** Move pane `id` onto an edge of `target`. */
export function moveLeaf(n: LayoutNode, id: string, target: string, edge: Edge): LayoutNode {
  if (id === target) return n;
  const rest = removeLeaf(n, id);
  return rest === null ? id : insertLeaf(rest, id, target, edge);
}

/** Trade the places of two panes. */
export function swapLeaves(n: LayoutNode, a: string, b: string): LayoutNode {
  if (typeof n === "string") return n === a ? b : n === b ? a : n;
  return { dir: n.dir, sizes: [...n.sizes], children: n.children.map((c) => swapLeaves(c, a, b)) };
}

/**
 * Make the tree hold exactly `ids`: panes that closed leave, new ones join at
 * the end of the root. (Saved layouts and pane lists can drift apart.)
 */
export function normalizeLayout(n: LayoutNode | null, ids: string[]): LayoutNode | null {
  const seen = new Set<string>();
  let t =
    n === null
      ? null
      : tidy(
          strip(n, (x) => {
            if (!ids.includes(x) || seen.has(x)) return false;
            seen.add(x);
            return true;
          })
        );
  for (const id of ids) if (!seen.has(id)) t = appendLeaf(t, id);
  return t;
}

/** Each pane's area and each divider's place, as fractions of the chat area. */
export function layoutRects(
  n: LayoutNode,
  r: Rect = { x: 0, y: 0, w: 1, h: 1 },
  path: number[] = [],
  out: { panes: { id: string; rect: Rect }[]; dividers: Divider[] } = { panes: [], dividers: [] }
) {
  if (typeof n === "string") {
    out.panes.push({ id: n, rect: r });
    return out;
  }
  let off = 0;
  n.children.forEach((c, i) => {
    const s = n.sizes[i];
    const cr =
      n.dir === "row"
        ? { x: r.x + off * r.w, y: r.y, w: s * r.w, h: r.h }
        : { x: r.x, y: r.y + off * r.h, w: r.w, h: s * r.h };
    layoutRects(c, cr, [...path, i], out);
    off += s;
    if (i < n.children.length - 1)
      out.dividers.push({ path, index: i, dir: n.dir, at: n.dir === "row" ? r.x + off * r.w : r.y + off * r.h, span: r });
  });
  return out;
}

/**
 * Drag a divider: children `index` and `index + 1` of the split at `path`
 * trade `delta` (a fraction of that split), neither going under `min`.
 */
export function resizeAt(n: LayoutNode, path: number[], index: number, delta: number, min: number): LayoutNode {
  const t = clone(n);
  let s: LayoutNode = t;
  for (const i of path) {
    if (typeof s === "string") return n;
    s = s.children[i];
  }
  if (typeof s === "string" || index + 1 >= s.sizes.length) return n;
  const a = s.sizes[index];
  const b = s.sizes[index + 1];
  const lo = Math.min(0, min - a);
  const hi = Math.max(0, b - min);
  const d = Math.max(lo, Math.min(hi, delta));
  s.sizes[index] = a + d;
  s.sizes[index + 1] = b - d;
  return t;
}

const row = (...children: LayoutNode[]): Split => ({ dir: "row", sizes: equalSizes(children.length), children });
const col = (...children: LayoutNode[]): Split => ({ dir: "col", sizes: equalSizes(children.length), children });

export const PRESETS: Record<Preset, { label: string; build: (ids: string[]) => LayoutNode }> = {
  cols: { label: "Side by side", build: (ids) => row(...ids) },
  rows: { label: "Stacked", build: (ids) => col(...ids) },
  top2: { label: "Two on top, one wide below", build: ([a, b, c]) => col(row(a, b), c) },
  bottom2: { label: "One wide on top, two below", build: ([a, b, c]) => col(a, row(b, c)) },
  left1: { label: "One tall on the left", build: ([a, b, c]) => row(a, col(b, c)) },
  right1: { label: "One tall on the right", build: ([a, b, c]) => row(col(a, b), c) },
};

/** The arrangements that make sense for this many chats. */
export function presetsFor(count: number): Preset[] {
  if (count === 2) return ["cols", "rows"];
  if (count === 3) return ["cols", "rows", "top2", "bottom2", "left1", "right1"];
  return [];
}

const shape = (n: LayoutNode): string => (typeof n === "string" ? "." : `${n.dir}(${n.children.map(shape).join(",")})`);

/** Which preset this layout is, sizes aside. */
export function presetOf(n: LayoutNode | null): Preset | null {
  const ids = leaves(n);
  if (n === null || ids.length < 2) return null;
  return presetsFor(ids.length).find((p) => shape(PRESETS[p].build(ids)) === shape(n)) ?? null;
}

/** Where a pane dragged over `rect` would land, from the pointer's place inside it (0–1). */
export function dropZone(rx: number, ry: number): Edge | "center" {
  const edges: [Edge, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  const [edge, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return dist > 0.3 ? "center" : edge;
}

/** The part of a pane a drop zone covers, for the highlight. */
export function zoneRect(r: Rect, zone: Edge | "center"): Rect {
  switch (zone) {
    case "left":
      return { ...r, w: r.w / 2 };
    case "right":
      return { ...r, x: r.x + r.w / 2, w: r.w / 2 };
    case "top":
      return { ...r, h: r.h / 2 };
    case "bottom":
      return { ...r, y: r.y + r.h / 2, h: r.h / 2 };
    default:
      return r;
  }
}
