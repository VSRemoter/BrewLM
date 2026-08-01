import { ArrowUp, BookOpen, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addMessage, clearMessages } from "../lib/db";
import { renderMarkdown } from "../lib/markdown";
import { streamChat, type LlmMessage } from "../lib/llm";
import { activeKey } from "../lib/settings";
import type { ChatMessage, Settings, Source } from "../lib/types";
import { IconButton, TypingDots } from "./ui";

const MAX_CONSTITUTION_CHARS = 6000;
const MAX_SOURCE_CHARS = 6000;
const MAX_TOTAL_CONTEXT = 30_000;
const HISTORY_LIMIT = 16;

export function buildSystemPrompt(sources: Source[]): string {
  const constitutions = sources.filter(
    (s) => s.type === "context" && s.content.trim()
  );
  const knowledge = sources.filter(
    (s) => s.type !== "context" && s.content && !s.content.startsWith("data:")
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

  parts.push(`# Default rules\n- Base answers on the user's sources first; say when something isn't covered.\n- Cite sources by title in parentheses, e.g. (Source: Week 4 lecture.pdf).\n- Be concise and clear. Use markdown formatting (lists, headers, bold) where it improves readability.`);

  if (knowledge.length === 0) {
    parts.push(
      "The user has not added any knowledge sources yet — encourage them to add sources, or answer simple questions generally."
    );
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

export default function ChatPanel({
  notebookId,
  chatId,
  notebookTitle,
  chatTitle,
  sources,
  settings,
  onOpenSettings,
  onChatActivity,
}: {
  notebookId: string;
  chatId: string | null;
  notebookTitle: string;
  chatTitle: string;
  sources: Source[];
  settings: Settings;
  onOpenSettings: () => void;
  onChatActivity?: (chatId: string, firstUserText?: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const keyed = activeKey(settings);

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming !== null || !chatId) return;
    setError(null);
    setDraft("");
    const isFirst = messages.length === 0;

    const userMsg = await addMessage(chatId, notebookId, "user", text);
    const history = [...messages, userMsg];
    setMessages(history);
    setStreaming("");

    const llmMessages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(sources) },
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
    <section className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
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
              <Bubble key={m.id} role={m.role} content={m.content} />
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
        <div className="mx-auto max-w-2xl">
          <div
            className={`flex items-end gap-2 rounded-2xl border bg-panel p-2 pl-4 shadow-sm transition-colors ${
              streaming !== null ? "border-edge-soft" : "border-edge focus-within:border-ink-3"
            }`}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={
                sources.length > 0 ? "Ask about your sources…" : "Ask anything…"
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

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  if (role === "user") {
    return (
      <div className="anim-fade-up mb-5 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-accent-ink">
          {content}
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
