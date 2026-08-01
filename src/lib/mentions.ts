/** @-mentions: reference sources and saved LLM outputs (artifacts) in chat. */

import type { Artifact, Source } from "./types";

export interface MentionItem {
  id: string;
  title: string;
  group: "source" | "output";
  /** Source type or artifact kind (pdf, link, flashcards, …). */
  type: string;
  /** Extracted readable text; null for binary/media that has none. */
  text: string | null;
}

/** Flatten a saved artifact into plain text the model can read. */
export function artifactText(a: Artifact): string | null {
  try {
    switch (a.kind) {
      case "notes":
      case "report":
      case "mindmap":
        return a.data.trim() || null;
      case "research": {
        const d = JSON.parse(a.data);
        const md = typeof d?.md === "string" ? d.md.trim() : "";
        const refs = Array.isArray(d?.sources)
          ? (d.sources as { title?: string; url?: string }[])
              .filter((s) => s?.url)
              .map((s) => `- ${s.title ?? s.url} (${s.url})`)
              .join("\n")
          : "";
        return [md, refs && `\n\nSources:\n${refs}`].filter(Boolean).join("") || null;
      }
      case "audio": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d?.script)) return null;
        const lines = (d.script as { speaker?: string; text?: string }[])
          .filter((t) => typeof t?.text === "string" && t.text.trim())
          .map((t) => `${t.speaker ?? "Host"}: ${t.text!.trim()}`);
        return lines.join("\n") || null;
      }
      case "flashcards": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d)) return null;
        const cards = (d as { front?: string; back?: string }[]).filter((c) => c?.front && c?.back);
        return cards.map((c) => `Q: ${c.front}\nA: ${c.back}`).join("\n\n") || null;
      }
      case "quiz": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d)) return null;
        const qs = d as {
          question?: string;
          options?: string[];
          answerIndex?: number;
          explanation?: string;
        }[];
        return (
          qs
            .filter((q) => q?.question && Array.isArray(q.options))
            .map((q) => {
              const opts = q.options!.map((o, i) => `  ${String.fromCharCode(65 + i)}) ${o}`);
              const answer =
                typeof q.answerIndex === "number" && q.options![q.answerIndex] != null
                  ? `Answer: ${String.fromCharCode(65 + q.answerIndex)}) ${q.options![q.answerIndex]}`
                  : "";
              return [`Q: ${q.question}`, ...opts, answer, q.explanation ? `Why: ${q.explanation}` : ""]
                .filter(Boolean)
                .join("\n");
            })
            .join("\n\n") || null
        );
      }
    }
  } catch {
    return null;
  }
}

/** Sources first, then LLM outputs — the @-mention catalog for a notebook. */
export function buildMentionCatalog(sources: Source[], artifacts: Artifact[] = []): MentionItem[] {
  return [
    ...sources.map((s) => ({
      id: s.id,
      title: s.title,
      group: "source" as const,
      type: s.type,
      text: s.content && !s.content.startsWith("data:") ? s.content : null,
    })),
    ...artifacts.map((a) => ({
      id: a.id,
      title: a.title,
      group: "output" as const,
      type: a.kind,
      text: artifactText(a),
    })),
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "@Title" matcher: word-boundary prefix, title verbatim, boundary/EOL after. */
function titleRe(title: string): RegExp {
  return new RegExp(`(^|[\\s("'\`])@(${escapeRegExp(title)})(?=$|[\\s).,;:!?"'\`])`, "gi");
}

export interface MentionSegment {
  text: string;
  item?: MentionItem;
}

/** Split text into plain runs and @mention runs (longest titles win, no overlaps). */
export function segmentMentions(content: string, items: MentionItem[]): MentionSegment[] {
  const hits: { start: number; end: number; item: MentionItem }[] = [];
  const sorted = [...items].filter((i) => i.title.trim()).sort((a, b) => b.title.length - a.title.length);
  for (const item of sorted) {
    for (const m of content.matchAll(titleRe(item.title))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, item });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  const out: MentionSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) out.push({ text: content.slice(pos, h.start) });
    out.push({ text: content.slice(h.start, h.end), item: h.item });
    pos = h.end;
  }
  if (pos < content.length) out.push({ text: content.slice(pos) });
  return out;
}

/** Which catalog items the text points at (deduped by id, first-seen order). */
export function resolveMentions(content: string, items: MentionItem[]): MentionItem[] {
  const seen = new Set<string>();
  const out: MentionItem[] = [];
  for (const seg of segmentMentions(content, items)) {
    if (seg.item && !seen.has(seg.item.id)) {
      seen.add(seg.item.id);
      out.push(seg.item);
    }
  }
  return out;
}
