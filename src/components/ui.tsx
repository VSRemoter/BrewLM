import { X } from "lucide-react";
import type { ReactNode } from "react";

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
        className={`anim-fade-up mx-4 max-h-[85vh] w-full overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl ${
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
        <div className="max-h-[calc(85vh-52px)] overflow-y-auto px-5 py-4">{children}</div>
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
