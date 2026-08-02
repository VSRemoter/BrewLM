import {
  ArrowUp,
  BookOpen,
  FileText,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMessage, clearMessages } from "../lib/db";
import type { IngestResult } from "../lib/ingest";
import { renderMarkdown } from "../lib/markdown";
import { hydrateMermaid } from "../lib/mermaid";
import {
  buildMentionCatalog,
  resolveMentions,
  segmentMentions,
  type MentionItem,
} from "../lib/mentions";
import { streamChat, type LlmMessage } from "../lib/llm";
import { activeKey } from "../lib/settings";
import { ACCEPT_STRING } from "../lib/source";
import type { Artifact, ChatMessage, Settings, Source } from "../lib/types";
import { IconButton, TypingDots } from "./ui";

const MAX_CONSTITUTION_CHARS = 6000;
const MAX_SOURCE_CHARS = 6000;
const MAX_TOTAL_CONTEXT = 30_000;
const MAX_MENTION_CHARS = 8000;
const MAX_MENTION_TOTAL = 16_000;
const HISTORY_LIMIT = 16;

export function buildSystemPrompt(sources: Source[], mentioned: MentionItem[] = []): string {
  const constitutions = sources.filter(
    (s) => s.type === "context" && s.content.trim()
  );
  // Mentioned sources move into the priority section — don't include twice.
  const mentionedSourceIds = new Set(
    mentioned.filter((m) => m.group === "source").map((m) => m.id)
  );
  const knowledge = sources.filter(
    (s) =>
      s.type !== "context" &&
      s.content &&
      !s.content.startsWith("data:") &&
      !mentionedSourceIds.has(s.id)
  );

  const parts: string[] = ["You are OpenMind, a thoughtful study assistant."];

  // Constitution: the notebook's governing document. It may override defaults.
  if (constitutions.length > 0) {
    const body = constitutions
      .map((c) =>
        c.content.length > MAX_CONSTITUTION_CHARS
          ? c.content.slice(0, MAX_CONSTITUTION_CHARS) + "\n[…constitution truncated]"
          : c.content
      )
      .join("\n\n");
    parts.push(`# Notebook constitution\n${body}\n\nThe constitution above governs how you behave in this notebook — follow it strictly. Where it conflicts with the default rules below, the constitution wins.`);
  }

  parts.push(`# Default rules\n- Base answers on the user's sources first; say when something isn't covered.\n- Cite sources by title in parentheses, e.g. (Source: Week 4 lecture.pdf).\n- When a message references @Title, the user is pointing at that material — center the answer on it.\n- Visuals the app renders inline when you emit them: fenced svg diagrams, fenced mermaid flowcharts/graphs, and image embeds ![alt](https://image-url). Use them when they'd clarify a concept.\n- Be concise and clear. Use markdown formatting (lists, headers, bold) where it improves readability.`);

  if (mentioned.length > 0) {
    let budget = MAX_MENTION_TOTAL;
    const sections: string[] = [];
    for (const m of mentioned) {
      if (budget <= 0) break;
      const cap = Math.min(MAX_MENTION_CHARS, budget);
      const body = m.text
        ? m.text.length > cap
          ? m.text.slice(0, cap) + "\n[…truncated]"
          : m.text
        : "[No readable text — this is a binary/media file; acknowledge it by title, but don't invent its contents.]";
      sections.push(
        `### @${m.title} (${m.group === "source" ? "Source" : "Output"} · ${m.type})\n${body}`
      );
      budget -= body.length;
    }
    parts.push(
      `# @-mentioned materials — PRIORITY\nThe user pointed at these with @, so focus on them and cite them by title:\n\n${sections.join("\n\n")}`
    );
  }

  if (knowledge.length === 0) {
    if (mentioned.length === 0) {
      parts.push(
        "The user has not added any knowledge sources yet — encourage them to add sources, or answer simple questions generally."
      );
    }
    return parts.join("\n\n");
  }

  let budget = MAX_TOTAL_CONTEXT;
  const sections: string[] = [];
  for (const s of knowledge) {
    if (budget <= 0) break;
    const cap = Math.min(MAX_SOURCE_CHARS, budget);
    const trimmed = s.content.length > cap ? s.content.slice(0, cap) + "\n[…truncated]" : s.content;
    sections.push(`### ${s.title} (${s.type})\n${trimmed}`);
    budget -= trimmed.length;
  }

  parts.push(`# Sources\n${sections.join("\n\n---\n\n")}`);
  return parts.join("\n\n");
}

/** Grow the textarea with its content, up to ~10 lines. */
function autoSize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

/** Detect `@query` at the caret: prefix must be start/whitespace/paren. */
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\n@]{0,80})$/.exec(value.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export default function ChatPanel({
  notebookId,
  chatId,
  notebookTitle,
  chatTitle,
  sources,
  artifacts,
  settings,
  onOpenSettings,
  onChatActivity,
  onAddFiles,
}: {
  notebookId: string;
  chatId: string | null;
  notebookTitle: string;
  chatTitle: string;
  sources: Source[];
  artifacts: Artifact[];
  settings: Settings;
  onOpenSettings: () => void;
  onChatActivity?: (chatId: string, firstUserText?: string) => void;
  /** Ingest dropped/picked files as notebook sources; returns what was added. */
  onAddFiles: (files: FileList | File[]) => Promise<IngestResult>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  /** Append @Title tokens for freshly added sources, then focus the input. */
  const insertMentions = (titles: string[]) => {
    setDraft((prev) => {
      const add = titles
        .filter((t) => !prev.includes(`@${t}`))
        .map((t) => `@${t}`)
        .join(" ");
      if (!add) return prev;
      const next = (prev ? prev.replace(/\s+$/, "") + " " : "") + add + " ";
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          autoSize(ta);
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        }
      });
      return next;
    });
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (ingesting || !chatId || !files.length) return;
    setIngesting(true);
    try {
      const { added, errors } = await onAddFiles(files);
      if (errors.length) setError(errors.join("\n"));
      if (added.length) insertMentions(added.map((s) => s.title));
    } finally {
      setIngesting(false);
    }
  };

  const hasDraggedFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const catalog = useMemo(() => buildMentionCatalog(sources, artifacts), [sources, artifacts]);
  const mentionHits = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    const all = q ? catalog.filter((c) => c.title.toLowerCase().includes(q)) : catalog;
    return all.slice(0, 8);
  }, [mention, catalog]);
  const activeIdx = Math.min(mention?.active ?? 0, Math.max(mentionHits.length - 1, 0));

  const acceptMention = (item: MentionItem) => {
    if (!mention) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    setDraft(draft.slice(0, mention.start) + `@${item.title} ` + draft.slice(caret));
    setMention(null);
    const pos = mention.start + item.title.length + 2;
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoSize(ta);
    });
  };

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      return;
    }
    import("../lib/db").then(({ listMessages }) =>
      listMessages(chatId).then(setMessages)
    );
  }, [chatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Render ```mermaid diagrams once streaming settles (mid-stream they stay code).
  useEffect(() => {
    if (streaming === null) void hydrateMermaid(scrollRef.current);
  }, [streaming, messages]);

  const keyed = activeKey(settings);

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming !== null || !chatId) return;
    setError(null);
    setDraft("");
    setMention(null);
    const isFirst = messages.length === 0;

    const userMsg = await addMessage(chatId, notebookId, "user", text);
    const history = [...messages, userMsg];
    setMessages(history);
    setStreaming("");

    // Mentions from recent user turns keep their priority across follow-ups.
    const mentioned = resolveMentions(
      history
        .filter((m) => m.role === "user")
        .slice(-8)
        .map((m) => m.content)
        .join("\n"),
      catalog
    );
    const llmMessages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(sources, mentioned) },
      ...history.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content })),
    ];

    let acc = "";
    try {
      for await (const delta of streamChat({
        provider: settings.provider,
        apiKey: keyed,
        model: settings.model,
        messages: llmMessages,
      })) {
        acc += delta;
        setStreaming(acc);
      }
      const assistantMsg = await addMessage(chatId, notebookId, "assistant", acc || "(no response)");
      setMessages([...history, assistantMsg]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (acc) {
        const assistantMsg = await addMessage(chatId, notebookId, "assistant", acc);
        setMessages([...history, assistantMsg]);
      }
    } finally {
      setStreaming(null);
      textareaRef.current?.focus();
    }
    onChatActivity?.(chatId, isFirst ? text : undefined);
  };

  return (
    <section
      className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas"
      onDragEnter={(e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (hasDraggedFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!hasDraggedFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      {/* drop overlay */}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 m-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-canvas/80">
          <Upload size={22} strokeWidth={1.8} className="text-ink-2" />
          <p className="text-[13.5px] font-medium text-ink-2">
            Drop files to add as sources &amp; @mention them
          </p>
        </div>
      )}
      {/* header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-edge-soft bg-panel px-4">
        <span className="truncate text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Chat{chatTitle ? ` · ${chatTitle}` : ""}
        </span>
        <div className="flex items-center gap-1">
          {!keyed && (
            <button
              onClick={onOpenSettings}
              className="mr-1 flex items-center gap-1.5 rounded-full border border-warn-edge bg-warn-bg px-2.5 py-1 text-[11.5px] font-medium text-warn transition-colors hover:opacity-80"
            >
              <Settings2 size={11} /> Add API key
            </button>
          )}
          <IconButton
            onClick={async () => {
              if (!chatId) return;
              await clearMessages(chatId);
              setMessages([]);
            }}
            label="Clear chat"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 && streaming === null ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent">
              <BookOpen size={18} strokeWidth={1.8} className="text-accent-ink" />
            </div>
            <h2 className="text-[16px] font-semibold tracking-tight">
              {notebookTitle}
            </h2>
            <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-3">
              {sources.length > 0
                ? "Ask anything about your sources — summaries, explanations, key concepts."
                : "Add a source on the left to ground answers, or just start chatting."}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-5 py-6">
            {messages.map((m) => (
              <Bubble key={m.id} role={m.role} content={m.content} items={catalog} />
            ))}
            {streaming !== null && (
              <div className="anim-fade-up mb-5 flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed">
                  {streaming ? (
                    <div
                      className="md"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(streaming) }}
                    />
                  ) : (
                    <TypingDots />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-t border-danger-edge bg-danger-bg px-5 py-2.5 text-[12px] leading-snug text-danger">
          {error}
        </div>
      )}

      {/* input */}
      <div className="shrink-0 px-5 pb-5 pt-2">
        <div className="relative mx-auto max-w-2xl">
          {/* @-mention suggestions */}
          {mention && mentionHits.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
              <div className="max-h-56 overflow-y-auto py-1">
                {mentionHits.map((item, i) => (
                  <button
                    key={item.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(item);
                    }}
                    onMouseEnter={() => setMention((m) => (m ? { ...m, active: i } : m))}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                      i === activeIdx ? "bg-hover" : ""
                    }`}
                  >
                    {item.group === "source" ? (
                      <FileText size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    ) : (
                      <Sparkles size={13} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                      {item.type}
                    </span>
                  </button>
                ))}
              </div>
              <p className="border-t border-edge-soft px-3 py-1.5 text-[10.5px] text-ink-3">
                ↑↓ navigate · Enter to insert · Esc to dismiss
              </p>
            </div>
          )}
          <div
            className={`flex items-end gap-2 rounded-2xl border bg-panel p-2 pl-2 shadow-sm transition-colors ${
              streaming !== null ? "border-edge-soft" : "border-edge focus-within:border-ink-3"
            }`}
          >
            <input
              ref={attachInputRef}
              type="file"
              multiple
              accept={ACCEPT_STRING}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => attachInputRef.current?.click()}
              disabled={ingesting}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
              aria-label="Add file to chat"
              title="Add file (also @mentions it)"
            >
              {ingesting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={16} strokeWidth={2} />}
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                autoSize(e.target);
                const hit = detectMention(e.target.value, e.target.selectionStart);
                setMention(hit ? { ...hit, active: 0 } : null);
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                setMention((prev) => {
                  const hit = detectMention(el.value, el.selectionStart);
                  if (!hit) return null;
                  return { ...hit, active: prev && prev.query === hit.query ? prev.active : 0 };
                });
              }}
              onKeyDown={(e) => {
                if (mention && mentionHits.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMention((m) => m && { ...m, active: (activeIdx + 1) % mentionHits.length });
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMention((m) => m && { ...m, active: (activeIdx - 1 + mentionHits.length) % mentionHits.length });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptMention(mentionHits[activeIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={
                sources.length > 0 ? "Ask about your sources… (@ to reference)" : "Ask anything…"
              }
              className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none placeholder:text-ink-3"
            />
            <button
              onClick={send}
              disabled={!draft.trim() || streaming !== null}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-85 disabled:opacity-25"
              aria-label="Send message"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-ink-3">
            {settings.model} · via {settings.provider === "openrouter" ? "OpenRouter" : settings.provider}
          </p>
        </div>
      </div>
    </section>
  );
}

function Bubble({
  role,
  content,
  items,
}: {
  role: "user" | "assistant";
  content: string;
  items: MentionItem[];
}) {
  const segments = useMemo(
    () => (role === "user" ? segmentMentions(content, items) : []),
    [role, content, items]
  );
  if (role === "user") {
    return (
      <div className="anim-fade-up mb-5 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-accent-ink">
          {segments.map((seg, i) =>
            seg.item ? (
              <span
                key={i}
                title={`${seg.item.group === "source" ? "Source" : "Output"} · ${seg.item.type}`}
                className="rounded-md border border-accent-ink/25 bg-accent-ink/10 px-1 py-px text-[12.5px] font-medium"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="anim-fade-up mb-5 flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-edge-soft bg-panel px-4 py-3 text-[13.5px] leading-relaxed">
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      </div>
    </div>
  );
}
