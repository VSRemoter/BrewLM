import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hexToRgb, hsvToRgb, normalizeHex, rgbToHex, rgbToHsv } from "../../lib/color";

type HSV = [number, number, number];

const toHex = ([h, s, v]: HSV) => rgbToHex(hsvToRgb(h, s, v));
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Full-gamut picker: the wheel sets hue (angle) and saturation (distance from
 * the center), the bar sets brightness, and the hex field takes exact values —
 * together every one of the 16,777,216 sRGB colors is reachable.
 * `onChange` fires live while dragging; `onCommit` once a pick settles.
 */
export default function ColorWheel({
  value,
  onChange,
  onCommit,
  size = 176,
}: {
  value: string;
  onChange: (hex: string) => void;
  onCommit: (hex: string) => void;
  size?: number;
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

  // Paint the hue/saturation disc at full brightness, so hues stay findable
  // even while picking a near-black background (the marker shows the real color).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;
    const img = ctx.createImageData(px, px);
    const r = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x + 0.5 - r;
        const dy = y + 0.5 - r;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const [cr, cg, cb] = hsvToRgb(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, d / r, 1);
        const i = (y * px + x) * 4;
        img.data[i] = cr;
        img.data[i + 1] = cg;
        img.data[i + 2] = cb;
        img.data[i + 3] = 255 * clamp01(r - d); // anti-aliased rim
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [size]);

  const fromWheel = (e: PointerEvent<HTMLDivElement>, commit = false) => {
    const box = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - box.left - box.width / 2;
    const dy = e.clientY - box.top - box.height / 2;
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    set([h, clamp01(Math.hypot(dx, dy) / (box.width / 2)), hsv[2]], commit);
  };

  const fromBar = (e: PointerEvent<HTMLDivElement>, commit = false) => {
    const box = e.currentTarget.getBoundingClientRect();
    set([hsv[0], hsv[1], clamp01((e.clientX - box.left) / box.width)], commit);
  };

  /** Pointer handlers shared by the wheel and the bar: drag live, commit on release. */
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

  const wheelKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const [h, s, val] = hsv;
    const next: Partial<Record<string, HSV>> = {
      ArrowLeft: [(h - step + 360) % 360, s, val],
      ArrowRight: [(h + step) % 360, s, val],
      ArrowUp: [h, clamp01(s + step / 100), val],
      ArrowDown: [h, clamp01(s - step / 100), val],
    };
    if (next[e.key]) {
      e.preventDefault();
      set(next[e.key] as HSV, true);
    }
  };

  const barKeys = (e: KeyboardEvent) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    set([hsv[0], hsv[1], clamp01(hsv[2] + delta)], true);
  };

  // Exact entry by hex.
  const [hexDraft, setHexDraft] = useState(hex);
  useEffect(() => setHexDraft(hex), [hex]);
  const commitHex = () => {
    const n = normalizeHex(hexDraft);
    if (n) set(rgbToHsv(hexToRgb(n)), true);
    else setHexDraft(hex);
  };

  const angle = (hsv[0] * Math.PI) / 180;
  const full = toHex([hsv[0], hsv[1], 1]);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue and saturation"
        aria-valuetext={`Hue ${Math.round(hsv[0])}°, saturation ${Math.round(hsv[1] * 100)}%`}
        onKeyDown={wheelKeys}
        className="relative shrink-0 cursor-crosshair touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
        style={{ width: size, height: size }}
        {...drag(fromWheel)}
      >
        <canvas ref={canvasRef} className="block rounded-full" style={{ width: size, height: size }} />
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_1px_4px_rgba(0,0,0,0.5)]"
          style={{
            left: size / 2 + Math.cos(angle) * hsv[1] * (size / 2),
            top: size / 2 + Math.sin(angle) * hsv[1] * (size / 2),
            background: hex,
          }}
        />
      </div>

      <div className="flex min-w-[180px] flex-1 flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 shrink-0 rounded-lg border border-edge" style={{ background: hex }} />
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-3">Hex</span>
            <input
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => e.key === "Enter" && commitHex()}
              spellCheck={false}
              maxLength={7}
              className="w-24 rounded-md border border-edge bg-canvas px-2 py-1 font-mono text-[12.5px] uppercase outline-none focus:border-accent"
            />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Brightness</span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv[2] * 100)}
            onKeyDown={barKeys}
            className="relative h-3 w-full cursor-pointer touch-none rounded-full border border-edge outline-none focus-visible:ring-2 focus-visible:ring-accent"
            style={{ background: `linear-gradient(to right, #000, ${full})` }}
            {...drag(fromBar)}
          >
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{ left: `${hsv[2] * 100}%`, background: hex }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
