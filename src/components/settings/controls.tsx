/** Shared building blocks for the settings page sections. */
import { Check, Plus, X } from "lucide-react";
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
    // Phones: a control too wide to sit beside its label wraps onto its own line.
    <div
      className={`flex flex-wrap justify-between gap-x-6 gap-y-2 py-3 md:flex-nowrap ${
        alignTop ? "items-start" : "items-center"
      }`}
    >
      <div className="min-w-0 grow basis-40 md:grow-0 md:basis-auto">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{desc}</div>}
      </div>
      <div className="max-w-full shrink-0">{children}</div>
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

/**
 * Click-to-pick list of saved model ids with hover remove buttons.
 * `fallback` adds a fixed first row (e.g. "Same as main model") that can't be removed.
 */
export function SavedModelList({
  title,
  models,
  active,
  onPick,
  onRemove,
  fallback,
}: {
  title: string;
  models: string[];
  active: string;
  onPick: (m: string) => void;
  onRemove: (m: string) => void;
  fallback?: { label: string; active: boolean; onPick: () => void };
}) {
  if (models.length === 0 && !fallback) return null;
  return (
    <div className="py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
        <span className="text-[11px] text-ink-3">{models.length}</span>
      </div>
      <div className="max-h-56 divide-y divide-edge-soft overflow-y-auto rounded-lg border border-edge">
        {fallback && (
          <div
            role="button"
            tabIndex={0}
            onClick={fallback.onPick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fallback.onPick();
              }
            }}
            className={`flex cursor-pointer items-center gap-2 px-2.5 py-2 transition-colors ${
              fallback.active ? "bg-hover" : "hover:bg-hover"
            }`}
          >
            <Check
              size={13}
              strokeWidth={2.5}
              className={`shrink-0 ${fallback.active ? "text-ink" : "text-transparent"}`}
            />
            <span className={`min-w-0 flex-1 truncate text-[12px] ${fallback.active ? "text-ink" : "text-ink-2"}`}>
              {fallback.label}
            </span>
          </div>
        )}
        {models.map((m) => {
          const on = active === m;
          return (
            <div
              key={m}
              role="button"
              tabIndex={0}
              onClick={() => onPick(m)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(m);
                }
              }}
              title={m}
              className={`group flex cursor-pointer items-center gap-2 px-2.5 py-2 transition-colors ${
                on ? "bg-hover" : "hover:bg-hover"
              }`}
            >
              <Check
                size={13}
                strokeWidth={2.5}
                className={`shrink-0 ${on ? "text-ink" : "text-transparent"}`}
              />
              <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${on ? "text-ink" : "text-ink-2"}`}>
                {m}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(m);
                }}
                aria-label={`Remove ${m}`}
                title="Remove"
                className="shrink-0 rounded-full p-1 text-ink-3 opacity-0 transition-opacity hover:bg-panel hover:text-ink group-hover:opacity-100"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Model id text box with an Add button (Enter also adds) — feeds a SavedModelList. */
export function ModelIdInput({
  value,
  onChange,
  onAdd,
  canAdd,
  placeholder,
  onBlur,
  addTitle = "Save to your list",
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  canAdd: boolean;
  placeholder: string;
  onBlur?: (v: string) => void;
  addTitle?: string;
}) {
  return (
    <div className="flex gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      <button
        onClick={onAdd}
        disabled={!canAdd}
        title={addTitle}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40"
      >
        <Plus size={12} strokeWidth={2.5} />
        Add
      </button>
    </div>
  );
}
