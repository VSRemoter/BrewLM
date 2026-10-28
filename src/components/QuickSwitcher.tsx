import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { mediaSrc } from "../lib/blobs";
import type { Folder, Notebook } from "../lib/types";

type Item = { kind: "notebook"; nb: Notebook } | { kind: "new"; title: string };

/**
 * ⌘K: type to find a notebook and open it in a tab (⌘↩ opens it in the
 * background), or make a new one named after what was typed.
 */
export default function QuickSwitcher({
  notebooks,
  folders,
  openIds,
  onOpen,
  onCreate,
  onClose,
}: {
  notebooks: Notebook[];
  folders: Folder[];
  /** Notebooks that already have a tab. */
  openIds: string[];
  onOpen: (id: string, background: boolean) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  const items = useMemo<Item[]>(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = notebooks
      .filter((nb) => {
        const hay = `${nb.title} ${folderName.get(nb.folder_id) ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      // Titles that start with the query first, then the most recently changed.
      .sort((a, b) => {
        const q = words.join(" ");
        const pa = q && a.title.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = q && b.title.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || b.updated_at - a.updated_at;
      })
      .slice(0, 50)
      .map((nb): Item => ({ kind: "notebook", nb }));
    return [...matches, { kind: "new", title: query.trim() }];
  }, [notebooks, query, folderName]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (item: Item, background: boolean) => {
    if (item.kind === "new") onCreate(item.title || "Untitled notebook");
    else onOpen(item.nb.id, background);
    onClose();
  };

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="anim-pop w-full max-w-lg overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
        role="dialog"
        aria-label="Open a notebook"
      >
        <div className="flex items-center gap-2.5 border-b border-edge-soft px-4">
          <Search size={15} strokeWidth={1.8} className="shrink-0 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (items[sel]) choose(items[sel], e.metaKey || e.ctrlKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Find a notebook"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
            aria-label="Find a notebook"
          />
        </div>
        <div ref={listRef} className="max-h-[min(400px,50vh)] overflow-y-auto p-1.5" role="listbox">
          {items.map((item, i) => (
            <div
              key={item.kind === "new" ? "new" : item.nb.id}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              onMouseMove={() => setSel(i)}
              onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
              className={`flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] ${
                i === sel ? "bg-hover text-ink" : "text-ink-2"
              }`}
            >
              {item.kind === "new" ? (
                <>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dashed border-edge text-ink-3">
                    <Plus size={13} strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {item.title ? <>New notebook “{item.title}”</> : "New notebook"}
                  </span>
                </>
              ) : (
                <>
                  {item.nb.cover ? (
                    <img src={mediaSrc(item.nb.cover)} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-hover text-[11px] font-semibold uppercase text-ink-2">
                      {item.nb.title.trim()[0] ?? "·"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.nb.title}</span>
                  {item.nb.folder_id && folderName.has(item.nb.folder_id) && (
                    <span className="max-w-[140px] shrink-0 truncate text-[11.5px] text-ink-3">
                      {folderName.get(item.nb.folder_id)}
                    </span>
                  )}
                  {openIds.includes(item.nb.id) && (
                    <span className="shrink-0 rounded-full bg-hover-soft px-1.5 text-[10.5px] text-ink-3 ring-1 ring-edge">Open</span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-4 border-t border-edge-soft px-4 py-2 text-[11px] text-ink-3">
          <span>↩ open</span>
          <span>⌘↩ open in background</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
