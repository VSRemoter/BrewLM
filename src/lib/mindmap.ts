/**
 * Mind maps: the stored format is a nested markdown bullet outline, one node
 * per bullet, written "Label: definition" (the definition is optional). That
 * keeps copy, download, "Add to sources" and AI revisions plain text, while
 * the Studio view parses it into a tree it can lay out, edit and save back.
 */

export interface MindNode {
  /** Session-only id — not stored in the outline. */
  id: string;
  label: string;
  /** One-line definition / explanation shown in the details card. */
  note: string;
  children: MindNode[];
}

let seq = 0;
export function newNodeId(): string {
  seq += 1;
  return `n${seq}`;
}

export function makeNode(label: string, note = "", children: MindNode[] = []): MindNode {
  return { id: newNodeId(), label, note, children };
}

/** Strip markdown emphasis the model likes to wrap labels in. */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

/** "Threshold: Voltage trigger point" → label + definition. */
function splitLabel(text: string): { label: string; note: string } {
  const t = plain(text);
  // a plain space only: serialize keeps a label's own ": " joined with a no-break space
  const m = t.match(/^(.+?)(?::[ \t]+| [—–] )(.+)$/);
  if (!m) return { label: t, note: "" };
  return { label: m[1].trim(), note: m[2].trim() };
}

/**
 * Parse an outline into one tree. Indentation is relative (2 spaces, 4 spaces
 * or tabs all work). An outline with several top-level bullets — older maps —
 * gets the artifact title as its central topic.
 */
export function parseMindmap(data: string, title: string): MindNode | null {
  const roots: MindNode[] = [];
  const stack: { node: MindNode; indent: number }[] = [];
  for (const raw of data.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const m = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) {
      // an indented plain line under a bullet continues its definition
      const cont = line.trim();
      const last = stack[stack.length - 1];
      if (cont && last && /^\s+/.test(line) && !/^#/.test(cont)) {
        last.node.note = [last.node.note, plain(cont)].filter(Boolean).join(" ");
      }
      continue;
    }
    const indent = m[1].length;
    const { label, note } = splitLabel(m[2]);
    if (!label) continue;
    const node = makeNode(label, note);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent });
  }
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0];
  return makeNode(title.trim() || "Mind map", "", roots);
}

/** Write the tree back as the stored outline. */
export function serializeMindmap(root: MindNode): string {
  const out: string[] = [];
  const walk = (n: MindNode, depth: number) => {
    // a ": " inside a label would split it on the next load — keep it joined
    const label = n.label.replace(/\s+/g, " ").trim().replace(/:\s/g, ": ") || "Untitled";
    const note = n.note.replace(/\s+/g, " ").trim();
    out.push(`${"  ".repeat(depth)}- ${label}${note ? `: ${note}` : ""}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out.join("\n");
}

/* ------------------------------- tree edits ------------------------------- */

/** Ancestors of `id`, root first, ending with the node itself (empty if absent). */
export function pathTo(root: MindNode, id: string): MindNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const p = pathTo(c, id);
    if (p.length) return [root, ...p];
  }
  return [];
}

export function findNode(root: MindNode, id: string): MindNode | null {
  const p = pathTo(root, id);
  return p.length ? p[p.length - 1] : null;
}

/** Copy-on-write update of one node. */
export function updateNode(root: MindNode, id: string, fn: (n: MindNode) => MindNode): MindNode {
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const next = updateNode(c, id, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** Insert `node` under `parentId` at `index` (default: last). */
export function insertNode(root: MindNode, parentId: string, node: MindNode, index?: number): MindNode {
  return updateNode(root, parentId, (p) => {
    const children = [...p.children];
    children.splice(index ?? children.length, 0, node);
    return { ...p, children };
  });
}

/** Remove a node and its branch. The root can't be removed. */
export function removeNode(root: MindNode, id: string): MindNode {
  if (root.id === id) return root;
  const idx = root.children.findIndex((c) => c.id === id);
  if (idx >= 0) return { ...root, children: root.children.filter((c) => c.id !== id) };
  let changed = false;
  const children = root.children.map((c) => {
    const next = removeNode(c, id);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function countNodes(n: MindNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/* --------------------------------- layout --------------------------------- */

export interface Size {
  w: number;
  h: number;
}

export interface Placed extends Size {
  x: number;
  y: number;
  depth: number;
}

/** Room between a parent's right edge and its children's column (holds the toggle). */
export const COL_GAP = 76;
export const ROW_GAP = 12;

/**
 * Left-to-right tree: one column per depth (as wide as its widest node), each
 * parent centred on its visible children. Collapsed branches take no space.
 */
export function layoutMindmap(
  root: MindNode,
  isOpen: (n: MindNode) => boolean,
  sizeOf: (n: MindNode) => Size
): Map<string, Placed> {
  const colW: number[] = [];
  const kidsOf = (n: MindNode) => (isOpen(n) ? n.children : []);
  const widths = (n: MindNode, d: number) => {
    colW[d] = Math.max(colW[d] ?? 0, sizeOf(n).w);
    for (const c of kidsOf(n)) widths(c, d + 1);
  };
  widths(root, 0);
  const colX: number[] = [0];
  for (let d = 1; d < colW.length; d++) colX[d] = colX[d - 1] + colW[d - 1] + COL_GAP;

  const blockH = new Map<string, number>();
  const measure = (n: MindNode): number => {
    const kids = kidsOf(n);
    const kidsH = kids.reduce((s, c) => s + measure(c), 0) + Math.max(0, kids.length - 1) * ROW_GAP;
    const h = Math.max(sizeOf(n).h, kidsH);
    blockH.set(n.id, h);
    return h;
  };
  measure(root);

  const out = new Map<string, Placed>();
  const place = (n: MindNode, d: number, top: number) => {
    const { w, h } = sizeOf(n);
    const block = blockH.get(n.id) ?? h;
    const kids = kidsOf(n);
    const kidsH = kids.reduce((s, c) => s + (blockH.get(c.id) ?? 0), 0) + Math.max(0, kids.length - 1) * ROW_GAP;
    let y = top + (block - kidsH) / 2;
    for (const c of kids) {
      place(c, d + 1, y);
      y += (blockH.get(c.id) ?? 0) + ROW_GAP;
    }
    // centre on the first and last child nodes (not their whole branches), within its own block
    let ny = top + (block - h) / 2;
    if (kids.length) {
      const a = out.get(kids[0].id)!, b = out.get(kids[kids.length - 1].id)!;
      const mid = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
      ny = Math.min(top + block - h, Math.max(top, mid - h / 2));
    }
    out.set(n.id, { x: colX[d], y: ny, w, h, depth: d });
  };
  place(root, 0, 0);
  return out;
}
