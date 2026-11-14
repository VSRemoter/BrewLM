import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BrewIcon } from "./BrewIcon";

export function Modal({
  title,
  onClose,
  children,
  wide,
  size,
  actions,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Shorthand for size="xl". */
  wide?: boolean;
  /** md (default) fits short forms; lg fits settings laid out as rows; xl fits reading. */
  size?: "md" | "lg" | "xl";
  /** Extra icon buttons rendered in the header, left of the close button. */
  actions?: ReactNode;
  /** Buttons pinned under the scrolling body, so the main action is always in view. */
  footer?: ReactNode;
}) {
  const width = { md: "md:max-w-md", lg: "md:max-w-lg", xl: "md:max-w-2xl" }[size ?? (wide ? "xl" : "md")];
  return (
    // On a phone the dialog is a sheet along the bottom edge, clear of the home indicator.
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] md:items-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`anim-pop safe-bottom flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-edge bg-panel shadow-[0_24px_64px_-12px_rgb(0_0_0/0.35),0_0_0_1px_rgb(0_0_0/0.02)] md:mx-4 md:max-h-[calc(85vh/var(--om-zoom,1))] md:rounded-xl md:pb-0 ${width}`}
        role="dialog"
        aria-label={title}
      >
        {/* No rule under the title: whitespace separates it, as in Notion. */}
        <div className="flex shrink-0 items-center justify-between gap-3 pl-5 pr-3 pt-3.5">
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          <div className="flex items-center gap-0.5">
            {actions}
            <button
              onClick={onClose}
              className="rounded-md p-2 text-ink-3 transition-colors hover:bg-hover hover:text-ink md:p-1.5"
              aria-label="Close"
            >
              <X size={16} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge-soft bg-canvas/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** A labelled setting laid out as a row: label left, control right (stacked on phones). */
export function PropertyRow({
  label,
  icon,
  hint,
  inline,
  children,
}: {
  label: string;
  icon?: ReactNode;
  /** Muted helper text under the control. */
  hint?: ReactNode;
  /** Keep label and control side by side on phones too (for narrow controls). */
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        inline
          ? "flex flex-row items-start gap-3"
          : "flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3"
      }
    >
      <span
        className={`flex shrink-0 items-center gap-2 text-[13px] text-ink-3 ${inline ? "h-8 w-24 sm:w-28" : "sm:h-8 sm:w-28"}`}
      >
        {icon && <span className="flex w-4 justify-center text-ink-3">{icon}</span>}
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {children}
        {hint && <p className="mt-1.5 text-[12px] leading-snug text-ink-3">{hint}</p>}
      </div>
    </div>
  );
}

/** A labelled block for long-form input: label (and an optional note) above the control. */
export function FormField({
  label,
  note,
  aside,
  children,
}: {
  label: string;
  /** Muted text after the label, e.g. "Optional". */
  note?: string;
  /** Right-aligned element on the label row, e.g. a "Select all" link. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-ink">
          {label}
          {note && <span className="ml-1.5 font-normal text-ink-3">{note}</span>}
        </span>
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * A dropdown in the app's own style, for places a native <select> would show
 * the system's menu. The menu is drawn above everything (so a dialog's edges
 * can't clip it), opens below the button or above it when there's no room,
 * and works from the keyboard: arrows move, Enter picks, Escape closes.
 */
export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; icon?: ReactNode }[];
  onChange: (id: T) => void;
  /** Accessible name for the button. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The click-away layer: fixed over the whole window, so it measures the viewport. */
  const overlayRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value) ?? options[0];

  const place = () => {
    const b = buttonRef.current;
    const o = overlayRef.current;
    if (!b || !o) return;
    const r = b.getBoundingClientRect();
    const v = o.getBoundingClientRect();
    // The app zooms the whole page (Settings → Text size). Depending on the
    // engine, measured positions may already include that zoom while the
    // menu's own left/top get zoomed again, so convert by the scale actually
    // seen: measured width over layout width.
    const k = b.offsetWidth ? r.width / b.offsetWidth : 1;
    const menuHeight = Math.min(options.length * 32 + 10, 264) * k;
    const below = v.bottom - r.bottom;
    const above = r.top - v.top;
    const width = r.width / k;
    // Keep the menu (at least 200px wide) inside the window on narrow screens.
    const viewWidth = v.width / k;
    const left = Math.max(8, Math.min((r.left - v.left) / k, viewWidth - Math.max(width, 200) - 8));
    setPos(
      below >= menuHeight + 8 * k || below >= above
        ? { left, width, top: (r.bottom - v.top) / k + 4 }
        : { left, width, bottom: (v.bottom - r.top) / k + 4 }
    );
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    setActive(Math.max(0, options.findIndex((o) => o.id === value)));
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    // Scrolling the dialog would leave the menu behind: close it instead.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (id: T) => {
    onChange(id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      // Close the menu, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active].id);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13.5px] text-ink outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${
          open ? "bg-hover" : ""
        }`}
      >
        {current?.icon && <span className="flex shrink-0 text-ink-3">{current.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{current?.label}</span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        createPortal(
          <>
            <div ref={overlayRef} className="fixed inset-0 z-[60]" onMouseDown={() => setOpen(false)} />
            {pos && (
            <div
              role="listbox"
              aria-label={label}
              className="anim-menu fixed z-[61] max-h-[264px] overflow-y-auto rounded-xl border border-edge bg-panel p-1 shadow-lg"
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: Math.max(pos.width, 200), maxWidth: "calc(100vw - 16px)" }}
            >
              {options.map((o, i) => {
                const selected = o.id === value;
                return (
                  <div
                    key={o.id}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                      i === active ? "bg-hover text-ink" : "text-ink-2"
                    }`}
                  >
                    {o.icon && <span className="flex shrink-0 text-ink-3">{o.icon}</span>}
                    <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium text-ink" : ""}`}>{o.label}</span>
                    {selected && <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" />}
                  </div>
                );
              })}
            </div>
            )}
          </>,
          document.body
        )}
    </>
  );
}

/** Shared text-input look: a quiet filled field that firms up on focus. */
export const inputClass =
  "w-full rounded-lg border border-edge bg-canvas/60 px-3 py-[7px] text-[13px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 hover:border-ink-3/50 focus:border-accent/70 focus:ring-3 focus:ring-accent/15";

/** Same look for multi-line input. */
export const textareaClass = `${inputClass} resize-none leading-relaxed`;

/** A thin rule between groups in a dialog body. */
export function Divider() {
  return <div className="-mx-5 my-1 h-px bg-edge-soft" aria-hidden />;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  form,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  /** Id of a form this submits, for a button in a Modal footer. */
  form?: string;
}) {
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      // Phones: a bigger hit area for fingers.
      className={`rounded-md p-2.5 text-ink-3 transition-colors md:p-1.5 ${
        danger ? "hover:bg-danger-bg hover:text-danger" : "hover:bg-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-[1.5px] border-ink-3 border-t-transparent"
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-ink-3" />
      ))}
    </span>
  );
}

/** Brew-bar verbs cycled while the model works up to its first token. */
const BREW_WORDS = ["pouring", "brewing", "grinding", "streaming", "serving"];

export function BrewingStatus() {
  // random start so consecutive waits don't all open with the same word
  const [i, setI] = useState(() => Math.floor(Math.random() * BREW_WORDS.length));
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % BREW_WORDS.length), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="inline-flex items-center gap-1.5 py-1">
      <BrewIcon size={13} strokeWidth={2} animateSteam className="shrink-0 text-accent" />
      <span
        key={i}
        className="brew-word bg-linear-to-r from-accent via-ink to-accent bg-[length:200%_100%] bg-clip-text text-[13px] font-medium italic text-transparent"
      >
        {`${BREW_WORDS[i]}…`}
      </span>
    </span>
  );
}

/** Segmented radio-style picker — one option always selected. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  /** `hint` is a muted secondary value shown after the label, e.g. a count. */
  options: { id: T; label: string; hint?: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  // Equal-width columns sized to the widest label; wraps only if the space is truly too narrow.
  return (
    <div
      className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-edge-soft bg-canvas p-[3px]"
      role="radiogroup"
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`whitespace-nowrap rounded-md px-2 py-[5px] text-[12.5px] font-medium transition-all ${
              on
                ? "bg-panel text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-edge"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {o.label}
            {o.hint && (
              <span className={`ml-1.5 whitespace-nowrap tabular-nums ${on ? "text-ink-3" : "opacity-70"}`}>{o.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
