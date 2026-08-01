import {
  FileText,
  File as FileIcon,
  Image as ImageIcon,
  Landmark,
  Link2,
  Loader2,
  Music,
  Plus,
  Type,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { CONSTITUTION_BODY, CONSTITUTION_TITLE } from "../lib/constitution";
import { addSource, deleteSource } from "../lib/db";
import {
  ACCEPT_STRING,
  classifyFile,
  extractPdfText,
  fetchLinkContent,
  readFileAsDataUrl,
  readFileAsText,
  sourcePreview,
} from "../lib/source";
import type { Source } from "../lib/types";
import SourceViewModal from "./SourceViewModal";
import { IconButton, Modal, PrimaryButton } from "./ui";

const TYPE_ICON = {
  context: Landmark,
  pdf: FileText,
  text: Type,
  link: Link2,
  image: ImageIcon,
  audio: Music,
  file: FileIcon,
} as const;

const MAX_BINARY_BYTES = 8 * 1024 * 1024; // 8 MB for base64-embedded images/audio

export default function SourcesPanel({
  notebookId,
  sources,
  onChanged,
}: {
  notebookId: string;
  sources: Source[];
  onChanged: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [viewing, setViewing] = useState<Source | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasConstitution = sources.some((s) => s.type === "context");
  const ordered = [...sources].sort(
    (a, b) => Number(b.type === "context") - Number(a.type === "context")
  );

  /* ---------------------------- file ingestion ---------------------------- */

  const ingestFiles = async (files: FileList | File[]) => {
    setError(null);
    setMenuOpen(false);
    for (const file of Array.from(files)) {
      const type = classifyFile(file);
      setBusy(file.name);
      try {
        if (type === "pdf") {
          const text = await extractPdfText(file);
          await addSource(notebookId, "pdf", file.name, text, file.type);
        } else if (type === "text" || type === "file") {
          const text = await readFileAsText(file).catch(() => "");
          await addSource(
            notebookId,
            type,
            file.name,
            text || `Could not extract text from ${file.name}.`,
            file.type || null
          );
        } else {
          // image / audio — embed small files as data URLs so they persist locally
          if (file.size > MAX_BINARY_BYTES) {
            await addSource(
              notebookId,
              type,
              file.name,
              `[${type} attached but too large to embed: ${(file.size / 1024 / 1024).toFixed(1)} MB]`,
              file.type
            );
          } else {
            const dataUrl = await readFileAsDataUrl(file);
            await addSource(notebookId, type, file.name, dataUrl, file.type);
          }
        }
      } catch (e) {
        setError(`Failed to add ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    onChanged();
  };

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-edge-soft bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-edge-soft px-3.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Sources
        </span>
        <div className="relative">
          <IconButton onClick={() => setMenuOpen((v) => !v)} label="Add source">
            <Plus size={16} strokeWidth={2} />
          </IconButton>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="anim-fade-up absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
                {[
                  { icon: Upload, label: "Upload files", act: () => fileInput.current?.click() },
                  { icon: Type, label: "Paste text", act: () => { setMenuOpen(false); setPasteOpen(true); } },
                  { icon: Link2, label: "Add link", act: () => { setMenuOpen(false); setLinkOpen(true); } },
                  ...(!hasConstitution
                    ? [
                        {
                          icon: Landmark,
                          label: "Add constitution",
                          act: async () => {
                            setMenuOpen(false);
                            await addSource(notebookId, "context", CONSTITUTION_TITLE, CONSTITUTION_BODY);
                            onChanged();
                          },
                        },
                      ]
                    : []),
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={item.act}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] transition-colors hover:bg-hover-soft"
                  >
                    <item.icon size={14} strokeWidth={1.8} className="text-ink-2" />
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_STRING}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) ingestFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="flex-1 overflow-y-auto p-2">
        {sources.length === 0 && !busy && (
          <div className="mt-10 px-3 text-center">
            <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-hover">
              <FileText size={15} strokeWidth={1.8} className="text-ink-3" />
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              Add PDFs, text, links, images, or audio. The AI will ground its answers in these sources.
            </p>
          </div>
        )}

        {ordered.map((s) => {
          const Icon = TYPE_ICON[s.type] ?? FileIcon;
          const isImage = s.type === "image" && s.content.startsWith("data:");
          const isConstitution = s.type === "context";
          return (
            <div
              key={s.id}
              className={`group mb-1 flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-hover-soft ${
                isConstitution ? "border border-edge-soft bg-canvas" : ""
              }`}
            >
              {isImage ? (
                <img
                  src={s.content}
                  alt={s.title}
                  className="mt-0.5 h-7 w-7 shrink-0 cursor-pointer rounded object-cover"
                  onClick={() => setViewing(s)}
                />
              ) : (
                <Icon
                  size={15}
                  strokeWidth={1.8}
                  className={`mt-0.5 shrink-0 cursor-pointer ${isConstitution ? "text-ink" : "text-ink-2"}`}
                  onClick={() => setViewing(s)}
                />
              )}
              <button
                onClick={() => setViewing(s)}
                className="min-w-0 flex-1 text-left"
                title="Click to view & edit"
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium leading-tight">
                    {s.title}
                  </span>
                  {isConstitution && (
                    <span className="shrink-0 rounded-full border border-edge bg-panel px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wider text-ink-3">
                      Constitution
                    </span>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-1 block text-[11px] text-ink-3">
                  {isConstitution
                    ? "Governs AI behavior in this notebook"
                    : isImage || (s.type === "audio" && s.content.startsWith("data:"))
                      ? s.mime ?? s.type
                      : sourcePreview(s.content)}
                </span>
              </button>
              <button
                onClick={async () => {
                  await deleteSource(s.id);
                  onChanged();
                }}
                className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                title="Remove source"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}

        {busy && (
          <div className="flex items-center gap-2.5 px-2.5 py-2 text-[12.5px] text-ink-3">
            <Loader2 size={14} className="animate-spin" />
            <span className="truncate">Reading {busy}…</span>
          </div>
        )}
      </div>

      {error && (
        <div className="border-t border-edge-soft px-3.5 py-2.5 text-[11.5px] leading-snug text-danger">
          {error}
        </div>
      )}

      <div className="shrink-0 border-t border-edge-soft px-3.5 py-2.5 text-[11.5px] text-ink-3">
        {sources.length} {sources.length === 1 ? "source" : "sources"}
      </div>

      {/* ------------------------------ modals ------------------------------ */}

      {pasteOpen && (
        <PasteTextModal
          onClose={() => setPasteOpen(false)}
          onAdd={async (title, text) => {
            await addSource(notebookId, "text", title, text);
            setPasteOpen(false);
            onChanged();
          }}
        />
      )}

      {linkOpen && (
        <LinkModal
          onClose={() => setLinkOpen(false)}
          onAdd={async (url) => {
            const { title, text } = await fetchLinkContent(url);
            await addSource(notebookId, "link", title, text, url);
            setLinkOpen(false);
            onChanged();
          }}
        />
      )}

      {viewing && (
        <SourceViewModal
          source={viewing}
          onClose={() => setViewing(null)}
          onChanged={onChanged}
        />
      )}
    </aside>
  );
}

function PasteTextModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (title: string, text: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  return (
    <Modal title="Paste text" onClose={onClose} wide>
      <div className="flex flex-col gap-3.5">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste your notes, transcript, or any text here…"
          rows={10}
          className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
        <div className="flex justify-end">
          <PrimaryButton
            disabled={!text.trim()}
            onClick={() => onAdd(title.trim() || "Pasted text", text.trim())}
          >
            Add source
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}

function LinkModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(url.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add link" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3.5"
      >
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/article"
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
        {error && <p className="text-[12px] leading-snug text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {busy && <Loader2 size={14} className="animate-spin text-ink-3" />}
          <PrimaryButton type="submit" disabled={!url.trim() || busy}>
            {busy ? "Fetching…" : "Fetch & add"}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}
