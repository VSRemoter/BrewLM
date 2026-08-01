import { Check, MessageSquare, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { formatTime } from "../lib/source";
import type { Chat } from "../lib/types";
import { IconButton } from "./ui";

export default function ChatsPanel({
  chats,
  activeChatId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  chats: Chat[];
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onNew: () => void;
  onRename: (chatId: string, title: string) => void;
  onDelete: (chatId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const commitRename = (chatId: string) => {
    const t = draft.trim();
    setEditingId(null);
    if (t) onRename(chatId, t);
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-10 shrink-0 items-center justify-between px-3.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Recent chats
        </span>
        <IconButton onClick={onNew} label="New chat">
          <Plus size={15} strokeWidth={1.8} />
        </IconButton>
      </div>

      {/* chat list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {chats.length === 0 ? (
          <p className="px-2 py-2 text-[11.5px] leading-relaxed text-ink-3">
            Conversations are saved here automatically.
          </p>
        ) : (
          chats.map((chat) => {
            const active = chat.id === activeChatId;
            return (
              <div
                key={chat.id}
                className={`group mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                  active ? "bg-hover-soft" : "hover:bg-hover-soft/60"
                }`}
              >
                <MessageSquare
                  size={14}
                  strokeWidth={1.8}
                  className={`shrink-0 ${active ? "text-ink" : "text-ink-2"}`}
                />
                {editingId === chat.id ? (
                  <>
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(chat.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => commitRename(chat.id)}
                      className="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-[12.5px] outline-none focus:border-ink-3"
                      aria-label="Chat title"
                    />
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault(); // don't blur before committing
                        commitRename(chat.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-ok hover:bg-hover"
                      title="Save title"
                    >
                      <Check size={13} />
                    </button>
                  </>
                ) : confirmDeleteId === chat.id ? (
                  <>
                    <span className="flex-1 text-[11.5px] text-ink-2">Delete chat?</span>
                    <button
                      onClick={() => {
                        setConfirmDeleteId(null);
                        onDelete(chat.id);
                      }}
                      className="shrink-0 rounded-full bg-danger px-2 py-0.5 text-[10.5px] font-medium text-accent-ink"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink"
                      title="Cancel"
                    >
                      <X size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => onSelect(chat.id)}
                      className="min-w-0 flex-1 text-left"
                      title={chat.title}
                    >
                      <span
                        className={`block truncate text-[12.5px] leading-tight ${
                          active ? "font-semibold" : "font-medium"
                        }`}
                      >
                        {chat.title}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] text-ink-3">
                        {formatTime(chat.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(chat.id);
                        setDraft(chat.title);
                      }}
                      className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-ink group-hover:opacity-100"
                      title="Rename chat"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(chat.id)}
                      className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                      title="Delete chat"
                    >
                      <X size={12.5} />
                    </button>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
