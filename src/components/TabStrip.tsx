import { Home as HomeIcon, Plus, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { mediaSrc } from "../lib/blobs";
import { closeTab, moveTab, showTab, type TabsState } from "../lib/tabs";
import type { Notebook } from "../lib/types";

/**
 * The desktop top bar: Home, one tab per open notebook, and + (quick switcher).
 * Tabs drag to reorder, close on middle-click, and rename on double-click.
 */
export default function TabStrip({
  tabs,
  notebooks,
  busy,
  onRename,
  onNew,
  actions,
}: {
  tabs: TabsState;
  notebooks: Map<string, Notebook>;
  /** Notebooks with a reply streaming or a Studio job running. */
  busy: Set<string>;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  /** Icon buttons at the right end (the open notebook's). */
  actions?: ReactNode;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Set when a press turned into a drag, so the click that ends it doesn't switch tabs. */
  const draggedRef = useRef(false);

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renaming === id) return;
    const startX = e.clientX;
    draggedRef.current = false;
    const move = (ev: PointerEvent) => {
      if (!draggedRef.current) {
        if (Math.abs(ev.clientX - startX) < 5) return;
        draggedRef.current = true;
        setDragging(id);
        document.body.classList.add("select-none");
      }
      // Hit-test rather than measure: rects and pointer coordinates disagree under app zoom.
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-tab-id]");
      const overId = over?.dataset.tabId;
      if (overId && overId !== id) moveTab(id, tabs.ids.indexOf(overId));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("select-none");
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-edge-soft bg-panel px-2">
      <button
        onClick={() => showTab(null)}
        title="Home"
        aria-label="Home"
        aria-current={tabs.active === null ? "page" : undefined}
        className={`shrink-0 rounded-md p-1.5 transition-colors ${
          tabs.active === null ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"
        }`}
      >
        <HomeIcon size={16} strokeWidth={1.8} />
      </button>
      <span className="mx-1 h-5 w-px shrink-0 bg-edge" />

      <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Open notebooks">
        {tabs.ids.map((id) => {
          const nb = notebooks.get(id);
          if (!nb) return null;
          const active = id === tabs.active;
          const isBusy = busy.has(id) && !active;
          return (
            <div
              key={id}
              data-tab-id={id}
              role="tab"
              aria-selected={active}
              title={nb.title}
              onPointerDown={(e) => startDrag(e, id)}
              onClick={() => !draggedRef.current && showTab(id)}
              onAuxClick={(e) => e.button === 1 && closeTab(id)}
              onDoubleClick={() => setRenaming(id)}
              className={`group flex h-8 min-w-[72px] max-w-[200px] flex-[0_1_200px] cursor-default items-center gap-2 rounded-lg px-2 text-[12.5px] transition-colors ${
                active
                  ? "bg-hover font-medium text-ink"
                  : "text-ink-3 hover:bg-hover-soft hover:text-ink-2"
              } ${dragging === id ? "opacity-70" : ""}`}
            >
              {nb.cover ? (
                <img src={mediaSrc(nb.cover)} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-edge text-[9.5px] font-semibold uppercase text-ink-2">
                  {nb.title.trim()[0] ?? "·"}
                </span>
              )}
              {renaming === id ? (
                <input
                  autoFocus
                  defaultValue={nb.title}
                  onFocus={(e) => e.target.select()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const t = e.target.value.trim();
                    if (t && t !== nb.title) onRename(id, t);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="min-w-0 flex-1 rounded bg-panel px-1 outline-none ring-1 ring-edge"
                  aria-label="Notebook title"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{nb.title}</span>
              )}
              {isBusy && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-link group-hover:hidden" title="Working…" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={`Close ${nb.title}`}
                className={`-mr-0.5 shrink-0 rounded p-0.5 text-ink-3 hover:bg-edge hover:text-ink ${
                  active ? "flex" : "hidden group-hover:flex"
                }`}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
        <button
          onClick={onNew}
          title="Open a notebook (⌘K)"
          aria-label="Open a notebook"
          className="shrink-0 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={15} strokeWidth={1.8} />
        </button>
      </div>

      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
