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
  LayoutTemplate,
  List,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Folder, Notebook } from "../lib/types";
import { fileToCoverDataUrl, formatTime } from "../lib/source";
import { GhostButton, IconButton, Modal, PrimaryButton } from "./ui";

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
  trashedNotebooks,
  folders,
  onOpen,
  onCreate,
  onTrash,
  onRestore,
  onDeleteForever,
  onUpdateDetails,
  onToggleStar,
  onSetCover,
  onMoveNotebook,
  onCreateFolder,
  onUpdateFolder,
  onSetFolderCover,
  onDeleteFolder,
  onUseTemplate,
  onMoveNotebookBulk,
  onTrashBulk,
  onRestoreBulk,
  onDeleteForeverBulk,
  onSettings,
}: {
  notebooks: Notebook[];
  trashedNotebooks: Notebook[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onCreate: (title: string, description: string, folderId: string, cover: string) => void;
  /** Move to Trash (soft delete — restorable). */
  onTrash: (id: string) => void;
  /** Restore from the Trash back to the homepage. */
  onRestore: (id: string) => void;
  /** Permanent delete from the Trash — irreversible. */
  onDeleteForever: (id: string) => void;
  /** Bulk move (homepage Select mode): one call per selected notebook. */
  onMoveNotebookBulk: (ids: string[], folderId: string) => void;
  /** Bulk trash (homepage Select mode). */
  onTrashBulk: (ids: string[]) => void;
  /** Bulk restore from the Trash. */
  onRestoreBulk: (ids: string[]) => void;
  /** Bulk permanent delete from the Trash. */
  onDeleteForeverBulk: (ids: string[]) => void;
  onUpdateDetails: (id: string, title: string, description: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onSetCover: (id: string, cover: string) => void;
  onMoveNotebook: (id: string, folderId: string) => void;
  onCreateFolder: (name: string, description: string, cover: string) => void;
  onUpdateFolder: (id: string, name: string, description: string) => void;
  onSetFolderCover: (id: string, cover: string) => void;
  onDeleteFolder: (id: string) => void;
  /** Sources-only starter copy of a notebook ("Use as template" card action). */
  onUseTemplate: (id: string) => void;
  onSettings: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [createCover, setCreateCover] = useState("");
  const createCoverInputRef = useRef<HTMLInputElement>(null);
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
  /** Trash view open (recycle-bin list) vs. normal notebooks view. */
  const [trashOpen, setTrashOpen] = useState(false);
  /** "Move to Trash?" confirmation for a notebook. */
  const [trashing, setTrashing] = useState<Notebook | null>(null);
  /** "Delete forever?" confirmation inside the Trash. */
  const [purging, setPurging] = useState<Notebook | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [view, setView] = useState<View>(storedView);
  const [sort, setSort] = useState<SortKey>(storedSort);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  /** Homepage selection mode (Select button) — click cards to toggle. */
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Move-to-folder dropdown while selecting. */
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  /** Bulk confirm modals: trash N / purge N. */
  const [bulkTrashing, setBulkTrashing] = useState(false);
  const [bulkPurging, setBulkPurging] = useState(false);

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

  /* ------------------------------ selection (Select mode) ------------------------------ */

  const toggleSelect = (id: string) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const exitSelect = () => {
    setSelecting(false);
    setSelectedIds([]);
    setMoveMenuOpen(false);
  };

  /** Clicking a card in Select mode toggles it instead of opening. */
  const handleCardClick = (id: string) => {
    if (selecting) toggleSelect(id);
    else onOpen(id);
  };

  /* ------------------------------ actions ------------------------------ */

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(t, description.trim(), viewing?.id ?? "", createCover);
    setTitle("");
    setDescription("");
    setCreateCover("");
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

  const pickCoverFile = async (set: (cover: string) => void, file: File | undefined) => {
    if (!file) return;
    try {
      set(await fileToCoverDataUrl(file));
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
        title="Delete folder (its notebooks move back to the Brewery)"
        role="button"
        aria-label={`Delete folder ${f.name}`}
      >
        <Trash2 size={13} strokeWidth={1.8} />
      </span>
    </span>
  );

  /* ------------------------------ shared bits ------------------------------ */

  /** Star / template / edit / delete — the action cluster shared by cards and rows. */
  const actionCluster = (
    nb: Notebook,
    iconSize: { star: number; pencil: number; template: number; trash: number }
  ) => (
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
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-hover-soft hover:text-ink group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onUseTemplate(nb.id);
        }}
        title="Use as template — new notebook with these sources (no chats)"
        role="button"
        aria-label={`Use ${nb.title} as template`}
      >
        <LayoutTemplate size={iconSize.template} strokeWidth={1.8} />
      </span>
      <span
        className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-danger-bg hover:text-danger group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          setTrashing(nb);
        }}
        title="Move to Trash"
        role="button"
        aria-label={`Move ${nb.title} to Trash`}
      >
        <Trash2 size={iconSize.trash} strokeWidth={1.8} />
      </span>
    </span>
  );

  /* ------------------------------ cards & rows ------------------------------ */

  const renderCard = (nb: Notebook) => {
    const selected = selecting && selectedIds.includes(nb.id);
    return (
    <div
      key={nb.id}
      onClick={() => handleCardClick(nb.id)}
      draggable={!selecting}
      onDragStart={(e) => !selecting && nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group relative flex h-[136px] cursor-pointer flex-col overflow-hidden rounded-xl border bg-panel transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
        draggingId === nb.id ? "opacity-50" : ""
      } ${selected ? "border-accent ring-2 ring-accent/40" : "border-edge"}`}
    >
      {selecting && (
        <span
          className={`absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
            selected
              ? "border-accent bg-accent text-accent-ink"
              : "border-ink-3 bg-panel/80 opacity-0 text-transparent group-hover:opacity-100"
          }`}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </span>
      )}
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
          {!selecting && actionCluster(nb, { star: 13, template: 12.5, pencil: 12.5, trash: 13 })}
        </div>
      </div>
    </div>
    );
  };

  const renderRow = (nb: Notebook) => {
    const selected = selecting && selectedIds.includes(nb.id);
    return (
    <div
      key={nb.id}
      onClick={() => handleCardClick(nb.id)}
      draggable={!selecting}
      onDragStart={(e) => !selecting && nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group flex cursor-pointer items-center gap-3 rounded-lg border bg-panel px-4 py-3 transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
        draggingId === nb.id ? "opacity-50" : ""
      } ${selected ? "border-accent ring-2 ring-accent/40" : "border-edge"}`}
    >
      {selecting && (
        <span
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${
            selected ? "border-accent bg-accent text-accent-ink" : "border-ink-3 text-transparent"
          }`}
        >
          {selected && <Check size={10} strokeWidth={3} />}
        </span>
      )}
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
      {!selecting && actionCluster(nb, { star: 13.5, template: 13, pencil: 13, trash: 13.5 })}
    </div>
    );
  };

  const renderFolderCard = (f: Folder) => {
    const count = folderCounts.get(f.id) ?? 0;
    const highlight = dropTarget === f.id;
    return (
      <div
        key={f.id}
        onClick={() => {
          setOpenFolderId(f.id);
          exitSelect();
        }}
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
        onClick={() => {
          setOpenFolderId(f.id);
          exitSelect();
        }}
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
          <img
            src="/brewlm-logo.png"
            alt="BrewLM logo"
            className="h-6 w-6 object-contain"
          />
          <span className="text-[15px] font-semibold tracking-tight">BrewLM</span>
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
        <IconButton
          onClick={() => {
            setTrashOpen((v) => !v);
            exitSelect();
          }}
          label={trashOpen ? "Back to notebooks" : `Trash (${trashedNotebooks.length})`}
        >
          <span className="relative">
            <Trash2 size={16} strokeWidth={1.8} />
            {trashedNotebooks.length > 0 && (
              <span className="absolute -right-2 -top-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-ink">
                {trashedNotebooks.length}
              </span>
            )}
          </span>
        </IconButton>
        <IconButton onClick={onSettings} label="Settings">
          <SettingsIcon size={16} strokeWidth={1.8} />
        </IconButton>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        {trashOpen ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <h1 className="text-[22px] font-semibold tracking-tight">Trash</h1>
                <p className="mt-0.5 text-[13px] text-ink-3">
                  Restore notebooks to bring them back, or delete them forever.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selecting ? (
                  <>
                    <span className="text-[12.5px] font-medium text-ink-2">
                      {selectedIds.length} selected
                    </span>
                    <button
                      onClick={() => {
                        onRestoreBulk(selectedIds);
                        exitSelect();
                      }}
                      disabled={selectedIds.length === 0}
                      className="flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft disabled:opacity-40"
                    >
                      <RotateCcw size={13} strokeWidth={1.8} />
                      Restore
                    </button>
                    <button
                      onClick={() => setBulkPurging(true)}
                      disabled={selectedIds.length === 0}
                      className="flex items-center gap-1.5 rounded-full border border-danger-edge bg-danger-bg px-3.5 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:opacity-80 disabled:opacity-40"
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                      Delete forever
                    </button>
                    <GhostButton onClick={exitSelect}>Done</GhostButton>
                  </>
                ) : (
                  trashedNotebooks.length > 0 && (
                    <button
                      onClick={() => setSelecting(true)}
                      className="rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                    >
                      Select
                    </button>
                  )
                )}
              </div>
            </div>
            {trashedNotebooks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Trash2 size={20} strokeWidth={1.8} className="text-ink-3" />
                <p className="mt-3 text-[13.5px] font-medium">The Trash is empty</p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  Notebooks you delete will show up here first.
                </p>
              </div>
            ) : (
              <div className={listClass}>
                {trashedNotebooks.map((nb) => {
                  const selected = selecting && selectedIds.includes(nb.id);
                  return (
                  <div
                    key={nb.id}
                    onClick={() => selecting && toggleSelect(nb.id)}
                    className={`group flex items-center gap-3 rounded-lg border bg-panel px-4 py-3 transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
                      selecting ? "cursor-pointer" : ""
                    } ${selected ? "border-accent ring-2 ring-accent/40" : "border-edge"}`}
                  >
                    {selecting && (
                      <span
                        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${
                          selected ? "border-accent bg-accent text-accent-ink" : "border-ink-3 text-transparent"
                        }`}
                      >
                        {selected && <Check size={10} strokeWidth={3} />}
                      </span>
                    )}
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-canvas text-ink-2">
                      <BookOpen size={14} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium tracking-tight">{nb.title}</p>
                      <p className="mt-0.5 truncate text-[11.5px] text-ink-3">
                        Deleted {formatTime(nb.trashed_at)}
                      </p>
                    </div>
                    {!selecting && (
                      <>
                        <button
                          onClick={() => onRestore(nb.id)}
                          className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover-soft hover:text-ink"
                        >
                          <RotateCcw size={12} strokeWidth={1.8} />
                          Restore
                        </button>
                        <button
                          onClick={() => setPurging(nb)}
                          className="flex shrink-0 items-center gap-1.5 rounded-full border border-danger-edge bg-danger-bg px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:opacity-80"
                        >
                          <Trash2 size={12} strokeWidth={1.8} />
                          Delete forever
                        </button>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-end justify-between">
            <div className="flex items-center gap-3">
              {viewing && (
                <button
                  onClick={() => {
                    setOpenFolderId(null);
                    exitSelect();
                  }}
                  {...dropZoneProps("root")}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                    dropTarget === "root"
                      ? "border-accent bg-panel text-accent ring-2 ring-accent/30"
                      : "border-edge bg-panel text-ink-2 hover:bg-hover-soft"
                  }`}
                  title="Back to Brewery — drop here to move a notebook out of this folder"
                >
                  <ArrowLeft size={13} strokeWidth={2} />
                  Brewery
                </button>
              )}
              <div>
                <h1 className="text-[22px] font-semibold tracking-tight">
                  {viewing ? viewing.name : "Brewery"}
                </h1>
                {viewing && (
                  <p className="mt-0.5 text-[13px] text-ink-3">
                    {viewing.description ||
                      (folderCounts.get(viewing.id) === 1
                        ? "1 notebook"
                        : `${folderCounts.get(viewing.id) ?? 0} notebooks`)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selecting ? (
                <>
                  <span className="text-[12.5px] font-medium text-ink-2">
                    {selectedIds.length} selected
                  </span>
                  {/* Move to folder */}
                  <div className="relative">
                    <button
                      onClick={() => setMoveMenuOpen((v) => !v)}
                      disabled={selectedIds.length === 0}
                      className="flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft disabled:opacity-40"
                      aria-haspopup="menu"
                      aria-expanded={moveMenuOpen}
                    >
                      <FolderClosed size={13} strokeWidth={1.8} />
                      Move to folder…
                      <ChevronDown
                        size={12}
                        strokeWidth={2}
                        className={`transition-transform ${moveMenuOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {moveMenuOpen && selectedIds.length > 0 && (
                      <>
                        <div
                          className="fixed inset-0 z-10 cursor-default"
                          onClick={() => setMoveMenuOpen(false)}
                        />
                        <div
                          role="menu"
                          className="anim-fade-up absolute right-0 z-20 mt-1.5 w-48 rounded-xl border border-edge bg-panel p-1 shadow-lg"
                        >
                          <button
                            role="menuitem"
                            onClick={() => {
                              onMoveNotebookBulk(selectedIds, "");
                              exitSelect();
                            }}
                            className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-hover-soft"
                          >
                            No folder (Brewery)
                          </button>
                          {folders.map((f) => (
                            <button
                              key={f.id}
                              role="menuitem"
                              onClick={() => {
                                onMoveNotebookBulk(selectedIds, f.id);
                                exitSelect();
                              }}
                              className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-hover-soft"
                            >
                              {f.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    onClick={() => setBulkTrashing(true)}
                    disabled={selectedIds.length === 0}
                    className="flex items-center gap-1.5 rounded-full border border-danger-edge bg-danger-bg px-3.5 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:opacity-80 disabled:opacity-40"
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                    Move to Trash
                  </button>
                  <GhostButton onClick={exitSelect}>Done</GhostButton>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setSelecting(true)}
                    className="rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                  >
                    Select
                  </button>
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
                </>
              )}
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
        )}
      </div>

      {/* ------------------------------ modals ------------------------------ */}

      {/* Are-you-sure before a notebook heads to the Trash. */}
      {trashing && (
        <Modal title="Move to Trash?" onClose={() => setTrashing(null)}>
          <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">
            “{trashing.title}” and its sources, chats, and studio work will move to the
            Trash. You can restore it from there anytime.
          </p>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => setTrashing(null)}>Cancel</GhostButton>
            <PrimaryButton
              onClick={() => {
                const id = trashing.id;
                setTrashing(null);
                onTrash(id);
              }}
            >
              Move to Trash
            </PrimaryButton>
          </div>
        </Modal>
      )}

      {/* Bulk: move all selected notebooks to the Trash. */}
      {bulkTrashing && (
        <Modal title="Move selected to Trash?" onClose={() => setBulkTrashing(false)}>
          <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">
            {selectedIds.length === 1
              ? "1 notebook"
              : `${selectedIds.length} notebooks`}{" "}
            will move to the Trash, sources, chats, and studio work included. You can
            restore them from there anytime.
          </p>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => setBulkTrashing(false)}>Cancel</GhostButton>
            <PrimaryButton
              onClick={() => {
                setBulkTrashing(false);
                onTrashBulk(selectedIds);
                exitSelect();
              }}
            >
              Move to Trash
            </PrimaryButton>
          </div>
        </Modal>
      )}

      {/* Bulk: permanently delete all selected from the Trash. */}
      {bulkPurging && (
        <Modal title="Delete selected forever?" onClose={() => setBulkPurging(false)}>
          <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">
            {selectedIds.length === 1
              ? "1 notebook"
              : `${selectedIds.length} notebooks`}{" "}
            and everything in them will be permanently deleted. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => setBulkPurging(false)}>Cancel</GhostButton>
            <button
              onClick={() => {
                setBulkPurging(false);
                onDeleteForeverBulk(selectedIds);
                exitSelect();
              }}
              className="rounded-full bg-danger px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
            >
              Delete forever
            </button>
          </div>
        </Modal>
      )}

      {/* Permanent deletion — irreversible. */}
      {purging && (
        <Modal title="Delete forever?" onClose={() => setPurging(null)}>
          <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">
            “{purging.title}” and everything in it will be permanently deleted. This
            can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => setPurging(null)}>Cancel</GhostButton>
            <button
              onClick={() => {
                const id = purging.id;
                setPurging(null);
                onDeleteForever(id);
              }}
              className="rounded-full bg-danger px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
            >
              Delete forever
            </button>
          </div>
        </Modal>
      )}

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
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                Cover image{" "}
                <span className="font-normal text-ink-3">(optional — grid view only)</span>
              </label>
              {createCover ? (
                <div className="flex items-start gap-3">
                  <img
                    src={createCover}
                    alt="Cover preview"
                    className="h-[72px] w-[128px] rounded-lg border border-edge object-cover"
                  />
                  <div className="flex flex-col gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => createCoverInputRef.current?.click()}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateCover("")}
                      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-danger hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => createCoverInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-3 py-3 text-[12.5px] font-medium text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
                >
                  <ImagePlus size={14} strokeWidth={1.8} />
                  Choose a JPEG or PNG…
                </button>
              )}
              <input
                ref={createCoverInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  void pickCoverFile(setCreateCover, e.target.files?.[0]);
                  e.target.value = ""; // allow picking the same file twice in a row
                }}
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
                <option value="">No folder (Brewery)</option>
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
                  void pickCoverFile(setEditCover, e.target.files?.[0]);
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
