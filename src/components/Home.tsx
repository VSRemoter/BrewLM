import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronDown,
  Download,
  FolderClosed,
  FolderInput,
  FolderPlus,
  House,
  LayoutGrid,
  LayoutTemplate,
  Link2,
  List,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquareCheck,
  Settings as SettingsIcon,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Folder, Notebook } from "../lib/types";
import { mediaSrc } from "../lib/blobs";
import type { UpdateInfo } from "../lib/updates";
import { fileToCoverDataUrl, formatTime } from "../lib/source";
import { usePhone } from "../lib/usePhone";
import { BrewIcon } from "./BrewIcon";
import { GhostButton, IconButton, Modal, PrimaryButton } from "./ui";
import UpdateAction from "./UpdateAction";
import NotebookFormDialog from "./NotebookFormDialog";

/** Custom DnD payload so folder drop targets ignore OS files and other drags. */
const DND_NOTEBOOK = "application/x-notebook-id";

/* ------------------------------ view & sort prefs ------------------------------ */

const LS_VIEW = "om.home.view";
const LS_SORT = "om.home.sort";

type View = "grid" | "list";

const SORTS = ["date-desc", "date-asc", "name-asc", "name-desc"] as const;
type SortKey = (typeof SORTS)[number];

/** Quiet toolbar button inside a bordered group (28px tall). */
const toolbarBtn =
  "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";
/** Quiet standalone toolbar button (32px tall, matches the bordered controls). */
const toolbarBtnLg =
  "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12.5px] sm:px-3 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink";

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
  onOpenLink,
  updateInfo,
  onDismissUpdate,
  trashRetentionDays = 0,
}: {
  notebooks: Notebook[];
  trashedNotebooks: Notebook[];
  folders: Folder[];
  /** `background`: ⌘/Ctrl- or middle-click — open in a tab without switching to it. */
  onOpen: (id: string, background?: boolean) => void;
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
  /** Open a shared notebook link someone sent. */
  onOpenLink: () => void;
  /** Newer release found at launch (Settings → About); null = up to date / dismissed. */
  updateInfo?: UpdateInfo | null;
  onDismissUpdate?: () => void;
  /** Trash auto-empty setting (0 = never) — shown as a hint in the Trash view. */
  trashRetentionDays?: number;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [createCover, setCreateCover] = useState("");
  const [createFolderId, setCreateFolderId] = useState("");
  const phone = usePhone();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Notebook | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCover, setEditCover] = useState("");
  const [editFolderId, setEditFolderId] = useState("");
  const [folderModal, setFolderModal] = useState<{ folder: Folder | null } | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderDescription, setFolderDescription] = useState("");
  const [folderCover, setFolderCover] = useState("");
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
  const handleCardClick = (id: string, e: React.MouseEvent) => {
    if (selecting) toggleSelect(id);
    else onOpen(id, e.metaKey || e.ctrlKey);
  };

  /** Middle-click opens in a background tab. */
  const handleCardAuxClick = (id: string, e: React.MouseEvent) => {
    if (e.button === 1 && !selecting) onOpen(id, true);
  };

  /* ------------------------------ actions ------------------------------ */

  /** New notebook starts in the folder being viewed, if any. */
  const openCreate = () => {
    setCreateFolderId(viewing?.id ?? "");
    setCreating(true);
  };

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(t, description.trim(), createFolderId, createCover);
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
      onClick={(e) => handleCardClick(nb.id, e)}
      onAuxClick={(e) => handleCardAuxClick(nb.id, e)}
      draggable={!selecting}
      onDragStart={(e) => !selecting && nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group relative flex h-[136px] cursor-pointer flex-col overflow-hidden rounded-xl border bg-panel lift ${
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
          src={mediaSrc(nb.cover)}
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

  /** List view: the notebook's cover, or a tile with its first letter. */
  const thumb = (cover: string, title: string, muted = false) =>
    cover ? (
      <img
        src={mediaSrc(cover)}
        alt=""
        draggable={false}
        className={`h-9 w-9 shrink-0 rounded-lg object-cover ${muted ? "opacity-60 grayscale" : ""}`}
      />
    ) : (
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-[14px] font-semibold text-accent ${
          muted ? "opacity-60 grayscale" : ""
        }`}
      >
        {(title.trim()[0] ?? "?").toUpperCase()}
      </span>
    );

  /** List view grid: name | details | actions (header and rows share it). */
  const listCols =
    "grid grid-cols-[minmax(0,1fr)_116px] md:grid-cols-[minmax(0,1fr)_150px_116px] items-center gap-4";

  const renderRow = (nb: Notebook) => {
    const selected = selecting && selectedIds.includes(nb.id);
    return (
    <div
      key={nb.id}
      onClick={(e) => handleCardClick(nb.id, e)}
      onAuxClick={(e) => handleCardAuxClick(nb.id, e)}
      draggable={!selecting}
      onDragStart={(e) => !selecting && nbDragStart(e, nb.id)}
      onDragEnd={nbDragEnd}
      className={`group ${listCols} cursor-pointer px-4 py-2.5 transition-colors ${
        draggingId === nb.id ? "opacity-50" : ""
      } ${selected ? "bg-accent/10" : "hover:bg-hover-soft"}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {selecting && (
          <span
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${
              selected ? "border-accent bg-accent text-accent-ink" : "border-ink-3 text-transparent"
            }`}
          >
            {selected && <Check size={10} strokeWidth={3} />}
          </span>
        )}
        {thumb(nb.cover, nb.title)}
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium tracking-tight">{nb.title}</p>
          {nb.description && (
            <p className="mt-0.5 hidden truncate text-[12px] text-ink-3 md:block">{nb.description}</p>
          )}
          <p className="mt-0.5 truncate text-[12px] text-ink-3 md:hidden">Edited {formatTime(nb.updated_at)}</p>
        </div>
      </div>
      <span className="hidden truncate text-[12px] text-ink-3 md:block">Edited {formatTime(nb.updated_at)}</span>
      <span className="flex justify-end">
        {!selecting && actionCluster(nb, { star: 13.5, template: 13, pencil: 13, trash: 13.5 })}
      </span>
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
        className={`group relative flex h-[136px] cursor-pointer flex-col overflow-hidden rounded-xl border bg-panel lift ${
          highlight ? "border-accent ring-2 ring-accent/30" : "border-edge"
        }`}
      >
        {f.cover && (
          <img
            src={mediaSrc(f.cover)}
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
        className={`group ${listCols} cursor-pointer px-4 py-2.5 transition-colors ${
          highlight ? "bg-accent/10 ring-2 ring-inset ring-accent/40" : "hover:bg-hover-soft"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {f.cover ? (
            thumb(f.cover, f.name)
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hover text-ink-2">
              <FolderClosed size={16} strokeWidth={1.8} />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium tracking-tight">{f.name}</p>
            {f.description && (
              <p className="mt-0.5 hidden truncate text-[12px] text-ink-3 md:block">{f.description}</p>
            )}
            <p className="mt-0.5 truncate text-[12px] text-ink-3 md:hidden">
              {count === 1 ? "1 notebook" : `${count} notebooks`}
            </p>
          </div>
        </div>
        <span className="hidden truncate text-[12px] text-ink-3 md:block">
          {count === 1 ? "1 notebook" : `${count} notebooks`}
        </span>
        <span className="flex justify-end">{folderActionCluster(f)}</span>
      </div>
    );
  };

  const newNotebookCard = (
    <button
      key="new"
      onClick={openCreate}
      className="lift group flex h-[136px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 hover:border-ink-3 hover:bg-panel hover:text-ink"
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
      className="lift group flex h-[136px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <FolderPlus size={16} strokeWidth={1.8} />
      </span>
      <span className="text-[13px] font-medium">New folder</span>
    </button>
  );

  const openTrash = () => {
    setTrashOpen(true);
    exitSelect();
  };
  /** Trash table columns; "Removed" only exists when auto-empty is on. */
  const trashCols =
    trashRetentionDays > 0
      ? "grid grid-cols-[minmax(0,1fr)_148px] md:grid-cols-[minmax(0,1fr)_120px_100px_148px] items-center gap-4"
      : "grid grid-cols-[minmax(0,1fr)_148px] md:grid-cols-[minmax(0,1fr)_120px_148px] items-center gap-4";
  const trashCount =
    trashedNotebooks.length === 0
      ? "Empty"
      : trashedNotebooks.length === 1
        ? "1 notebook"
        : `${trashedNotebooks.length} notebooks`;

  /** The Trash lives in the Brewery as a third tile, beside New notebook / New folder. */
  const trashCard = (
    <button
      key="trash"
      onClick={openTrash}
      className="lift group flex h-[136px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 hover:border-ink-3 hover:bg-panel hover:text-ink"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel transition-colors group-hover:border-ink-3">
        <Trash2 size={15} strokeWidth={1.8} />
      </span>
      <span className="text-[13px] font-medium">Trash</span>
      <span className="-mt-1.5 text-[11.5px] text-ink-3">{trashCount}</span>
    </button>
  );

  /** List view: the same three actions as a slim strip above the table. */
  const listActions = (
    <div className="mb-3 flex flex-wrap items-center gap-1">
      <button
        onClick={openCreate}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft hover:text-ink"
      >
        <Plus size={14} strokeWidth={2} />
        New notebook
      </button>
      {!viewing && (
        <button
          onClick={() => openFolderModal(null)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft hover:text-ink"
        >
          <FolderPlus size={14} strokeWidth={1.8} />
          New folder
        </button>
      )}
      {!viewing && (
        <button
          onClick={openTrash}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft hover:text-ink"
        >
          <Trash2 size={13.5} strokeWidth={1.8} />
          Trash
          <span className="font-normal text-ink-3">· {trashCount}</span>
        </button>
      )}
    </div>
  );

  const gridClass = "stagger grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3.5";

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="safe-top box-content flex h-14 shrink-0 items-center gap-3 border-b border-edge-soft bg-panel px-3 md:gap-4 md:px-6">
        <div className="flex shrink-0 items-center gap-2.5">
          <BrewIcon size={22} className="text-ink" />
          {/* Phones: the logo alone, so the search field has room. */}
          <span className="hidden text-[15px] font-semibold tracking-tight md:inline">BrewLM</span>
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

      {/* Update banner — a newer GitHub Release was found at launch. */}
      {updateInfo?.isNewer && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-edge-soft bg-accent/10 px-4 py-2 text-[12.5px]">
          <Download size={13} strokeWidth={2} className="shrink-0 text-accent" />
          <span className="text-ink-2">
            BrewLM <b>v{updateInfo.latest}</b> is available — you're on v{updateInfo.current}.
          </span>
          <UpdateAction info={updateInfo} />
          {onDismissUpdate && (
            <button
              onClick={onDismissUpdate}
              aria-label="Dismiss update notice"
              className="ml-1 rounded-md p-0.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="safe-bottom flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-8">
        {trashOpen ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-6 flex items-end justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  onClick={() => {
                    setTrashOpen(false);
                    exitSelect();
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                >
                  <ArrowLeft size={13} strokeWidth={2} />
                  Brewery
                </button>
                <div className="min-w-0">
                  <h1 className="text-[22px] font-semibold tracking-tight">Trash</h1>
                  <p className="mt-0.5 text-[13px] text-ink-3">
                    {trashRetentionDays > 0
                      ? `Notebooks here are deleted for good after ${trashRetentionDays} days.`
                      : "Notebooks stay here until you restore or delete them."}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {selecting ? (
                  <>
                    <span className="mr-1 text-[12.5px] font-medium text-ink-2">
                      {selectedIds.length} selected
                    </span>
                    <button
                      onClick={() => {
                        onRestoreBulk(selectedIds);
                        exitSelect();
                      }}
                      disabled={selectedIds.length === 0}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft disabled:opacity-40"
                    >
                      <RotateCcw size={13} strokeWidth={1.8} />
                      Restore
                    </button>
                    <button
                      onClick={() => setBulkPurging(true)}
                      disabled={selectedIds.length === 0}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                      Delete forever
                    </button>
                    <button
                      onClick={exitSelect}
                      className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                    >
                      Done
                    </button>
                  </>
                ) : (
                  trashedNotebooks.length > 0 && (
                    <>
                      <button
                        onClick={() => setSelecting(true)}
                        className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
                      >
                        Select
                      </button>
                      <button
                        onClick={() => {
                          setSelectedIds(trashedNotebooks.map((n) => n.id));
                          setBulkPurging(true);
                        }}
                        className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-bg"
                      >
                        Empty Trash
                      </button>
                    </>
                  )
                )}
              </div>
            </div>
            {trashedNotebooks.length === 0 ? (
              <div className="anim-fade flex flex-col items-center justify-center rounded-xl border border-dashed border-edge py-20 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-hover text-ink-3">
                  <Trash2 size={20} strokeWidth={1.8} />
                </span>
                <p className="mt-4 text-[14px] font-medium">The Trash is empty</p>
                <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-ink-3">
                  Notebooks you delete land here first, so you can bring them back if you change your mind.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-edge bg-panel">
                <div
                  className={`${trashCols} border-b border-edge-soft bg-canvas/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3`}
                >
                  <span>Name</span>
                  <span className="hidden md:block">Deleted</span>
                  {trashRetentionDays > 0 && <span className="hidden md:block">Removed</span>}
                  <span />
                </div>
                <div className="stagger divide-y divide-edge-soft">
                  {trashedNotebooks.map((nb) => {
                    const selected = selecting && selectedIds.includes(nb.id);
                    const daysLeft =
                      trashRetentionDays > 0
                        ? Math.ceil((nb.trashed_at + trashRetentionDays * 86_400_000 - Date.now()) / 86_400_000)
                        : null;
                    const removedIn =
                      daysLeft === null ? null : daysLeft <= 0 ? "Today" : daysLeft === 1 ? "In 1 day" : `In ${daysLeft} days`;
                    const soon = daysLeft !== null && daysLeft <= 3;
                    return (
                      <div
                        key={nb.id}
                        onClick={() => selecting && toggleSelect(nb.id)}
                        className={`group ${trashCols} px-4 py-2.5 transition-colors ${
                          selecting ? "cursor-pointer" : ""
                        } ${selected ? "bg-accent/10" : "hover:bg-hover-soft"}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {selecting && (
                            <span
                              className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${
                                selected ? "border-accent bg-accent text-accent-ink" : "border-ink-3 text-transparent"
                              }`}
                            >
                              {selected && <Check size={10} strokeWidth={3} />}
                            </span>
                          )}
                          {thumb(nb.cover, nb.title, true)}
                          <div className="min-w-0">
                            <p className="truncate text-[13.5px] font-medium tracking-tight text-ink-2">{nb.title}</p>
                            {nb.description && (
                              <p className="mt-0.5 hidden truncate text-[12px] text-ink-3 md:block">{nb.description}</p>
                            )}
                            <p className="mt-0.5 truncate text-[12px] text-ink-3 md:hidden">
                              Deleted {formatTime(nb.trashed_at)}
                              {removedIn && <span className={soon ? "text-danger" : ""}> · removed {removedIn.toLowerCase()}</span>}
                            </p>
                          </div>
                        </div>
                        <span className="hidden truncate text-[12px] text-ink-3 md:block">{formatTime(nb.trashed_at)}</span>
                        {removedIn && (
                          <span className={`hidden truncate text-[12px] md:block ${soon ? "text-danger" : "text-ink-3"}`}>
                            {removedIn}
                          </span>
                        )}
                        <span className="flex items-center justify-end gap-0.5">
                          {!selecting && (
                            <>
                              <button
                                onClick={() => onRestore(nb.id)}
                                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                              >
                                <RotateCcw size={13} strokeWidth={1.8} />
                                Restore
                              </button>
                              <button
                                onClick={() => setPurging(nb)}
                                title="Delete forever"
                                aria-label={`Delete ${nb.title} forever`}
                                className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-danger-bg hover:text-danger"
                              >
                                <Trash2 size={14} strokeWidth={1.8} />
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-x-3 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
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
            {/* One height (32px), one radius (pill), one icon size (14px) across the bar. */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {selecting ? (
                <>
                  <div className="flex h-8 items-center rounded-full border border-edge bg-panel p-0.5 shadow-sm">
                    <span className="flex items-center gap-1.5 whitespace-nowrap pl-1.5 pr-2 text-[12.5px] font-medium text-ink">
                      <span
                        className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition-colors ${
                          selectedIds.length > 0 ? "bg-accent text-accent-ink" : "bg-hover text-ink-3"
                        }`}
                      >
                        {selectedIds.length}
                      </span>
                      selected
                    </span>
                    <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden />
                    {/* Move to folder */}
                    <div className="relative">
                      <button
                        onClick={() => setMoveMenuOpen((v) => !v)}
                        disabled={selectedIds.length === 0}
                        className={toolbarBtn}
                        aria-label="Move to folder"
                        aria-haspopup="menu"
                        aria-expanded={moveMenuOpen}
                      >
                        <FolderInput size={14} strokeWidth={1.8} />
                        <span className="hidden sm:inline">Move to</span>
                        <ChevronDown
                          size={12}
                          strokeWidth={2}
                          className={`text-ink-3 transition-transform ${moveMenuOpen ? "rotate-180" : ""}`}
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
                            className="anim-menu absolute right-0 z-20 mt-1.5 w-52 rounded-xl border border-edge bg-panel p-1 shadow-lg"
                          >
                            <button
                              role="menuitem"
                              onClick={() => {
                                onMoveNotebookBulk(selectedIds, "");
                                exitSelect();
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                            >
                              <House size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                              No folder (Brewery)
                            </button>
                            {folders.length > 0 && (
                              <div className="mx-1.5 my-1 h-px bg-edge-soft" aria-hidden />
                            )}
                            {folders.map((f) => (
                              <button
                                key={f.id}
                                role="menuitem"
                                onClick={() => {
                                  onMoveNotebookBulk(selectedIds, f.id);
                                  exitSelect();
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                              >
                                <FolderClosed size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                                <span className="truncate">{f.name}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => setBulkTrashing(true)}
                      disabled={selectedIds.length === 0}
                      className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-danger-bg hover:text-danger disabled:pointer-events-none disabled:opacity-40"
                      aria-label="Move to Trash"
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                      <span className="hidden sm:inline">Trash</span>
                    </button>
                  </div>
                  <button
                    onClick={exitSelect}
                    className="flex h-8 items-center rounded-full bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-85"
                  >
                    Done
                  </button>
                </>
              ) : (
                <>
                  {/* Actions: quiet text buttons. */}
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={onOpenLink}
                      className={toolbarBtnLg}
                      title="Open a notebook someone shared with you"
                      aria-label="Open link"
                    >
                      <Link2 size={14} strokeWidth={1.8} />
                      {/* Phones: the icon alone, so the row fits on one line. */}
                      <span className="hidden sm:inline">Open link</span>
                    </button>
                    <button
                      onClick={() => setSelecting(true)}
                      className={toolbarBtnLg}
                      title="Select notebooks to move or trash"
                      aria-label="Select"
                    >
                      <SquareCheck size={14} strokeWidth={1.8} />
                      <span className="hidden sm:inline">Select</span>
                    </button>
                  </div>
                  <span className="mx-1 hidden h-4 w-px bg-edge sm:block" aria-hidden />
                  {/* View controls: bordered, grouped together. */}
                  <div className="relative">
                    <button
                      onClick={() => setSortMenuOpen((v) => !v)}
                      className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel pl-2.5 pr-2 text-[12.5px] sm:pl-3 sm:pr-2.5 font-medium text-ink-2 shadow-sm transition-colors hover:bg-hover-soft hover:text-ink ${
                        sortMenuOpen ? "bg-hover-soft text-ink" : ""
                      }`}
                      aria-label="Sort notebooks"
                      aria-haspopup="menu"
                      aria-expanded={sortMenuOpen}
                    >
                      <ArrowUpDown size={14} strokeWidth={1.8} className="hidden text-ink-3 sm:block" />
                      {SORT_LABELS[sort]}
                      <ChevronDown
                        size={12}
                        strokeWidth={2}
                        className={`text-ink-3 transition-transform ${sortMenuOpen ? "rotate-180" : ""}`}
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
                          className="anim-menu absolute right-0 z-20 mt-1.5 w-44 rounded-xl border border-edge bg-panel p-1 shadow-lg"
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
                                s === sort ? "font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
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
                  {/* Grid / list: a segmented control, so both options and the current one are visible. */}
                  <div
                    role="radiogroup"
                    aria-label="Layout"
                    className="flex h-8 items-center rounded-full border border-edge bg-panel p-0.5 shadow-sm"
                  >
                    {(
                      [
                        ["grid", LayoutGrid, "Grid view"],
                        ["list", List, "List view"],
                      ] as const
                    ).map(([v, Icon, label]) => (
                      <button
                        key={v}
                        role="radio"
                        aria-checked={view === v}
                        aria-label={label}
                        title={label}
                        onClick={() => setView(v)}
                        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors sm:w-8 ${
                          view === v ? "bg-hover text-ink" : "text-ink-3 hover:text-ink"
                        }`}
                      >
                        <Icon size={14} strokeWidth={1.8} />
                      </button>
                    ))}
                  </div>
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
              {/* Phones: the three action tiles would fill the first screen; use the slim strip. */}
              {phone && listActions}
              <div className={gridClass}>
                {!phone && newNotebookCard}
                {!phone && !viewing && newFolderCard}
                {!phone && !viewing && trashCard}
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
              {listActions}
              {visibleFolders.length + ordered.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-edge bg-panel">
                  <div
                    className={`${listCols} border-b border-edge-soft bg-canvas/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3`}
                  >
                    <span>Name</span>
                    <span className="hidden md:block">Details</span>
                    <span />
                  </div>
                  <div className="stagger divide-y divide-edge-soft">
                    {visibleFolders.map(renderFolderRow)}
                    {ordered.map(renderRow)}
                  </div>
                </div>
              )}
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
        <Modal
          title={
            !selecting && selectedIds.length === trashedNotebooks.length ? "Empty the Trash?" : "Delete selected forever?"
          }
          onClose={() => {
            setBulkPurging(false);
            if (!selecting) setSelectedIds([]);
          }}
        >
          <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">
            {selectedIds.length === 1
              ? "1 notebook"
              : `${selectedIds.length} notebooks`}{" "}
            and everything in them will be permanently deleted. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <GhostButton
              onClick={() => {
                setBulkPurging(false);
                if (!selecting) setSelectedIds([]);
              }}
            >
              Cancel
            </GhostButton>
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
        <NotebookFormDialog
          dialogTitle="New notebook"
          kind="notebook"
          name={title}
          onNameChange={setTitle}
          description={description}
          onDescriptionChange={setDescription}
          cover={createCover}
          onPickCover={(f) => void pickCoverFile(setCreateCover, f)}
          onRemoveCover={() => setCreateCover("")}
          folder={{ value: createFolderId, options: folders, onChange: setCreateFolderId }}
          submitLabel="Create notebook"
          onSubmit={submit}
          onClose={() => setCreating(false)}
        />
      )}

      {editing && (
        <NotebookFormDialog
          dialogTitle="Edit notebook"
          kind="notebook"
          name={editTitle}
          onNameChange={setEditTitle}
          description={editDescription}
          onDescriptionChange={setEditDescription}
          cover={editCover}
          onPickCover={(f) => void pickCoverFile(setEditCover, f)}
          onRemoveCover={() => setEditCover("")}
          folder={{ value: editFolderId, options: folders, onChange: setEditFolderId }}
          submitLabel="Save changes"
          onSubmit={submitEdit}
          onClose={() => setEditing(null)}
        />
      )}

      {folderModal && (
        <NotebookFormDialog
          dialogTitle={folderModal.folder ? "Edit folder" : "New folder"}
          kind="folder"
          name={folderName}
          onNameChange={setFolderName}
          description={folderDescription}
          onDescriptionChange={setFolderDescription}
          cover={folderCover}
          onPickCover={(f) => void pickCoverFile(setFolderCover, f)}
          onRemoveCover={() => setFolderCover("")}
          submitLabel={folderModal.folder ? "Save changes" : "Create folder"}
          onSubmit={submitFolder}
          onClose={() => setFolderModal(null)}
        />
      )}
    </div>
  );
}
