/**
 * Studio → Mind map: an interactive canvas. Branches open and close from the
 * toggle beside each node; drag to move around, pinch / ⌘-scroll or the
 * toolbar to zoom. Click a node for its definition, double-click to edit;
 * add, rename and delete nodes (with undo). Edits save back to the stored
 * markdown outline as you go.
 */
import {
  ChevronLeft,
  CornerDownRight,
  FoldHorizontal,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Redo2,
  Scan,
  TextQuote,
  Trash2,
  Undo2,
  UnfoldHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { updateArtifact } from "../lib/db";
import {
  countNodes,
  findNode,
  insertNode,
  layoutMindmap,
  makeNode,
  parseMindmap,
  pathTo,
  removeNode,
  serializeMindmap,
  updateNode,
  type MindNode,
  type Placed,
  type Size,
} from "../lib/mindmap";

/** Edit-to-disk delay. */
const SAVE_DELAY_MS = 500;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const NODE_MAX_W = 240;
/** Stand-in size until a node has been measured (a frame, at most). */
const EST: Size = { w: 140, h: 32 };
/** The open/close toggle: diameter and gap from its node. */
const TOGGLE = 20;
const TOGGLE_GAP = 6;
const HISTORY_MAX = 100;

/** Branch colour per depth, blended into the theme's surfaces. */
const HUES = ["#8b7cf6", "#7c8cf6", "#2fae94", "#d69a2d", "#d9729a", "#4aa3d8"];
function hue(depth: number): string {
  return depth < HUES.length ? HUES[depth] : HUES[2 + ((depth - 2) % (HUES.length - 2))];
}

interface View {
  x: number;
  y: number;
  z: number;
}

const clampZ = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Open the root and its branches on first view; deeper levels start closed. */
function initialOpen(root: MindNode | null): Set<string> {
  const open = new Set<string>();
  const walk = (n: MindNode, d: number) => {
    if (d < 2 && n.children.length) open.add(n.id);
    for (const c of n.children) walk(c, d + 1);
  };
  if (root) walk(root, 0);
  return open;
}

function allParents(root: MindNode): Set<string> {
  const open = new Set<string>();
  const walk = (n: MindNode) => {
    if (n.children.length) open.add(n.id);
    n.children.forEach(walk);
  };
  walk(root);
  return open;
}

export default function MindmapView({
  artifactId,
  title,
  data,
  onSaved,
}: {
  artifactId: string;
  title: string;
  data: string;
  /** After each save, so the Studio list (copy, download…) sees the edit. */
  onSaved?: () => void;
}) {
  const [tree, setTree] = useState<MindNode | null>(() => parseMindmap(data, title));
  const [past, setPast] = useState<MindNode[]>([]);
  const [future, setFuture] = useState<MindNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(tree));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; isNew: boolean } | null>(null);
  const [showDefs, setShowDefs] = useState(false);
  const [full, setFull] = useState(false);
  const [view, setView] = useState<View>({ x: 24, y: 24, z: 1 });
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map());
  const [dragging, setDragging] = useState(false);
  const [vp, setVp] = useState<HTMLDivElement | null>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  /** Pinned screen point for a node while the layout around it changes. */
  const anchor = useRef<{ id: string; sx: number; sy: number } | null>(null);
  const reveal = useRef<string | null>(null);
  const pendingFit = useRef(true);

  /* ---------------------------------- saving --------------------------------- */

  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  /** Outlines this view wrote — their echo back through props isn't an outside change. */
  const ours = useRef(new Set<string>([data]));
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = pending.current;
    pending.current = null;
    if (d === null) return;
    ours.current.add(d);
    try {
      await updateArtifact(artifactId, d);
      setStatus("saved");
      onSavedRef.current?.();
    } catch {
      setStatus("error");
    }
  }, [artifactId]);

  const queueSave = (t: MindNode) => {
    pending.current = serializeMindmap(t);
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  useEffect(() => () => void flush(), [flush]);

  // A revision ("Replace original") or a synced edit from another device.
  useEffect(() => {
    if (ours.current.has(data)) return;
    ours.current = new Set([data]);
    const t = parseMindmap(data, title);
    setTree(t);
    setOpen(initialOpen(t));
    setPast([]);
    setFuture([]);
    setSelected(null);
    setEditing(null);
    pendingFit.current = true;
  }, [data]);

  /* --------------------------------- history --------------------------------- */

  const commit = (next: MindNode) => {
    if (!tree || next === tree) return;
    setPast((p) => [...p.slice(-(HISTORY_MAX - 1)), tree]);
    setFuture([]);
    setTree(next);
    queueSave(next);
  };

  /** `discard`: drop the undone state too (cancelling a node that was just added). */
  const undo = (discard = false) => {
    if (!tree || past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    if (!discard) setFuture([tree, ...future]);
    setTree(prev);
    queueSave(prev);
    setEditing(null);
  };

  const redo = () => {
    if (!tree || future.length === 0) return;
    const [next, ...rest] = future;
    setPast([...past, tree]);
    setFuture(rest);
    setTree(next);
    queueSave(next);
    setEditing(null);
  };

  /* ---------------------------------- layout --------------------------------- */

  const positions = useMemo(
    () =>
      tree
        ? layoutMindmap(tree, (n) => open.has(n.id), (n) => sizes.get(n.id) ?? EST)
        : new Map<string, Placed>(),
    [tree, open, sizes]
  );

  const visible = useMemo(() => {
    const out: { node: MindNode; parent: MindNode | null }[] = [];
    const walk = (n: MindNode, parent: MindNode | null) => {
      out.push({ node: n, parent });
      if (open.has(n.id)) for (const c of n.children) walk(c, n);
    };
    if (tree) walk(tree, null);
    return out;
  }, [tree, open]);

  const anchorOn = (id: string) => {
    const p = positions.get(id);
    if (p) anchor.current = { id, sx: p.x * view.z + view.x, sy: p.y * view.z + view.y };
  };

  /** Fit the visible map; `minZ` keeps first views readable rather than tiny. */
  const fit = (minZ = ZOOM_MIN) => {
    if (!vp || positions.size === 0 || !tree) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of positions.values()) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w + TOGGLE_GAP + TOGGLE);
      y1 = Math.max(y1, p.y + p.h);
    }
    const W = vp.clientWidth, H = vp.clientHeight, pad = 32;
    const bw = x1 - x0, bh = y1 - y0;
    const z = Math.max(minZ, clampZ(Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh, 1)));
    const root = positions.get(tree.id)!;
    setView({
      z,
      x: bw * z <= W - 2 * pad ? (W - bw * z) / 2 - x0 * z : pad - x0 * z,
      y: bh * z <= H - 2 * pad ? (H - bh * z) / 2 - y0 * z : H / 2 - (root.y + root.h / 2) * z,
    });
  };

  // Measure nodes, then — once sizes are settled — apply any pending view move.
  useLayoutEffect(() => {
    let changed = false;
    const next = new Map(sizes);
    for (const [id, el] of nodeEls.current) {
      const w = el.offsetWidth, h = el.offsetHeight;
      const s = sizes.get(id);
      if (!s || s.w !== w || s.h !== h) {
        next.set(id, { w, h });
        changed = true;
      }
    }
    if (changed) {
      setSizes(next);
      return;
    }
    // a fresh viewport (entering/leaving full screen) attaches a render later,
    // and may not have its size yet — the resize observer re-runs this
    if (!vp || !vp.isConnected || vp.clientHeight === 0) return;
    if (pendingFit.current) {
      pendingFit.current = false;
      anchor.current = null;
      fit(0.75);
      return;
    }
    const a = anchor.current;
    if (a) {
      anchor.current = null;
      const p = positions.get(a.id);
      if (p) setView((v) => ({ ...v, x: a.sx - p.x * v.z, y: a.sy - p.y * v.z }));
      return;
    }
    const r = reveal.current;
    if (r) {
      reveal.current = null;
      const p = positions.get(r);
      if (!p) return;
      const pad = 24, W = vp.clientWidth, H = vp.clientHeight;
      setView((v) => {
        const sx = p.x * v.z + v.x, sy = p.y * v.z + v.y;
        const ex = (p.x + p.w + TOGGLE_GAP + TOGGLE) * v.z + v.x, ey = (p.y + p.h) * v.z + v.y;
        let dx = 0, dy = 0;
        if (ex > W - pad) dx = W - pad - ex;
        if (sx + dx < pad) dx = pad - sx;
        // keep clear of the details card along the bottom
        if (ey > H - 150) dy = H - 150 - ey;
        if (sy + dy < 56) dy = 56 - sy;
        return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
      });
    }
  });

  // Re-render (so the effect above re-measures / re-fits) when the viewport
  // gets or changes its size, and once web fonts have loaded.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!vp) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(vp);
    let live = true;
    void document.fonts?.ready.then(() => live && setTick((t) => t + 1));
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [vp]);

  /* --------------------------------- pan & zoom ------------------------------- */

  const viewRef = useRef(view);
  viewRef.current = view;

  /** Event point in the viewport's own (unzoomed) pixels — the app applies CSS zoom. */
  const local = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (!vp) return { x: 0, y: 0, k: 1 };
      const r = vp.getBoundingClientRect();
      const k = r.width ? vp.clientWidth / r.width : 1;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
    },
    [vp]
  );

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const z = clampZ(v.z * factor);
      const s = z / v.z;
      return { z, x: px - (px - v.x) * s, y: py - (py - v.y) * s };
    });
  }, []);

  const zoomCenter = (factor: number) => {
    if (vp) zoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2);
  };

  useEffect(() => {
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // trackpad pinch arrives as ctrl+wheel
        const p = local(e);
        const dy = Math.max(-40, Math.min(40, e.deltaY * unit));
        zoomAt(Math.exp(-dy * 0.01), p.x, p.y);
      } else {
        const { k } = local(e);
        setView((v) => ({ ...v, x: v.x - e.deltaX * unit * k, y: v.y - e.deltaY * unit * k }));
      }
    };
    // WebKit reports pinch as gesture events instead
    let startZ = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      startZ = viewRef.current.z;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const p = local(g);
      zoomAt(clampZ(startZ * g.scale) / viewRef.current.z, p.x, p.y);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener("gesturestart", onGestureStart);
    vp.addEventListener("gesturechange", onGestureChange);
    return () => {
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("gesturestart", onGestureStart);
      vp.removeEventListener("gesturechange", onGestureChange);
    };
  }, [vp, local, zoomAt]);

  /** Drag anywhere to pan; it only becomes a drag past a few pixels, so clicks still land. */
  const drag = useRef<{ x: number; y: number; moved: boolean; pointer: number } | null>(null);
  const justDragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      setDragging(true);
      vp?.setPointerCapture(e.pointerId);
    }
    const { k } = local(e);
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx * k, y: v.y + dy * k }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      setDragging(false);
    }
  };

  /* --------------------------------- actions --------------------------------- */

  const toggle = (id: string) => {
    anchorOn(id);
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const select = (id: string | null) => {
    setSelected(id);
    if (id) reveal.current = id;
  };

  const addChild = (parentId: string) => {
    if (!tree) return;
    const node = makeNode("New idea");
    commit(insertNode(tree, parentId, node));
    setOpen((o) => new Set(o).add(parentId));
    setSelected(node.id);
    setEditing({ id: node.id, isNew: true });
    reveal.current = node.id;
  };

  const addSibling = (id: string) => {
    if (!tree) return;
    const path = pathTo(tree, id);
    if (path.length < 2) return addChild(id);
    const parent = path[path.length - 2];
    const node = makeNode("New idea");
    commit(insertNode(tree, parent.id, node, parent.children.findIndex((c) => c.id === id) + 1));
    setSelected(node.id);
    setEditing({ id: node.id, isNew: true });
    reveal.current = node.id;
  };

  const remove = (id: string) => {
    if (!tree || id === tree.id) return;
    const path = pathTo(tree, id);
    commit(removeNode(tree, id));
    setSelected(path.length >= 2 ? path[path.length - 2].id : null);
    setEditing(null);
    vp?.focus();
  };

  const saveEdit = (id: string, label: string, note: string) => {
    if (!tree) return;
    const isNew = editing?.isNew;
    setEditing(null);
    vp?.focus();
    const l = label.replace(/\s+/g, " ").trim();
    const n = note.replace(/\s+/g, " ").trim();
    if (!l) {
      if (isNew) undo(true);
      return;
    }
    const cur = findNode(tree, id);
    if (!cur || (cur.label === l && cur.note === n)) return;
    // a brand-new node's add and first edit are one undo step
    const next = updateNode(tree, id, (x) => ({ ...x, label: l, note: n }));
    if (isNew) {
      setTree(next);
      queueSave(next);
    } else commit(next);
  };

  const cancelEdit = () => {
    if (editing?.isNew) undo(true);
    setEditing(null);
    vp?.focus();
  };

  const expandAll = () => {
    if (!tree) return;
    anchorOn(selected ?? tree.id);
    setOpen(allParents(tree));
  };
  const collapseAll = () => {
    if (!tree) return;
    anchorOn(tree.id);
    setOpen(new Set([tree.id]));
    if (selected && !tree.children.some((c) => c.id === selected)) setSelected(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!tree || editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "=" || e.key === "+") return zoomCenter(1.2);
    if (e.key === "-") return zoomCenter(1 / 1.2);
    if (e.key === "0") return fit();
    if (e.key === "Escape") {
      if (selected) setSelected(null);
      else if (full) setFull(false);
      return;
    }
    const sel = selected ? findNode(tree, selected) : null;
    if (!sel) {
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        select(tree.id);
      }
      return;
    }
    const path = pathTo(tree, sel.id);
    const parent = path.length >= 2 ? path[path.length - 2] : null;
    const siblings = parent ? parent.children : [sel];
    const i = siblings.findIndex((c) => c.id === sel.id);
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "Tab":
        handled();
        return addChild(sel.id);
      case "Enter":
        handled();
        return addSibling(sel.id);
      case "F2":
        handled();
        return setEditing({ id: sel.id, isNew: false });
      case "Delete":
      case "Backspace":
        handled();
        return remove(sel.id);
      case " ":
        handled();
        if (sel.children.length) toggle(sel.id);
        return;
      case "ArrowLeft":
        handled();
        if (parent) select(parent.id);
        return;
      case "ArrowRight":
        handled();
        if (!sel.children.length) return;
        if (!open.has(sel.id)) toggle(sel.id);
        select(sel.children[0].id);
        return;
      case "ArrowUp":
        handled();
        if (i > 0) select(siblings[i - 1].id);
        return;
      case "ArrowDown":
        handled();
        if (i < siblings.length - 1) select(siblings[i + 1].id);
        return;
    }
  };

  // Esc leaves full screen even when focus is elsewhere (toolbar, card).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key !== "Escape" || e.defaultPrevented || el === vp) return;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
      setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, vp]);

  const toggleFull = () => {
    pendingFit.current = true;
    setFull((f) => !f);
  };

  /* --------------------------------- render ---------------------------------- */

  if (!tree) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[13px] text-ink-3">This mind map has no outline to show.</p>
        <button
          onClick={() => {
            const t = makeNode(title.trim() || "Mind map");
            setTree(t);
            queueSave(t);
            setSelected(t.id);
          }}
          className="rounded-lg border border-edge px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-hover hover:text-ink"
        >
          Start a new map
        </button>
      </div>
    );
  }

  const selNode = selected ? findNode(tree, selected) : null;
  const selPath = selNode ? pathTo(tree, selNode.id) : [];
  const total = countNodes(tree);

  const canvas = (
    <div className={`relative min-h-0 flex-1 ${full ? "" : "h-full"}`}>
      <div
        ref={setVp}
        tabIndex={0}
        role="application"
        aria-label={`Mind map: ${tree.label}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (!justDragged.current && e.target === e.currentTarget) setSelected(null);
        }}
        className="absolute inset-0 select-none overflow-hidden bg-canvas outline-none"
        style={{
          touchAction: "none",
          cursor: dragging ? "grabbing" : "grab",
          backgroundImage: "radial-gradient(var(--color-edge) 1px, transparent 1.3px)",
          backgroundSize: `${20 * view.z}px ${20 * view.z}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div
          className="pointer-events-none absolute left-0 top-0"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }}
        >
          <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
            {visible.map(({ node, parent }) => {
              if (!parent) return null;
              const a = positions.get(parent.id), b = positions.get(node.id);
              if (!a || !b) return null;
              const sx = a.x + a.w + TOGGLE_GAP + TOGGLE, sy = a.y + a.h / 2;
              const ex = b.x, ey = b.y + b.h / 2;
              const c = (ex - sx) * 0.5;
              return (
                <path
                  key={node.id}
                  d={`M${sx},${sy} C${sx + c},${sy} ${ex - c},${ey} ${ex},${ey}`}
                  fill="none"
                  stroke={`color-mix(in oklab, ${hue(b.depth)} 60%, var(--color-ink-3))`}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
          {visible.map(({ node }) => {
            const p = positions.get(node.id);
            if (!p) return null;
            const h = hue(p.depth);
            const isSel = node.id === selected;
            const isOpen = open.has(node.id);
            return (
              <div key={node.id}>
                <div
                  ref={(el) => {
                    if (el) nodeEls.current.set(node.id, el);
                    else nodeEls.current.delete(node.id);
                  }}
                  onClick={() => !justDragged.current && select(node.id)}
                  onDoubleClick={() => {
                    setSelected(node.id);
                    setEditing({ id: node.id, isNew: false });
                  }}
                  title={!showDefs && node.note ? node.note : undefined}
                  className={`pointer-events-auto absolute cursor-pointer rounded-lg border leading-snug text-ink transition-shadow ${
                    p.depth === 0 ? "px-3.5 py-2 text-[13.5px] font-semibold" : "px-3 py-1.5 text-[12.5px] font-medium"
                  }`}
                  style={{
                    left: p.x,
                    top: p.y,
                    width: "max-content",
                    maxWidth: NODE_MAX_W,
                    background: `color-mix(in oklab, ${h} ${p.depth === 0 ? 26 : 15}%, var(--color-panel))`,
                    borderColor: `color-mix(in oklab, ${h} ${isSel ? 85 : 35}%, var(--color-edge))`,
                    boxShadow: isSel ? `0 0 0 2px color-mix(in oklab, ${h} 45%, transparent)` : undefined,
                  }}
                >
                  {node.label}
                  {showDefs && node.note && (
                    <span className="mt-0.5 block text-[11.5px] font-normal leading-snug text-ink-2">{node.note}</span>
                  )}
                </div>
                {node.children.length > 0 && (
                  <button
                    onClick={() => toggle(node.id)}
                    onMouseDown={(e) => e.preventDefault()}
                    title={isOpen ? "Collapse" : `Expand (${node.children.length})`}
                    aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
                    aria-expanded={isOpen}
                    className="pointer-events-auto absolute flex items-center justify-center rounded-full border border-edge bg-panel text-[10px] font-semibold text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                    style={{
                      left: p.x + p.w + TOGGLE_GAP,
                      top: p.y + p.h / 2 - TOGGLE / 2,
                      width: TOGGLE,
                      height: TOGGLE,
                    }}
                  >
                    {isOpen ? <ChevronLeft size={12} strokeWidth={2.4} /> : node.children.length}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* toolbar */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-edge bg-panel/95 p-0.5 shadow-sm backdrop-blur">
        <Tool label="Zoom out (−)" onClick={() => zoomCenter(1 / 1.2)}>
          <ZoomOut size={14} />
        </Tool>
        <button
          onClick={() => vp && zoomAt(1 / view.z, vp.clientWidth / 2, vp.clientHeight / 2)}
          title="Reset to 100%"
          className="w-10 rounded-md py-1 text-center text-[11px] tabular-nums text-ink-2 hover:bg-hover hover:text-ink"
        >
          {Math.round(view.z * 100)}%
        </button>
        <Tool label="Zoom in (+)" onClick={() => zoomCenter(1.2)}>
          <ZoomIn size={14} />
        </Tool>
        <Tool label="Fit to view (0)" onClick={() => fit()}>
          <Scan size={14} />
        </Tool>
        <Sep />
        <Tool label="Expand all" onClick={expandAll}>
          <UnfoldHorizontal size={14} />
        </Tool>
        <Tool label="Collapse all" onClick={collapseAll}>
          <FoldHorizontal size={14} />
        </Tool>
        <Tool label={showDefs ? "Hide definitions" : "Show definitions on the map"} onClick={() => {
            anchorOn(selected ?? tree.id);
            setShowDefs((s) => !s);
          }}
          active={showDefs}
        >
          <TextQuote size={14} />
        </Tool>
        <Sep />
        <Tool label="Undo (⌘Z)" onClick={() => undo()} disabled={past.length === 0}>
          <Undo2 size={14} />
        </Tool>
        <Tool label="Redo (⇧⌘Z)" onClick={redo} disabled={future.length === 0}>
          <Redo2 size={14} />
        </Tool>
        <Sep />
        <Tool label={full ? "Exit full screen (Esc)" : "Full screen"} onClick={toggleFull}>
          {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Tool>
      </div>

      {/* details card for the selected node, or a hint */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        {selNode ? (
          <div className="pointer-events-auto w-full max-w-[380px] rounded-xl border border-edge bg-panel/95 p-3 shadow-md backdrop-blur">
            {selPath.length > 1 && (
              <div className="mb-1 flex flex-wrap items-center gap-x-1 text-[11px] text-ink-3">
                {selPath.slice(0, -1).map((n) => (
                  <span key={n.id} className="flex items-center gap-1">
                    <button onClick={() => select(n.id)} className="max-w-[140px] truncate hover:text-ink hover:underline">
                      {n.label}
                    </button>
                    <span aria-hidden>›</span>
                  </span>
                ))}
              </div>
            )}
            {editing?.id === selNode.id ? (
              <EditForm
                key={selNode.id}
                node={selNode}
                onSave={(l, n) => saveEdit(selNode.id, l, n)}
                onCancel={cancelEdit}
              />
            ) : (
              <>
                <p className="text-[14px] font-semibold leading-snug tracking-tight">{selNode.label}</p>
                {selNode.note ? (
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{selNode.note}</p>
                ) : (
                  <p className="mt-1 text-[12px] italic text-ink-3">No definition yet.</p>
                )}
                <div className="mt-2.5 flex flex-wrap gap-1">
                  <CardButton onClick={() => setEditing({ id: selNode.id, isNew: false })} label="Edit (F2 or double-click)">
                    <Pencil size={12} /> Edit
                  </CardButton>
                  <CardButton onClick={() => addChild(selNode.id)} label="Add a child node (Tab)">
                    <CornerDownRight size={12} /> Child
                  </CardButton>
                  {selNode.id !== tree.id && (
                    <CardButton onClick={() => addSibling(selNode.id)} label="Add a sibling node (Enter)">
                      <Plus size={12} /> Sibling
                    </CardButton>
                  )}
                  {selNode.id !== tree.id && (
                    <CardButton onClick={() => remove(selNode.id)} label="Delete this node and its branch (Delete)" danger>
                      <Trash2 size={12} /> Delete
                      {selNode.children.length > 0 && ` (${countNodes(selNode)})`}
                    </CardButton>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="pointer-events-none rounded-md bg-panel/80 px-2 py-1 text-[11px] text-ink-3 backdrop-blur">
            Click a node for details · double-click to edit · drag to move · pinch or ⌘-scroll to zoom
          </p>
        )}
        <span className="pointer-events-none shrink-0 rounded-md bg-panel/80 px-2 py-1 text-[11px] text-ink-3 backdrop-blur">
          {total} {total === 1 ? "node" : "nodes"} ·{" "}
          {status === "saving" ? "Saving…" : status === "error" ? <span className="text-danger">Couldn't save</span> : "Saved"}
        </span>
      </div>
    </div>
  );

  if (!full) return canvas;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink" role="dialog" aria-label={title}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge-soft bg-panel px-4">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-tight">{title}</span>
        <button
          onClick={toggleFull}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Minimize2 size={13} /> Exit full screen
        </button>
      </div>
      {canvas}
    </div>,
    document.body
  );
}

/* ------------------------------- small parts ------------------------------- */

function Tool({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-35 disabled:hover:bg-transparent ${
        active ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden />;
}

function CardButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-[11.5px] font-medium transition-colors ${
        danger ? "text-ink-2 hover:border-danger-edge hover:bg-danger-bg hover:text-danger" : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function EditForm({
  node,
  onSave,
  onCancel,
}: {
  node: MindNode;
  onSave: (label: string, note: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [note, setNote] = useState(node.note);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSave(label, note);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={keys}
        placeholder="Label"
        aria-label="Node label"
        className="rounded-md border border-edge bg-canvas px-2 py-1.5 text-[13px] font-semibold outline-none focus:border-ink-3"
      />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={keys}
        rows={2}
        placeholder="Definition (optional)"
        aria-label="Node definition"
        className="resize-none rounded-md border border-edge bg-canvas px-2 py-1.5 text-[12.5px] leading-snug outline-none focus:border-ink-3"
      />
      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[10.5px] text-ink-3">Enter to save · Esc to cancel</span>
        <button onClick={onCancel} className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-3 hover:bg-hover hover:text-ink">
          Cancel
        </button>
        <button
          onClick={() => onSave(label, note)}
          className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-accent-ink hover:opacity-90"
        >
          Save
        </button>
      </div>
    </div>
  );
}
