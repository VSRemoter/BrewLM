import { BookOpen, Plus, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Notebook } from "../lib/types";
import { formatTime } from "../lib/source";
import { IconButton, Modal, PrimaryButton } from "./ui";

export default function Home({
  notebooks,
  onOpen,
  onCreate,
  onDelete,
  onSettings,
}: {
  notebooks: Notebook[];
  onOpen: (id: string) => void;
  onCreate: (title: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  const sorted = useMemo(() => notebooks, [notebooks]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(t);
    setTitle("");
    setCreating(false);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-edge-soft bg-panel px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent">
            <BookOpen size={13} strokeWidth={2.2} className="text-accent-ink" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">OpenMind</span>
        </div>
        <IconButton onClick={onSettings} label="Settings">
          <SettingsIcon size={16} strokeWidth={1.8} />
        </IconButton>
      </header>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight">Notebooks</h1>
              <p className="mt-0.5 text-[13px] text-ink-3">
                Each notebook is a workspace for your sources, chats, and study tools.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3.5">
            <button
              onClick={() => setCreating(true)}
              className="group flex h-[120px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge bg-transparent text-ink-3 transition-colors hover:border-ink-3 hover:bg-panel hover:text-ink"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel transition-colors group-hover:border-ink-3">
                <Plus size={16} strokeWidth={2} />
              </span>
              <span className="text-[13px] font-medium">New notebook</span>
            </button>

            {sorted.map((nb) => (
              <div
                key={nb.id}
                onClick={() => onOpen(nb.id)}
                className="group relative flex h-[120px] cursor-pointer flex-col justify-between rounded-xl border border-edge bg-panel p-4 transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
              >
                <span className="line-clamp-2 text-[13.5px] font-medium leading-snug tracking-tight">
                  {nb.title}
                </span>
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] text-ink-3">{formatTime(nb.updated_at)}</span>
                  <span
                    className="rounded-md p-1 text-ink-3 opacity-0 transition-all hover:bg-danger-bg hover:text-danger group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(nb.id);
                    }}
                    title="Delete notebook"
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <Modal title="New notebook" onClose={() => setCreating(false)}>
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
                className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[13.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
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
    </div>
  );
}
