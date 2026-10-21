/**
 * Smooth wheel scrolling for the whole app.
 *
 * macOS WebKit (the Tauri webview) applies mouse-wheel input in hard steps —
 * each notch jumps ~40px+ with no animation, which reads as jagged. This
 * eases every wheel delta toward its target over a few frames instead, on
 * whichever element would have scrolled natively. Trackpad input goes through
 * the same easing; at these settings it adds no perceptible lag.
 *
 * Bails out (native behavior) for zoom gestures, horizontal scrolls, and when
 * nothing in the wheel's direction can scroll. An animation stops the moment
 * something else moves the element (auto-scroll to a new message, scrollbar
 * drag, keyboard), so it never fights other code.
 */

/** Fraction of the remaining distance covered per 60 Hz frame. */
const EASE = 0.22;
const LINE_PX = 40;

interface Anim {
  target: number;
  /** scrollTop we last wrote — anything else means an outside change. */
  last: number;
  raf: number;
  prevTs: number;
}

let enabled = true;
let installed = false;
const anims = new Map<HTMLElement, Anim>();

function maxScroll(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight;
}

/** Nearest ancestor that can actually scroll further in direction `dy`. */
function findScroller(start: EventTarget | null, dy: number): HTMLElement | null {
  let el = start instanceof Element ? (start as HTMLElement) : null;
  while (el && el !== document.documentElement) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") {
        // Measure from the pending target so fast spins keep accumulating.
        const pos = anims.get(el)?.target ?? el.scrollTop;
        if (dy > 0 ? pos < maxScroll(el) - 0.5 : pos > 0.5) return el;
      }
    }
    el = el.parentElement;
  }
  const root = document.scrollingElement as HTMLElement | null;
  if (root && root.scrollHeight > root.clientHeight + 1) {
    const pos = anims.get(root)?.target ?? root.scrollTop;
    if (dy > 0 ? pos < maxScroll(root) - 0.5 : pos > 0.5) return root;
  }
  return null;
}

function step(el: HTMLElement, ts: number): void {
  const a = anims.get(el);
  if (!a) return;
  // Outside change (auto-scroll, scrollbar drag, keys): yield to it.
  if (Math.abs(el.scrollTop - a.last) > 1.5) {
    anims.delete(el);
    return;
  }
  const dt = a.prevTs ? Math.min(ts - a.prevTs, 64) : 16.7;
  a.prevTs = ts;
  const k = 1 - Math.pow(1 - EASE, dt / 16.7); // frame-rate independent
  const diff = a.target - el.scrollTop;
  if (Math.abs(diff) < 0.75) {
    el.scrollTop = a.target;
    anims.delete(el);
    return;
  }
  const before = el.scrollTop;
  el.scrollTop = before + diff * k;
  // WebKit rounds scrollTop; if a tiny step rounded to nothing, snap and finish.
  if (el.scrollTop === before) {
    el.scrollTop = a.target;
    anims.delete(el);
    return;
  }
  a.last = el.scrollTop;
  a.raf = requestAnimationFrame((t) => step(el, t));
}

function onWheel(e: WheelEvent): void {
  if (!enabled || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: native
  const dy =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY * LINE_PX
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY * window.innerHeight
        : e.deltaY;
  if (dy === 0) return;
  const el = findScroller(e.target, dy);
  if (!el) return; // nothing to scroll that way: native (lets parents chain)
  e.preventDefault();

  let a = anims.get(el);
  if (!a) {
    a = { target: el.scrollTop, last: el.scrollTop, raf: 0, prevTs: 0 };
    anims.set(el, a);
    a.raf = requestAnimationFrame((t) => step(el, t));
  }
  a.target = Math.max(0, Math.min(maxScroll(el), a.target + dy));
}

/** Turn smooth wheel scrolling on/off (installs the listener on first use). */
export function setSmoothScroll(on: boolean): void {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  enabled = on && !reduced;
  if (!enabled) {
    for (const a of anims.values()) cancelAnimationFrame(a.raf);
    anims.clear();
  }
  if (!installed) {
    installed = true;
    window.addEventListener("wheel", onWheel, { passive: false });
  }
}
