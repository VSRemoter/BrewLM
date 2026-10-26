/**
 * Settings → Data & Storage → Largest items: the library's biggest sources,
 * outputs and images, each deletable in one step (lib/storage.ts).
 */
import { AudioLines, FileText, Film, Image, PenLine, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { deleteStorageItem, formatBytes, largestItems, type StorageItem } from "../../lib/storage";
import { GhostButton, Modal, Spinner } from "../ui";
import { Footnote, SectionTitle } from "./controls";

function KindIcon({ item }: { item: StorageItem }) {
  const props = { size: 15, strokeWidth: 1.8, className: "shrink-0 text-ink-3" };
  if (item.label === "Audio overview" || item.label === "Audio") return <AudioLines {...props} />;
  if (item.label === "Video") return <Film {...props} />;
  if (item.label === "Drawing") return <PenLine {...props} />;
  if (item.kind === "image" || item.kind.endsWith("cover") || item.kind === "chat-bg" || item.label === "Image")
    return <Image {...props} />;
  if (item.kind === "artifact") return <Sparkles {...props} />;
  return <FileText {...props} />;
}

/** What deleting this does, in a sentence. */
function deleteNote(item: StorageItem): string {
  if (item.kind === "cover" || item.kind === "folder-cover") return "The cover image is removed; everything else stays.";
  if (item.kind === "chat-bg") return "The chat background is removed; your chats stay.";
  if (item.kind === "image") return "The image is removed from its chat; the conversation stays.";
  return "It's removed from every device you sync with. This can't be undone.";
}

export default function LargestItems() {
  const [items, setItems] = useState<StorageItem[] | null>(null);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<StorageItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [freed, setFreed] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await largestItems();
      setItems(res.items);
      setSynced(res.synced);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (item: StorageItem) => {
    setDeleting(true);
    try {
      await deleteStorageItem(item);
      setItems((list) => list?.filter((i) => i.id !== item.id) ?? null);
      setFreed((n) => n + (item.shared ? 0 : item.bytes));
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const biggest = items?.[0]?.bytes ?? 0;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <SectionTitle
          title="Largest items"
          desc={
            synced
              ? "What takes the most of your Sync storage. Delete something to free space on every device."
              : "What takes the most space on this device. Delete something to free space."
          }
        />
        <button
          onClick={() => {
            setItems(null);
            void load();
          }}
          className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
          aria-label="Refresh the list"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="mb-6 overflow-hidden rounded-2xl border border-edge bg-panel">
        {items === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-ink-3">
            <Spinner /> Measuring your library…
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-ink-3">{error ?? "Nothing in your library takes up much space."}</p>
        ) : (
          <ul className="divide-y divide-edge-soft">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <KindIcon item={item} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink">{item.title}</div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {item.label}
                    {item.where && ` · ${item.where}`}
                    {item.inTrash && " · in Trash"}
                    {item.shared && " · also used elsewhere"}
                  </div>
                  {/* Relative size at a glance. */}
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-hover-soft">
                    <div
                      className="h-full rounded-full bg-accent/60"
                      style={{ width: `${Math.max(2, Math.round((item.bytes / Math.max(1, biggest)) * 100))}%` }}
                    />
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-2">{formatBytes(item.bytes)}</span>
                <button
                  onClick={() => setConfirm(item)}
                  className="shrink-0 rounded-md p-2 text-ink-3 transition-colors hover:bg-danger-bg hover:text-danger md:p-1.5"
                  aria-label={`Delete ${item.title}`}
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {items !== null && items.length > 0 && error && <Footnote>{error}</Footnote>}
      {freed > 0 && (
        <Footnote>
          {formatBytes(freed)} deleted.{" "}
          {synced ? "Your Sync storage updates within a minute or two, once the deletes have synced." : ""}
        </Footnote>
      )}

      {confirm && (
        <Modal title={`Delete "${confirm.title}"?`} onClose={() => !deleting && setConfirm(null)}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {confirm.label}
            {confirm.where && ` in ${confirm.where}`} · <b>{formatBytes(confirm.bytes)}</b>
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">{deleteNote(confirm)}</p>
          {confirm.shared && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
              Part of it is also used by another item, so deleting this frees less than its full size.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setConfirm(null)} disabled={deleting}>
              Cancel
            </GhostButton>
            <button
              onClick={() => void remove(confirm)}
              disabled={deleting}
              className="rounded-full border border-danger-edge bg-danger-bg px-4 py-2 text-[13px] font-medium text-danger transition-opacity hover:opacity-85 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
