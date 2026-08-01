import { Landmark, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteSource, updateSource } from "../lib/db";
import type { Source } from "../lib/types";
import { GhostButton, Modal, PrimaryButton } from "./ui";

export default function SourceViewModal({
  source,
  onClose,
  onChanged,
}: {
  source: Source;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(source.title);
  const [content, setContent] = useState(source.content);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isConstitution = source.type === "context";
  const isImage = source.type === "image" && source.content.startsWith("data:");
  const isAudio = source.type === "audio" && source.content.startsWith("data:");
  const isTextLike = !isImage && !isAudio;
  const dirty =
    title.trim() !== source.title || content !== source.content;

  const save = async () => {
    if (!dirty) return onClose();
    await updateSource(source.id, title.trim() || source.title, content);
    onChanged();
    onClose();
  };

  const doDelete = async () => {
    await deleteSource(source.id);
    onChanged();
    onClose();
  };

  return (
    <Modal title={isConstitution ? "Notebook constitution" : "Source"} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        {isConstitution && (
          <div className="flex items-start gap-2 rounded-lg border border-edge bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-2">
            <Landmark size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
            <span>
              This file shapes how the AI behaves, formats answers, and creates study
              materials in this notebook. Edits apply to your next message. Deleting it
              restores default behavior.
            </span>
          </div>
        )}

        {/* title */}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] font-medium outline-none focus:border-ink-3"
          aria-label="Source title"
        />

        {/* meta row */}
        <div className="flex items-center gap-2 text-[11px] text-ink-3">
          <span className="rounded-full border border-edge px-2 py-0.5 uppercase tracking-wide">
            {source.type}
          </span>
          {isTextLike && (
            <span>
              {content.length.toLocaleString()} chars ·{" "}
              {content.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words
            </span>
          )}
          {source.mime && !isImage && !isAudio && source.type === "link" && (
            <span className="flex min-w-0 items-center gap-1">
              <Link2 size={10} />
              <span className="truncate">{source.mime}</span>
            </span>
          )}
        </div>

        {/* body */}
        {isImage ? (
          <img
            src={source.content}
            alt={source.title}
            className="max-h-64 w-auto self-center rounded-lg border border-edge object-contain"
          />
        ) : isAudio ? (
          <audio controls src={source.content} className="w-full" />
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-ink-3"
            aria-label="Source content"
          />
        )}

        {/* actions */}
        <div className="flex items-center justify-between pt-1">
          {confirmingDelete ? (
            <span className="flex items-center gap-2 text-[12px] text-ink-2">
              Delete forever?
              <button
                onClick={doDelete}
                className="rounded-full bg-danger px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-85"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="text-ink-3 hover:text-ink"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="flex items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 text-[12px] font-medium text-ink-3 transition-colors hover:border-danger-edge hover:bg-danger-bg hover:text-danger"
            >
              <Trash2 size={12.5} /> Delete
            </button>
          )}
          <div className="flex items-center gap-2">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={save} disabled={!dirty}>
              Save changes
            </PrimaryButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}
