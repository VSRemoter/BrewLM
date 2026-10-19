/**
 * Hand-rolled SVG charts for the usage dashboard — no chart library, so
 * everything themes with BrewLM's CSS variables. The activity chart measures
 * its container (ResizeObserver) and renders 1:1 so text and strokes never
 * distort.
 */
import { useEffect, useRef, useState } from "react";
import { fmtTokens, fmtUsd, type Bucket } from "../../lib/usage";

export type Metric = "tokens" | "cost" | "calls";

export function bucketValue(b: Bucket, metric: Metric): number {
  if (metric === "cost") return b.costUsd;
  if (metric === "calls") return b.calls;
  return b.input + b.output;
}

export function fmtMetric(v: number, metric: Metric): string {
  if (metric === "cost") return fmtUsd(v);
  if (metric === "calls") return v === 1 ? "1 call" : `${fmtTokens(v)} calls`;
  return `${fmtTokens(v)} tokens`;
}

function fmtAxis(v: number, metric: Metric): string {
  if (v === 0) return "0";
  if (metric === "cost") return `$${v >= 10 ? Math.round(v) : v >= 0.1 ? v.toFixed(2) : String(+v.toFixed(3))}`;
  return fmtTokens(v);
}

/** Round up to a 1/2/2.5/5×10^k "nice" ceiling for axis ticks. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base;
  return 10 * base;
}

/** Monotone cubic (Fritsch–Carlson) path — smooth, but never overshoots below zero. */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 3) return pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  const m = [d[0], ...d.slice(1).map((v, i) => (v * d[i] <= 0 ? 0 : (v + d[i]) / 2)), d[n - 2]];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let out = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    out += ` C${(x0 + dx).toFixed(1)},${(y0 + m[i] * dx).toFixed(1)} ${(x1 - dx).toFixed(1)},${(y1 - m[i + 1] * dx).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return out;
}

/** Observe an element's content width (for 1:1 SVG rendering). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Area/line chart of a metric over time buckets, with gridlines, thinned axis
 * labels, and a hover tooltip showing the bucket's detail.
 */
export function ActivityChart({
  buckets,
  metric,
}: {
  buckets: Bucket[];
  metric: Metric;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const H = 220;
  const L = 48;
  const R = 14;
  const T = 14;
  const B = 28;
  const W = Math.max(width, 320);
  const pw = W - L - R;
  const ph = H - T - B;
  const n = buckets.length;

  const values = buckets.map((b) => bucketValue(b, metric));
  const max = niceCeil(Math.max(...values, metric === "cost" ? 0.01 : 1));
  const x = (i: number) => (n <= 1 ? L + pw / 2 : L + (i / (n - 1)) * pw);
  const y = (v: number) => T + ph - (v / max) * ph;

  const line = smoothPath(values.map((v, i) => [x(i), y(v)]));
  const area = n > 1 ? `${line} L${x(n - 1).toFixed(1)},${T + ph} L${x(0).toFixed(1)},${T + ph} Z` : null;
  const labelStep = Math.max(1, Math.ceil(n / 7));

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const i = Math.round(fx * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  const hoverPct = hover != null ? Math.min(88, Math.max(12, (x(hover) / W) * 100)) : 0;
  const hb = hover != null ? buckets[hover] : null;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: H }}>
      {width > 0 && n > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Usage over time">
          <defs>
            <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* gridlines + y labels */}
          {Array.from({ length: 3 }, (_, g) => {
            const v = (max * g) / 2;
            const gy = y(v);
            return (
              <g key={g}>
                <line x1={L} x2={W - R} y1={gy} y2={gy} stroke="var(--color-edge-soft)" strokeWidth={1} strokeDasharray={g === 0 ? undefined : "2 4"} />
                <text x={L - 8} y={gy} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--color-ink-3)">
                  {fmtAxis(v, metric)}
                </text>
              </g>
            );
          })}

          {/* area + line */}
          {area && <path d={area} fill="url(#usage-area)" />}
          {n === 1 ? (
            <circle cx={x(0)} cy={y(values[0])} r={3} fill="var(--color-accent)" />
          ) : (
            <path
              d={line}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* hover guide */}
          {hover != null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={T}
              y2={T + ph}
              stroke="var(--color-ink-3)"
              strokeDasharray="3 3"
            />
          )}
          {hover != null && (
            <circle
              cx={x(hover)}
              cy={y(values[hover])}
              r={4}
              fill="var(--color-panel)"
              stroke="var(--color-accent)"
              strokeWidth={2}
            />
          )}

          {/* x labels (thinned) */}
          {buckets.map((b, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={b.ts}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-ink-3)"
              >
                {b.label}
              </text>
            ) : null
          )}

          {/* hover capture */}
          <rect
            x={L}
            y={T}
            width={pw}
            height={ph}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}

      {/* tooltip */}
      {hb && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-center shadow-lg"
          style={{ left: `${hoverPct}%` }}
        >
          <div className="text-[11px] font-semibold text-ink">{hb.label}</div>
          <div className="text-[11px] text-ink-2">{fmtMetric(bucketValue(hb, metric), metric)}</div>
          {metric === "tokens" && (
            <div className="text-[10px] text-ink-3">
              {fmtTokens(hb.input)} in · {fmtTokens(hb.output)} out
            </div>
          )}
        </div>
      )}
    </div>
  );
}
