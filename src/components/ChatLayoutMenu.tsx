import { ArrowLeftRight, Check, Columns2, LayoutPanelLeft, PanelLeft, PanelRight, Rows2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PRESETS, layoutRects, type Preset } from "../lib/chatLayout";
import { IconButton } from "./ui";

/** A little drawing of a preset: one box per chat. */
function PresetThumb({ preset, count }: { preset: Preset; count: number }) {
  const ids = ["a", "b", "c"].slice(0, count);
  const { panes } = layoutRects(PRESETS[preset].build(ids));
  return (
    <span className="relative block h-[30px] w-[44px]">
      {panes.map(({ id, rect: r }) => (
        <span
          key={id}
          className="absolute rounded-[3px] border border-current opacity-70"
          style={{
            left: `calc(${r.x * 100}% + 1px)`,
            top: `calc(${r.y * 100}% + 1px)`,
            width: `calc(${r.w * 100}% - 2px)`,
            height: `calc(${r.h * 100}% - 2px)`,
          }}
        />
      ))}
    </span>
  );
}

/** The notebook's side panels: which show, and which side each sits on (NotebookView). */
export interface SidePanels {
  sources: boolean;
  studio: boolean;
  swapped: boolean;
  onToggle: (which: "sources" | "studio" | "swapped") => void;
}

/**
 * The chat header's layout button: add a chat beside or below this one,
 * rearrange the open chats into a preset, and show, hide or swap the side
 * panels.
 */
export default function ChatLayoutMenu({
  count,
  presets,
  current,
  onAdd,
  onPreset,
  panels,
}: {
  count: number;
  presets: Preset[];
  current: Preset | null;
  /** Absent once the most chats are open. */
  onAdd?: (where: "right" | "bottom") => void;
  onPreset: (p: Preset) => void;
  panels?: SidePanels;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink";
  return (
    <div ref={ref} className="relative">
      <IconButton onClick={() => setOpen((o) => !o)} label="Chat layout">
        <LayoutPanelLeft size={14} strokeWidth={1.8} />
      </IconButton>
      {open && (
        <div role="menu" className="anim-menu absolute right-0 z-30 mt-1.5 w-64 rounded-xl border border-edge bg-panel py-1 shadow-lg">
          {onAdd && (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Add a chat</p>
              <button role="menuitem" className={item} onClick={() => (setOpen(false), onAdd("right"))}>
                <Columns2 size={14} strokeWidth={1.8} /> Beside this one
              </button>
              <button role="menuitem" className={item} onClick={() => (setOpen(false), onAdd("bottom"))}>
                <Rows2 size={14} strokeWidth={1.8} /> Below this one
              </button>
            </>
          )}
          {presets.length > 0 && (
            <>
              <p className={`px-3 pb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3 ${onAdd ? "mt-1 border-t border-edge-soft pt-2" : "pt-1.5"}`}>
                Layout
              </p>
              <div className="grid grid-cols-3 gap-1.5 px-3 pb-1">
                {presets.map((p) => (
                  <button
                    key={p}
                    role="menuitemradio"
                    aria-checked={current === p}
                    aria-label={PRESETS[p].label}
                    title={PRESETS[p].label}
                    onClick={() => {
                      setOpen(false);
                      onPreset(p);
                    }}
                    className={`relative flex items-center justify-center rounded-lg border p-1.5 transition-colors ${
                      current === p ? "border-accent text-accent" : "border-edge-soft text-ink-3 hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <PresetThumb preset={p} count={count} />
                    {current === p && <Check size={10} strokeWidth={3} className="absolute right-0.5 top-0.5" />}
                  </button>
                ))}
              </div>
            </>
          )}
          {count > 1 && (
            <p className="px-3 pb-1.5 pt-1 text-[11px] leading-snug text-ink-3">
              Drag a chat by its title to move it. Drop it on an edge to place it there, or in the middle to swap.
            </p>
          )}
          {panels && (
            <>
              <p className="mt-1 border-t border-edge-soft px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
                Side panels
              </p>
              {(
                [
                  ["sources", "Sources and chats", panels.swapped ? PanelRight : PanelLeft, panels.sources],
                  ["studio", "Studio", panels.swapped ? PanelLeft : PanelRight, panels.studio],
                  ["swapped", "Swap sides", ArrowLeftRight, panels.swapped],
                ] as const
              ).map(([id, label, Icon, on]) => (
                <button
                  key={id}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={item}
                  onClick={() => panels.onToggle(id)}
                >
                  <Icon size={14} strokeWidth={1.8} />
                  <span className="flex-1">{label}</span>
                  {on && <Check size={13} strokeWidth={2.5} className="text-accent" />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
