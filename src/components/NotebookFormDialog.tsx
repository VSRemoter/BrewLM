/**
 * New / edit dialog for a notebook or folder, laid out like a Notion page:
 * an optional cover across the top, a large borderless title, a quiet
 * description, then properties (the folder a notebook lives in) as rows.
 */
import { Check, FolderClosed, House, ImagePlus, Palette, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { mediaSrc } from "../lib/blobs";
import { COVER_STYLES, coverPreview, makeCover } from "../lib/covers";
import { NOTEBOOK_COLORS, notebookTintStyle } from "../lib/notebookColors";
import type { Folder } from "../lib/types";
import { GhostButton, Modal, PrimaryButton, PropertyRow, SelectMenu } from "./ui";

export default function NotebookFormDialog({
  dialogTitle,
  kind,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  cover,
  onPickCover,
  onRemoveCover,
  folder,
  color,
  submitLabel,
  onSubmit,
  onClose,
}: {
  dialogTitle: string;
  kind: "notebook" | "folder";
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  /** Cover image (data URL or media ref); "" = none. */
  cover: string;
  onPickCover: (file: File) => void;
  onRemoveCover: () => void;
  /** Notebooks only: which folder it lives in ("" = none). */
  folder?: { value: string; options: Folder[]; onChange: (id: string) => void };
  /** Notebooks only: its color (notebookColors.ts id; "" = none). */
  color?: { value: string; onChange: (id: string) => void };
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [drawing, setDrawing] = useState(false);
  const pickReadyCover = async (id: string) => {
    setDrawing(true);
    try {
      onPickCover(await makeCover(id));
    } finally {
      setDrawing(false);
    }
  };
  const formId = `${kind}-form`;
  const pick = () => fileRef.current?.click();

  return (
    <Modal
      title={dialogTitle}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" form={formId} disabled={!name.trim()}>
            {submitLabel}
          </PrimaryButton>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSubmit();
        }}
        className="flex flex-col"
      >
        {cover ? (
          <div className="group relative mb-4 overflow-hidden rounded-lg border border-edge">
            <img src={mediaSrc(cover)} alt="Cover" className="h-28 w-full object-cover" />
            {/* Shown on hover (always on touch screens, which have no hover). */}
            <div className="absolute right-2 bottom-2 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
              <button
                type="button"
                onClick={pick}
                className="rounded-md bg-panel/90 px-2 py-1 text-[12px] font-medium text-ink-2 shadow-sm ring-1 ring-edge backdrop-blur transition-colors hover:text-ink"
              >
                Change cover
              </button>
              <button
                type="button"
                onClick={onRemoveCover}
                aria-label="Remove cover"
                title="Remove cover"
                className="rounded-md bg-panel/90 px-1.5 py-1 text-ink-3 shadow-sm ring-1 ring-edge backdrop-blur transition-colors hover:text-danger"
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        ) : (
          <div className="-ml-1.5 mb-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={pick}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
            >
              <ImagePlus size={14} strokeWidth={1.8} />
              Add cover
            </button>
            {/* Ready-made covers, drawn on the spot. */}
            <span className="flex items-center gap-1" aria-label="Ready-made covers">
              {COVER_STYLES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={drawing}
                  onClick={() => void pickReadyCover(c.id)}
                  title={`${c.name} cover`}
                  aria-label={`${c.name} cover`}
                  className="h-5 w-7 rounded-[4px] ring-1 ring-edge transition-transform hover:scale-110 disabled:opacity-50"
                  style={{ background: coverPreview(c) }}
                />
              ))}
            </span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickCover(f);
            e.target.value = ""; // allow picking the same file twice in a row
          }}
        />

        {/* Title and description keep their page-like type, in light boxes so they read as editable. */}
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={kind === "folder" ? "Untitled folder" : "Untitled notebook"}
          aria-label={kind === "folder" ? "Name" : "Title"}
          className="w-full rounded-lg border border-edge bg-canvas/50 px-3 py-1.5 text-[20px]! font-semibold tracking-tight text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3/60 hover:border-ink-3/40 focus:border-accent/70 focus:ring-3 focus:ring-accent/15"
        />
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={kind === "folder" ? "Add a description of what belongs here…" : "Add a description…"}
          aria-label="Description"
          rows={2}
          className="mt-2 w-full resize-none rounded-lg border border-edge bg-canvas/50 px-3 py-2 text-[13.5px] leading-relaxed text-ink-2 outline-none transition-[border-color,box-shadow] placeholder:text-ink-3/70 hover:border-ink-3/40 focus:border-accent/70 focus:ring-3 focus:ring-accent/15"
        />

        {(folder || color) && <div className="mt-3 border-t border-edge-soft" />}
        {color && (
          <div className="pt-3">
            <PropertyRow inline label="Color" icon={<Palette size={14} strokeWidth={1.8} />}>
              <div role="radiogroup" aria-label="Notebook color" className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!color.value}
                  onClick={() => color.onChange("")}
                  title="No color"
                  aria-label="No color"
                  className={`relative h-5 w-5 rounded-full border border-edge bg-panel transition-transform hover:scale-110 ${
                    !color.value ? "ring-2 ring-ink-3 ring-offset-1 ring-offset-panel" : ""
                  }`}
                >
                  <span className="absolute left-1/2 top-1/2 h-[1.5px] w-3.5 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-ink-3" />
                </button>
                {NOTEBOOK_COLORS.map((c) => {
                  const on = color.value === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => color.onChange(c.id)}
                      title={c.name}
                      aria-label={c.name}
                      className={`nb-tint flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                        on ? "ring-2 ring-offset-1 ring-offset-panel" : ""
                      }`}
                      style={{ ...notebookTintStyle(c.id), background: "var(--nb-accent)", ["--tw-ring-color" as string]: "var(--nb-accent)" }}
                    >
                      {on && <Check size={11} strokeWidth={3} style={{ color: "var(--nb-accent-ink)" }} />}
                    </button>
                  );
                })}
              </div>
            </PropertyRow>
          </div>
        )}
        {folder && (
          <div className="pt-3">
            <PropertyRow inline label="Folder" icon={<FolderClosed size={14} strokeWidth={1.8} />}>
              <div className="-mx-2">
                <SelectMenu
                  label="Folder"
                  value={folder.value}
                  onChange={folder.onChange}
                  options={[
                    { id: "", label: "None (Brewery)", icon: <House size={14} strokeWidth={1.8} /> },
                    ...folder.options.map((f) => ({
                      id: f.id,
                      label: f.name,
                      icon: <FolderClosed size={14} strokeWidth={1.8} />,
                    })),
                  ]}
                />
              </div>
            </PropertyRow>
          </div>
        )}
      </form>
    </Modal>
  );
}
