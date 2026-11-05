/**
 * Strip above a notebook opened from someone's link: who shared it, whether
 * the owner has updated it since, and "Save a copy" to make it your own.
 */
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cloneNotebook } from "../lib/share";
import { checkSharedUpdate, updateSharedNotebook } from "../lib/shareView";
import type { Notebook } from "../lib/types";
import { Spinner } from "./ui";

export default function SharedBanner({
  notebook,
  onUpdated,
  onCopied,
}: {
  notebook: Notebook;
  /** The notebook's contents were replaced with the link's latest version. */
  onUpdated: () => void;
  /** A copy was saved: open it. */
  onCopied: (id: string) => void;
}) {
  const [update, setUpdate] = useState<"none" | "available" | "gone">("none");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void checkSharedUpdate(notebook).then((r) => {
      if (live) setUpdate(r === null ? "none" : "gone" in r ? "gone" : "available");
    });
    return () => {
      live = false;
    };
  }, [notebook.id, notebook.share_version]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const updated = new Date(notebook.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge-soft bg-hover-soft px-3.5 py-2 text-[12px]">
      <Link2 size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 text-ink-2">
        Shared{notebook.shared_by ? ` by ${notebook.shared_by}` : " with you"} · read-only · as of {updated}
        {update === "available" && <span className="text-ink"> · The owner has updated it.</span>}
        {update === "gone" && <span className="text-ink-3"> · The owner stopped sharing it; this copy stays here.</span>}
        {error && <span className="text-danger"> · {error}</span>}
      </span>
      {busy ? (
        <span className="flex items-center gap-1.5 text-ink-3">
          <Spinner size={11} />
          {busy}
        </span>
      ) : (
        <span className="flex items-center gap-1">
          {update === "available" && (
            <button
              onClick={() =>
                run("Updating…", async () => {
                  await updateSharedNotebook(notebook);
                  setUpdate("none");
                  onUpdated();
                })
              }
              className="rounded-full px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
            >
              Get the update
            </button>
          )}
          <button
            onClick={() =>
              run("Saving a copy…", async () => {
                const copy = await cloneNotebook(notebook.id, notebook.title, { includeChats: true });
                onCopied(copy.id);
              })
            }
            className="rounded-full bg-accent px-3 py-1 font-medium text-accent-ink hover:opacity-85"
          >
            Save a copy
          </button>
        </span>
      )}
    </div>
  );
}
