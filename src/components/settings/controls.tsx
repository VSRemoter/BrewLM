/** Shared building blocks for the settings page sections. */
import type { ReactNode } from "react";

export function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
      {desc && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{desc}</p>}
    </div>
  );
}

/** Rounded container grouping rows with hairline dividers. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 divide-y divide-edge-soft rounded-2xl border border-edge bg-panel px-4">
      {children}
    </div>
  );
}

/** Label (+ optional description) on the left, control on the right. */
export function Row({
  label,
  desc,
  children,
  alignTop,
}: {
  label: string;
  desc?: string;
  children: ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-6 py-3 ${alignTop ? "items-start" : "items-center"}`}>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** macOS-style switch. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 rounded-full transition-colors ${checked ? "bg-accent" : "bg-edge"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** Fired once when the user releases the slider (or arrows with keys). */
  onCommit?: () => void;
  label?: string;
}) {
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
      className="w-44 accent-accent"
    />
  );
}

/** Small note under a card, e.g. explanations of what a section doesn't do. */
export function Footnote({ children }: { children: ReactNode }) {
  return <p className="-mt-3 mb-6 px-1 text-[11.5px] leading-relaxed text-ink-3">{children}</p>;
}
