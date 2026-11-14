/**
 * New / edit dialog for a notebook or folder, laid out like a Notion page:
 * an optional cover across the top, a large borderless title, a quiet
 * description, then properties (the folder a notebook lives in) as rows.
 */
import { FolderClosed, House, ImagePlus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { mediaSrc } from "../lib/blobs";
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
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
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
          <div className="-ml-1.5 mb-1 flex items-center gap-2">
            <button
              type="button"
              onClick={pick}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
            >
              <ImagePlus size={14} strokeWidth={1.8} />
              Add cover
            </button>
            <span className="text-[12px] text-ink-3/70">Shown in grid view</span>
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

        {/* Title and description read as page text, not boxed form fields. */}
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={kind === "folder" ? "Untitled folder" : "Untitled notebook"}
          aria-label={kind === "folder" ? "Name" : "Title"}
          className="w-full bg-transparent text-[22px]! font-semibold tracking-tight text-ink outline-none placeholder:text-ink-3/60"
        />
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={kind === "folder" ? "Add a description of what belongs here…" : "Add a description…"}
          aria-label="Description"
          rows={2}
          className="mt-1 w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-ink-2 outline-none placeholder:text-ink-3/70"
        />

        {folder && (
          <div className="mt-3 border-t border-edge-soft pt-3">
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
