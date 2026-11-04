import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hexToRgb, hsvToRgb, normalizeHex, rgbToHex, rgbToHsv } from "../../lib/color";

type HSV = [number, number, number];

const toHex = ([h, s, v]: HSV) => rgbToHex(hsvToRgb(h, s, v));
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const HUES = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

/**
 * A swatch and a hex field on one line; the swatch opens a small picker
 * (saturation × brightness square plus a hue strip) that reaches every one of
 * the 16,777,216 sRGB colors. An empty `value` shows `fallback` and
 * `placeholder` instead, and `onClear` offers to go back to that.
 * `onChange` fires live while dragging; `onCommit` once a pick settles.
 */
export default function ColorField({
  label,
  value,
  fallback,
  placeholder,
  onChange,
  onCommit,
  onClear,
}: {
  label: string;
  value: string;
  fallback?: string;
  placeholder?: string;
  onChange: (hex: string) => void;
  onCommit: (hex: string) => void;
  onClear?: () => void;
}) {
  const shown = value || fallback || "#000000";
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);

  // Closes on a click anywhere else or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: globalThis.PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      swatchRef.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Exact entry by hex.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commitDraft = () => {
    const n = normalizeHex(draft);
    if (n) {
      if (n !== value) onCommit(n);
    } else setDraft(value);
  };

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <button
        ref={swatchRef}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Pick ${label.toLowerCase()} color`}
        aria-expanded={open}
        className={`h-6 w-6 shrink-0 rounded-md border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-shadow ${
          open ? "border-accent ring-2 ring-accent/30" : "border-edge hover:border-ink-3"
        }`}
        style={{ background: shown }}
      />
      <input
        value={draft}
        placeholder={placeholder}
        aria-label={`${label} hex`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => e.key === "Enter" && commitDraft()}
        spellCheck={false}
        maxLength={7}
        className={`w-[6.5rem] rounded-md border border-edge bg-canvas px-2 py-1 text-[12px] outline-none placeholder:text-ink-3 focus:border-accent ${
          draft ? "font-mono uppercase" : ""
        }`}
      />
      {onClear && value ? (
        <button
          onClick={onClear}
          title={placeholder}
          aria-label={placeholder}
          className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X size={13} />
        </button>
      ) : (
        // Same width as the clear button, so the fields line up row to row.
        <span className="w-[18px]" />
      )}
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-60 rounded-xl border border-edge bg-panel p-3 shadow-xl">
          <Picker value={shown} onChange={onChange} onCommit={onCommit} />
        </div>
      )}
    </div>
  );
}

function Picker({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (hex: string) => void;
  onCommit: (hex: string) => void;
}) {
  // HSV is kept locally so hue survives greys and black (where hex loses it).
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(hexToRgb(value)));
  const hex = toHex(hsv);
  useEffect(() => {
    if (value !== toHex(hsv)) setHsv(rgbToHsv(hexToRgb(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const set = (next: HSV, commit = false) => {
    setHsv(next);
    const out = toHex(next);
    onChange(out);
    if (commit) onCommit(out);
  };

  const fromSquare = (e: PointerEvent<HTMLDivElement>, commit = false) => {
    const box = e.currentTarget.getBoundingClientRect();
    set([hsv[0], clamp01((e.clientX - box.left) / box.width), 1 - clamp01((e.clientY - box.top) / box.height)], commit);
  };
  const fromHue = (e: PointerEvent<HTMLDivElement>, commit = false) => {
    const box = e.currentTarget.getBoundingClientRect();
    set([Math.min(359.9, clamp01((e.clientX - box.left) / box.width) * 360), hsv[1], hsv[2]], commit);
  };

  /** Drag live, commit on release. */
  const drag = (pick: (e: PointerEvent<HTMLDivElement>, commit?: boolean) => void) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      pick(e);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e);
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => pick(e, true),
  });

  const squareKeys = (e: KeyboardEvent) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const [h, s, v] = hsv;
    const next: Partial<Record<string, HSV>> = {
      ArrowLeft: [h, clamp01(s - step), v],
      ArrowRight: [h, clamp01(s + step), v],
      ArrowUp: [h, s, clamp01(v + step)],
      ArrowDown: [h, s, clamp01(v - step)],
    };
    if (next[e.key]) {
      e.preventDefault();
      set(next[e.key] as HSV, true);
    }
  };
  const hueKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    set([(hsv[0] + delta + 360) % 360, hsv[1], hsv[2]], true);
  };

  const thumb =
    "pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_1px_3px_rgba(0,0,0,0.4)]";
  const focus = "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

  return (
    <div className="flex flex-col gap-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv[1] * 100)}%, brightness ${Math.round(hsv[2] * 100)}%`}
        onKeyDown={squareKeys}
        className={`relative h-36 w-full cursor-crosshair touch-none rounded-lg ${focus}`}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${toHex([hsv[0], 1, 1])})`,
        }}
        {...drag(fromSquare)}
      >
        <span className={thumb} style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }} />
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv[0])}
        onKeyDown={hueKeys}
        className={`relative h-2.5 w-full cursor-pointer touch-none rounded-full ${focus}`}
        style={{ background: HUES }}
        {...drag(fromHue)}
      >
        <span className={`${thumb} top-1/2`} style={{ left: `${(hsv[0] / 360) * 100}%`, background: toHex([hsv[0], 1, 1]) }} />
      </div>
    </div>
  );
}
