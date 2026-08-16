import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BrewIcon } from "./BrewIcon";

export function Modal({
  title,
  onClose,
  children,
  wide,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Extra icon buttons rendered in the header, left of the close button. */
  actions?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`anim-fade-up mx-4 max-h-[calc(85vh/var(--om-zoom,1))] w-full overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl ${
          wide ? "max-w-2xl" : "max-w-md"
        }`}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-edge-soft px-5 py-3.5">
          <h2 className="min-w-0 truncate text-[13.5px] font-semibold tracking-tight">{title}</h2>
          <div className="flex items-center gap-1">
            {actions}
            <button
              onClick={onClose}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              aria-label="Close"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="max-h-[calc(85vh/var(--om-zoom,1)_-_52px)] overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
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
      className="rounded-full border border-edge bg-panel px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-hover-soft disabled:cursor-not-allowed disabled:opacity-40"
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
      className={`rounded-md p-1.5 text-ink-3 transition-colors ${
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
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-edge bg-canvas p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={`flex-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
            o.id === value ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
