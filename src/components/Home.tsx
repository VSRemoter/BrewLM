import {
  ArrowLeft,
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronDown,
  FolderClosed,
  FolderPlus,
  ImagePlus,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Folder, Notebook } from "../lib/types";
import { fileToCoverDataUrl, formatTime } from "../lib/source";
import { IconButton, Modal, PrimaryButton } from "./ui";

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

/** Custom DnD payload so folder drop targets ignore OS files and other drags. */
const DND_NOTEBOOK = "application/x-notebook-id";

/* ------------------------------ view & sort prefs ------------------------------ */

const LS_VIEW = "om.home.view";
const LS_SORT = "om.home.sort";

type View = "grid" | "list";

const SORTS = ["date-desc", "date-asc", "name-asc", "name-desc"] as const;
type SortKey = (typeof SORTS)[number];

const SORT_LABELS: Record<SortKey, string> = {
  "date-desc": "Most recent",
  "date-asc": "Least recent",
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
};

const SORT_COMPARE: Record<SortKey, (a: Notebook, b: Notebook) => number> = {
  "date-desc": (a, b) => b.updated_at - a.updated_at,
  "date-asc": (a, b) => a.updated_at - b.updated_at,
  "name-asc": (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }),
  "name-desc": (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base", numeric: true }),
};

function storedView(): View {
  return localStorage.getItem(LS_VIEW) === "list" ? "list" : "grid";
}

function storedSort(): SortKey {
  const v = localStorage.getItem(LS_SORT) as SortKey | null;
  return v && (SORTS as readonly string[]).includes(v) ? v : "date-desc";
}

export default function Home({
  notebooks,
  folders,
  onOpen,
  onCreate,
  onDelete,
  onUpdateDetails,
  onToggleStar,
  onSetCover,
  onMoveNotebook,
  onCreateFolder,
  onUpdateFolder,
  onSetFolderCover,
  onDeleteFolder,
  onSettings,
}: {
  notebooks: Notebook[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onCreate: (title: string, description: string, folderId: string) => void;
  onDelete: (id: string) => void;
  onUpdateDetails: (id: string, title: string, description: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onSetCover: (id: string, cover: string) => void;
  onMoveNotebook: (id: string, folderId: string) => void;
  onCreateFolder: (name: string, description: string, cover: string) => void;
  onUpdateFolder: (id: string, name: string, description: string) => void;
  onSetFolderCover: (id: string, cover: string) => void;
  onDeleteFolder: (id: string) => void;
  onSettings: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Notebook | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCover, setEditCover] = useState("");
  const [editFolderId, setEditFolderId] = useState("");
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [folderModal, setFolderModal] = useState<{ folder: Folder | null } | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderDescription, setFolderDescription] = useState("");
  const [folderCover, setFolderCover] = useState("");
  const folderCoverInputRef = useRef<HTMLInputElement>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [view, setView] = useState<View>(storedView);
  const [sort, setSort] = useState<SortKey>(storedSort);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  useEffect(() => { localStorage.setItem(LS_VIEW, view); }, [view]);
  useEffect(() => { localStorage.setItem(LS_SORT, sort); }, [sort]);

  /* ------------------------------ data shaping ------------------------------ */

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  /** The folder being browsed (null = homepage root); falls back to root if deleted. */
  const viewing = openFolderId ? folders.find((f) => f.id === openFolderId) ?? null : null;

  /** Notebooks at the current level, filtered by search. */
  const visible = useMemo(
    () =>
      notebooks.filter((nb) => {
        const here = viewing ? nb.folder_id === viewing.id : !nb.folder_id;
        if (!here) return false;
        if (!q) return true;
        return nb.title.toLowerCase().includes(q) || nb.description.toLowerCase().includes(q);
      }),
    [notebooks, viewing, q]
  );

  /** Root level also shows folders; search filters them by name/description. */
  const visibleFolders = useMemo(
    () =>
      viewing
        ? []
        : folders.filter(
            (f) =>
              !q ||
              f.name.toLowerCase().includes(q) ||
              f.description.toLowerCase().includes(q)
          ),
    [folders, viewing, q]
  );

  /** Notebook counts per folder, for the cards' subtitles. */
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const nb of notebooks) {
      if (nb.folder_id) m.set(nb.folder_id, (m.get(nb.folder_id) ?? 0) + 1);
    }
    return m;
  }, [notebooks]);

  /** Starred notebooks pin to the top; the active sort orders within each group. */
  const ordered = useMemo(
    () => [...visible].sort((a, b) => b.starred - a.starred || SORT_COMPARE[sort](a, b)),
    [visible, sort]
  );

  /* ------------------------------ actions ------------------------------ */

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(t, description.trim(), viewing?.id ?? "");
    setTitle("");
    setDescription("");
    setCreating(false);
  };

  const openEdit = (nb: Notebook) => {
    setEditing(nb);
    setEditTitle(nb.title);
    setEditDescription(nb.description);
    setEditCover(nb.cover);
    setEditFolderId(nb.folder_id);
  };

  const submitEdit = () => {
    if (!editing) return;
    const t = editTitle.trim();
    const d = editDescription.trim();
    if (t && (t !== editing.title || d !== editing.description)) {
      onUpdateDetails(editing.id, t, d);
    }
    if (editCover !== editing.cover) {
      onSetCover(editing.id, editCover);
    }
    if (editFolderId !== editing.folder_id) {
      onMoveNotebook(editing.id, editFolderId);
    }
    setEditing(null);
  };

  const pickCoverFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setEditCover(await fileToCoverDataUrl(file));
    } catch {
      /* non-image or unreadable — ignore */
    }
  };

  /* ------------------------------ folder actions ------------------------------ */

  const openFolderModal = (folder: Folder | null) => {
    setFolderModal({ folder });
    setFolderName(folder?.name ?? "");
    setFolderDescription(folder?.description ?? "");
    setFolderCover(folder?.cover ?? "");
  };

  const submitFolder = () => {
    if (!folderModal) return;
    const n = folderName.trim();
    if (!n) return;
    const d = folderDescription.trim();
    if (folderModal.folder) {
      const f = folderModal.folder;
      if (n !== f.name || d !== f.description) onUpdateFolder(f.id, n, d);
      if (folderCover !== f.cover) onSetFolderCover(f.id, folderCover);
    } else {
      onCreateFolder(n, d, folderCover);
    }
    setFolderModal(null);
  };

  const pickFolderCoverFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setFolderCover(await fileToCoverDataUrl(file));
    } catch {
      /* non-image or unreadable — ignore */
    }
  };

  /* ------------------------------ drag & drop ------------------------------ */

  const nbDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData(DND_NOTEBOOK, id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  };

  const nbDragEnd = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  /** Shared drop-target wiring for folder cards/rows and the root breadcrumb. */
  const dropZoneProps = (target: string | "root") => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DND_NOTEBOOK)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    },
    onDragEnter: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DND_NOTEBOOK)) setDropTarget(target);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DND_NOTEBOOK);
      setDropTarget(null);
      setDraggingId(null);
      if (id) onMoveNotebook(id, target === "root" ? "" : target);
    },
  });

  /** Pencil / trash cluster for folders. */
  const folderActionCluster = (f: Folder) => (
    <span className="flex shrink-0 items-center gap-0.5">
      <span
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-hover-soft hover:text-ink group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          openFolderModal(f);
        }}
        title="Edit folder"
        role="button"
        aria-label={`Edit folder ${f.name}`}
      >
        <Pencil size={12.5} strokeWidth={1.8} />
      </span>
      <span
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-danger-bg hover:text-danger group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteFolder(f.id);
        }}
        title="Delete folder (its notebooks move back to Notebooks)"
        role="button"
        aria-label={`Delete folder ${f.name}`}
      >
        <Trash2 size={13} strokeWidth={1.8} />
      </span>
    </span>
  );

  /* ------------------------------ shared bits ------------------------------ */

  /** Star / edit / delete — the action cluster shared by cards and rows. */
  const actionCluster = (nb: Notebook, iconSize: { star: number; pencil: number; trash: number }) => (
    <span className="flex shrink-0 items-center gap-0.5">
      <span
        className={`rounded-md p-1 transition-all hover:bg-hover-soft ${
          nb.starred
            ? "text-accent"
            : "text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(nb.id, !nb.starred);
        }}
        title={nb.starred ? "Unstar notebook" : "Star notebook (pins to top)"}
        role="button"
        aria-label={nb.starred ? `Unstar ${nb.title}` : `Star ${nb.title}`}
      >
        <Star size={iconSize.star} strokeWidth={1.8} fill={nb.starred ? "currentColor" : "none"} />
      </span>
      <span
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-hover-soft hover:text-ink group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          openEdit(nb);
        }}
        title="Edit notebook"
        role="button"
        aria-label={`Edit ${nb.title}`}
      >
        <Pencil size={iconSize.pencil} strokeWidth={1.8} />
      </span>
      <span
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-danger-bg hover:text-danger group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(nb.id);
        }}
        title="Delete notebook"
        role="button"
        aria-label={`Delete ${nb.title}`}
      >
        <Trash2 size={iconSize.trash} strokeWidth={1.8} />
      </span>
    </span>
  );

  /* ------------------------------ cards & rows ------------------------------ */

  const renderCard = (nb: Notebook) => (
    <div
      key={nb.id}
      onClick={() => onOpen(nb.id)}
      draggable
      onDragStart={(e) => nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group relative flex h-[136px] cursor-pointer flex-col overflow-hidden rounded-xl border border-edge bg-panel transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
        draggingId === nb.id ? "opacity-50" : ""
      }`}
    >
      {nb.cover && (
        <img
          src={nb.cover}
          alt=""
          draggable={false}
          className="h-[64px] w-full shrink-0 object-cover"
        />
      )}
      <div className={`flex min-h-0 flex-1 flex-col justify-between ${nb.cover ? "p-3" : "p-4"}`}>
        <div className="min-w-0">
          <span
            className={`text-[13.5px] font-medium leading-snug tracking-tight ${
              nb.cover ? "line-clamp-1" : "line-clamp-2"
            }`}
          >
            {nb.title}
          </span>
          {nb.description && !nb.cover && (
            <p className="mt-1 line-clamp-1 text-[11.5px] leading-snug text-ink-3">
              {nb.description}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-ink-3">{formatTime(nb.updated_at)}</span>
          {actionCluster(nb, { star: 13, pencil: 12.5, trash: 13 })}
        </div>
      </div>
    </div>
  );

  const renderRow = (nb: Notebook) => (
    <div
      key={nb.id}
      onClick={() => onOpen(nb.id)}
      draggable
      onDragStart={(e) => nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group flex cursor-pointer items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-3 transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
        draggingId === nb.id ? "opacity-50" : ""
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-canvas text-ink-2">
        <BookOpen size={14} strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium tracking-tight">{nb.title}</p>
        {nb.description && (
          <p className="mt-0.5 truncate text-[11.5px] text-ink-3">{nb.description}</p>
        )}
      </div>
      <span className="shrink-0 text-[11.5px] text-ink-3">{formatTime(nb.updated_at)}</span>
      {actionCluster(nb, { star: 13.5, pencil: 13, trash: 13.5 })}
    </div>
  );

  const renderFolderCard = (f: Folder) => {
    const count = folderCounts.get(f.id) ?? 0;
    const highlight = dropTarget === f.id;
    return (
      <div
        key={f.id}
        onClick={() => setOpenFolderId(f.id)}
        {...dropZoneProps(f.id)}
        className={`group relative flex h-[136px] cursor-pointer flex-col overflow-hidden rounded-xl border bg-panel transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
          highlight ? "border-accent ring-2 ring-accent/30" : "border-edge"
        }`}
      >
        {f.cover && (
          <img
            src={f.cover}
            alt=""
            draggable={false}
            className="h-[64px] w-full shrink-0 object-cover"
          />
        )}
        <div className={`flex min-h-0 flex-1 flex-col justify-between ${f.cover ? "p-3" : "p-4"}`}>
          <div className="flex min-w-0 items-start gap-2">
            <FolderClosed size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-3" />
            <span
              className={`min-w-0 text-[13.5px] font-medium leading-snug tracking-tight ${
                f.cover ? "line-clamp-1" : "line-clamp-2"
              }`}
            >
              {f.name}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-ink-3">
              {count === 1 ? "1 notebook" : `${count} notebooks`}
            </span>
            {folderActionCluster(f)}
          </div>
        </div>
      </div>
    );
  };

  const renderFolderRow = (f: Folder) => {
    const count = folderCounts.get(f.id) ?? 0;
    const highlight = dropTarget === f.id;
    return (
      <div
        key={f.id}
        onClick={() => setOpenFolderId(f.id)}
        {...dropZoneProps(f.id)}
        className={`group flex cursor-pointer items-center gap-3 rounded-lg border bg-panel px-4 py-3 transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
          highlight ? "border-accent ring-2 ring-accent/30" : "border-edge"
        }`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-canvas text-ink-2">
          <FolderClosed size={14} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium tracking-tight">{f.name}</p>
          <p className="mt-0.5 truncate text-[11.5px] text-ink-3">
            {f.description || (count === 1 ? "1 notebook" : `${count} notebooks`)}
          </p>
        </div>
        {folderActionCluster(f)}
      </div>
    );
  };

  const newNotebookCard = (
    <button
      key="new"
      onClick={() => setCreating(true)}
      className="group flex h-[136px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <Plus size={16} strokeWidth={2} />
      </span>
      <span className="text-[13px] font-medium">New notebook</span>
    </button>
  );

  const newFolderCard = (
    <button
      key="new-folder"
      onClick={() => openFolderModal(null)}
      className="group flex h-[136px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <FolderPlus size={16} strokeWidth={1.8} />
      </span>
      <span className="text-[13px] font-medium">New folder</span>
    </button>
  );

  const newNotebookRow = (
    <button
      key="new"
      onClick={() => setCreating(true)}
      className="group flex w-full items-center gap-3 rounded-lg border border-dashed border-edge bg-transparent px-4 py-3 text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <Plus size={15} strokeWidth={2} />
      </span>
      <span className="text-[13px] font-medium">New notebook</span>
    </button>
  );

  const newFolderRow = (
    <button
      key="new-folder"
      onClick={() => openFolderModal(null)}
      className="group flex w-full items-center gap-3 rounded-lg border border-dashed border-edge bg-transparent px-4 py-3 text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <FolderPlus size={15} strokeWidth={1.8} />
      </span>
      <span className="text-[13px] font-medium">New folder</span>
    </button>
  );

  const gridClass = "grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3.5";
  const listClass = "flex flex-col gap-2";

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-edge-soft bg-panel px-6">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent">
            <BookOpen size={13} strokeWidth={2.2} className="text-accent-ink" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">OpenMind</span>
        </div>
        <div className="relative mx-auto w-full max-w-md">
          <Search
            size={14}
            strokeWidth={1.8}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search notebooks…"
            aria-label="Search notebooks"
            className="w-full rounded-full border border-edge bg-canvas py-1.5 pl-9 pr-8 text-[13px] outline-none placeholder:text-ink-3 focus:border-ink-3"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          )}
        </div>
        <IconButton onClick={onSettings} label="Settings">
          <SettingsIcon size={16} strokeWidth={1.8} />
        </IconButton>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-end justify-between">
            <div className="flex items-center gap-3">
              {viewing && (
                <button
                  onClick={() => setOpenFolderId(null)}
                  {...dropZoneProps("root")}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                    dropTarget === "root"
                      ? "border-accent bg-panel text-accent ring-2 ring-accent/30"
                      : "border-edge bg-panel text-ink-2 hover:bg-hover-soft"
                  }`}
                  title="Back to Notebooks — drop here to move a notebook out of this folder"
                >
                  <ArrowLeft size={13} strokeWidth={2} />
                  Notebooks
                </button>
              )}
              <div>
                <h1 className="text-[22px] font-semibold tracking-tight">
                  {viewing ? viewing.name : "Notebooks"}
                </h1>
                <p className="mt-0.5 text-[13px] text-ink-3">
                  {viewing
                    ? viewing.description ||
                      (folderCounts.get(viewing.id) === 1
                        ? "1 notebook"
                        : `${folderCounts.get(viewing.id) ?? 0} notebooks`)
                    : "Each notebook is a workspace for your sources, chats, and study tools."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Sort picker */}
              <div className="relative">
                <button
                  onClick={() => setSortMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                  aria-label="Sort notebooks"
                  aria-haspopup="menu"
                  aria-expanded={sortMenuOpen}
                >
                  <ArrowUpDown size={13} strokeWidth={1.8} />
                  {SORT_LABELS[sort]}
                  <ChevronDown
                    size={12}
                    strokeWidth={2}
                    className={`transition-transform ${sortMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {sortMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setSortMenuOpen(false)}
                    />
                    <div
                      role="menu"
                      className="anim-fade-up absolute right-0 z-20 mt-1.5 w-44 rounded-xl border border-edge bg-panel p-1 shadow-lg"
                    >
                      {SORTS.map((s) => (
                        <button
                          key={s}
                          role="menuitem"
                          onClick={() => {
                            setSort(s);
                            setSortMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                            s === sort ? "font-medium text-ink" : "text-ink-2 hover:bg-hover-soft"
                          }`}
                        >
                          {SORT_LABELS[s]}
                          {s === sort && <Check size={13} strokeWidth={2.2} />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* Grid / list toggle */}
              <IconButton
                onClick={() => setView((v) => (v === "grid" ? "list" : "grid"))}
                label={view === "grid" ? "Switch to list view" : "Switch to grid view"}
              >
                {view === "grid" ? (
                  <List size={15} strokeWidth={1.8} />
                ) : (
                  <LayoutGrid size={15} strokeWidth={1.8} />
                )}
              </IconButton>
            </div>
          </div>

          {searching && ordered.length === 0 && visibleFolders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Search size={20} strokeWidth={1.8} className="text-ink-3" />
              <p className="mt-3 text-[13.5px] font-medium">No notebooks found</p>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                Try a different title or description.
              </p>
            </div>
          ) : view === "grid" ? (
            <>
              <div className={gridClass}>
                {newNotebookCard}
                {!viewing && newFolderCard}
                {visibleFolders.map(renderFolderCard)}
                {ordered.map(renderCard)}
              </div>
              {viewing && ordered.length === 0 && !searching && (
                <p className="mt-4 text-center text-[12.5px] text-ink-3">
                  This folder is empty — drag notebooks in, or use a notebook's Edit → Folder menu.
                </p>
              )}
            </>
          ) : (
            <>
              <div className={listClass}>
                {newNotebookRow}
                {!viewing && newFolderRow}
                {visibleFolders.map(renderFolderRow)}
                {ordered.map(renderRow)}
              </div>
              {viewing && ordered.length === 0 && !searching && (
                <p className="mt-4 text-center text-[12.5px] text-ink-3">
                  This folder is empty — drag notebooks in, or use a notebook's Edit → Folder menu.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ------------------------------ modals ------------------------------ */}

      {creating && (
        <Modal
          title={viewing ? `New notebook in ${viewing.name}` : "New notebook"}
          onClose={() => setCreating(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Title</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Cognitive Science — Week 4"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Description <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this notebook about?"
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </div>
            <div className="flex justify-end gap-2">
              <PrimaryButton type="submit" disabled={!title.trim()}>
                Create notebook
              </PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title="Edit notebook" onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit();
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Title</label>
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Description <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="What is this notebook about?"
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Folder</label>
              <select
                value={editFolderId}
                onChange={(e) => setEditFolderId(e.target.value)}
                className={`${inputClass} appearance-none`}
              >
                <option value="">No folder (Notebooks)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Cover image{" "}
                <span className="font-normal text-ink-3">(optional — grid view only)</span>
              </label>
              {editCover ? (
                <div className="flex items-start gap-3">
                  <img
                    src={editCover}
                    alt="Cover preview"
                    className="h-[72px] w-[128px] rounded-lg border border-edge object-cover"
                  />
                  <div className="flex flex-col gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => coverInputRef.current?.click()}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditCover("")}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-danger hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-3 py-3 text-[12.5px] font-medium text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
                >
                  <ImagePlus size={14} strokeWidth={1.8} />
                  Choose a JPEG or PNG…
                </button>
              )}
              <input
                ref={coverInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  void pickCoverFile(e.target.files?.[0]);
                  e.target.value = ""; // allow picking the same file twice in a row
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <PrimaryButton type="submit" disabled={!editTitle.trim()}>
                Save changes
              </PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {folderModal && (
        <Modal
          title={folderModal.folder ? "Edit folder" : "New folder"}
          onClose={() => setFolderModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitFolder();
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Name</label>
              <input
                autoFocus
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="e.g. Math Courses"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Description <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <textarea
                value={folderDescription}
                onChange={(e) => setFolderDescription(e.target.value)}
                placeholder="What belongs in this folder?"
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Cover image{" "}
                <span className="font-normal text-ink-3">(optional — grid view only)</span>
              </label>
              {folderCover ? (
                <div className="flex items-start gap-3">
                  <img
                    src={folderCover}
                    alt="Cover preview"
                    className="h-[72px] w-[128px] rounded-lg border border-edge object-cover"
                  />
                  <div className="flex flex-col gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => folderCoverInputRef.current?.click()}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setFolderCover("")}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-danger hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => folderCoverInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-3 py-3 text-[12.5px] font-medium text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
                >
                  <ImagePlus size={14} strokeWidth={1.8} />
                  Choose a JPEG or PNG…
                </button>
              )}
              <input
                ref={folderCoverInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  void pickFolderCoverFile(e.target.files?.[0]);
                  e.target.value = ""; // allow picking the same file twice in a row
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <PrimaryButton type="submit" disabled={!folderName.trim()}>
                {folderModal.folder ? "Save changes" : "Create folder"}
              </PrimaryButton>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
