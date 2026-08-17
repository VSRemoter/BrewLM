/**
 * Mobile job runner: phones queue chat/generate jobs into the `jobs` table
 * (via the sharing server); this loop — running in the desktop webview — drains
 * them with the exact same LLM pipelines as the Studio panel, writing results
 * (chat messages, artifacts) straight into the shared SQLite database.
 */
import { buildSystemPrompt, selectChatHistory } from "../components/ChatPanel";
import {
  addArtifact,
  addMessage,
  addSource,
  createChat,
  getDb,
  getNotebookGrounded,
  listMessages,
  listSources,
  renameChat,
  touchChat,
  touchNotebook,
} from "./db";
import { complete, extractJson } from "./llm";
import { downscaleGeneratedImages, stripHistoryImages } from "./genImage";
import {
  condenseNotebook,
  condensedSystemPrompt,
  ensureIndexed,
  indexSource,
  isRetrievable,
  MAP_REDUCE_THRESHOLD,
  rankChunks,
} from "./rag";
import { deepResearch } from "./research";
import { activeKey, loadSettings } from "./settings";
import {
  buildAudioPrompt,
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  REPORT_TYPE_LABELS,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type AudioOptions,
  type Difficulty,
} from "./studio";
import { parseScript, synthesizeScript } from "./tts";
import type { Source } from "./types";

const POLL_MS = 3000;

interface JobRow {
  id: string;
  kind: string;
  notebook_id: string;
  status: string;
  payload: string;
}

let timer: number | null = null;
let busy = false;

/** Call once on app boot; safe to call again (idempotent). */
export function startJobRunner(): void {
  if (timer !== null) return;
  console.info("MOBILE_JOB_RUNNER_STARTED");
  const tick = () => void drainOnce().catch((e) => console.warn("job runner:", e));
  timer = window.setInterval(tick, POLL_MS);
  tick();
}

export function stopJobRunner(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

async function drainOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const d = await getDb();
    const rows = await d.select<JobRow[]>(
      "SELECT id, kind, notebook_id, status, payload FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    );
    const job = rows[0];
    if (!job) return;
    await d.execute("UPDATE jobs SET status = 'running', updated_at = $1 WHERE id = $2", [
      Date.now(),
      job.id,
    ]);
    console.info("MOBILE_JOB_RUNNING", job.kind, job.id);
    try {
      const result = await runJob(JSON.parse(job.payload));
      await d.execute(
        "UPDATE jobs SET status = 'done', result = $1, progress = '', updated_at = $2 WHERE id = $3",
        [result, Date.now(), job.id]
      );
      console.info("MOBILE_JOB_DONE", job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await d.execute(
        "UPDATE jobs SET status = 'error', result = $1, updated_at = $2 WHERE id = $3",
        [msg, Date.now(), job.id]
      );
      console.warn("MOBILE_JOB_ERROR", job.id, msg);
    }
  } finally {
    busy = false;
  }
}

async function runJob(payload: { notebook_id: string; content?: string; kind?: string } & Record<string, unknown>): Promise<string> {
  if (payload.kind === undefined && typeof payload.content === "string") return runChatJob(payload as never);
  return runGenerateJob(payload as never);
}

/* ---------------------------------- chat ---------------------------------- */

async function runChatJob(p: {
  notebook_id: string;
  content: string;
  chat_id?: string | null;
  new_chat?: boolean;
}): Promise<string> {
  const settings = await loadSettings();
  const key = activeKey(settings);
  if (!key) throw new Error("Add an API key in Settings on the desktop first.");

  let chatId: string | null = p.chat_id ?? null;
  if (!chatId && !p.new_chat) {
    const d = await getDb();
    const rows = await d.select<{ id: string }[]>(
      "SELECT id FROM chats WHERE notebook_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [p.notebook_id]
    );
    chatId = rows[0]?.id ?? null;
  }
  if (!chatId) {
    const c = await createChat(p.notebook_id, "Mobile chat");
    chatId = c.id;
  }

  await addMessage(chatId, p.notebook_id, "user", p.content);
  const [history, sources] = await Promise.all([
    listMessages(chatId),
    listSources(p.notebook_id),
  ]);
  const grounded = (await getNotebookGrounded(p.notebook_id)) !== 0;
  let retrieved: Awaited<ReturnType<typeof rankChunks>> = [];
  if (grounded) {
    await ensureIndexed(sources, settings);
    retrieved = await rankChunks(sources, p.content, settings, 30_000);
  }
  const reply = (
    await complete({
      provider: settings.provider,
      apiKey: key,
      model: settings.model,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(sources, [], retrieved.length ? retrieved : undefined, { grounded }),
        },
        ...selectChatHistory(history).map((m) => ({
          role: m.role,
          content: stripHistoryImages(m.content),
        })),
      ],
    })
  ).trim();
  const answer = await downscaleGeneratedImages(reply || "(no response)");
  await addMessage(chatId, p.notebook_id, "assistant", answer);
  await touchChat(chatId);
  await touchNotebook(p.notebook_id);

  // Give brand-new mobile chats a real title from the first message.
  const d = await getDb();
  const cur = await d.select<{ title: string }[]>("SELECT title FROM chats WHERE id = $1", [chatId]);
  if (cur[0] && (cur[0].title === "Mobile chat" || cur[0].title === "New chat")) {
    await renameChat(chatId, p.content.slice(0, 50) || "Mobile chat");
  }
  return JSON.stringify({ chat_id: chatId, reply: answer });
}

/* -------------------------------- generate -------------------------------- */

const isTextSource = (s: Source) =>
  s.type !== "context" && s.content.length > 0 && !s.content.startsWith("data:");

interface GenOpts {
  amount: Amount;
  difficulty: Difficulty;
  focus: string;
  format: AudioFormat;
  length: AudioLength;
  report_type: string;
  custom_prompt: string;
  topic: string;
}

async function runGenerateJob(p: {
  notebook_id: string;
  kind: string;
  options: GenOpts;
}): Promise<string> {
  const settings = await loadSettings();
  const key = activeKey(settings);
  if (!key) throw new Error("Add an API key in Settings on the desktop first.");

  const sources = await listSources(p.notebook_id);
  const grounding = sources.filter((s) => s.type === "context" || isTextSource(s));
  const o = p.options;

  if (p.kind === "research") {
    const outcome = await deepResearch({
      settings,
      title: o.topic,
      description: "",
      onPhase: (phase) => void setJobProgress(phase),
    });
    for (const page of outcome.pages) {
      const src = await addSource(p.notebook_id, "link", page.title, page.text, page.url);
      void indexSource(src, settings);
    }
    await addArtifact(
      p.notebook_id,
      "research",
      o.topic,
      JSON.stringify({
        md: outcome.markdown,
        sources: (outcome.pages.length > 0 ? outcome.pages : outcome.hits.slice(0, 12)).map(
          (s) => ({ title: s.title, url: s.url })
        ),
      })
    );
    await touchNotebook(p.notebook_id);
    return `Saved research “${o.topic}” to Studio — ${outcome.pages.length} pages read & imported as sources.`;
  }

  if (grounding.length === 0 || !grounding.some(isTextSource)) {
    throw new Error("This notebook needs at least one text-based source (note, PDF, or link) first.");
  }
  await ensureIndexed(grounding, settings);
  /** Total prompt-usable text — decides direct generation vs. cached full-coverage condense. */
  const totalSourceChars = grounding
    .filter(isRetrievable)
    .reduce((sum, s) => sum + s.content.length, 0);
  const ask = async (prompt: string, opts: { exhaustive?: boolean } = {}) => {
    // Huge notebooks: cached whole-notebook condensation so every tool covers
    // ALL sources (the expensive pass is computed once, then shared).
    if (opts.exhaustive && totalSourceChars > MAP_REDUCE_THRESHOLD) {
      const notes = await condenseNotebook(p.notebook_id, grounding, settings, (ph) =>
        void setJobProgress(ph)
      );
      return complete({
        provider: settings.provider,
        apiKey: key,
        model: settings.model,
        maxTokens: 4096,
        messages: [
          { role: "system", content: condensedSystemPrompt(notes) },
          { role: "user", content: prompt },
        ],
      });
    }
    const retrieved = await rankChunks(grounding, prompt, settings, 30_000);
    return complete({
      provider: settings.provider,
      apiKey: key,
      model: settings.model,
      maxTokens: 4096,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(grounding, [], retrieved.length ? retrieved : undefined),
        },
        { role: "user", content: prompt },
      ],
    });
  };

  let title: string;
  let data: string;
  let done: string;
  switch (p.kind) {
    case "flashcards": {
      const raw = await ask(
        buildFlashcardsPrompt({ amount: o.amount, difficulty: o.difficulty, sourceIds: [], description: o.focus }),
        { exhaustive: true }
      );
      const parsed = JSON.parse(extractJson(raw));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("The model returned an unexpected format. Try again.");
      title = "Flashcards";
      data = JSON.stringify(parsed);
      done = `Saved ${parsed.length} flashcards to Studio.`;
      break;
    }
    case "quiz": {
      const raw = await ask(
        buildQuizPrompt({ amount: o.amount, difficulty: o.difficulty, sourceIds: [], description: o.focus }),
        { exhaustive: true }
      );
      const parsed = JSON.parse(extractJson(raw));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("The model returned an unexpected format. Try again.");
      title = "Quiz";
      data = JSON.stringify(parsed);
      done = `Saved a ${parsed.length}-question quiz to Studio.`;
      break;
    }
    case "mindmap": {
      const raw = await ask(buildMindmapPrompt(o.focus), { exhaustive: true });
      data = raw
        .replace(/```(?:markdown|md)?\s*\n?/g, "")
        .replace(/```$/gm, "")
        .trim();
      title = "Mind map";
      done = "Saved a mind map to Studio.";
      break;
    }
    case "report": {
      const type = o.report_type as "study-guide" | "briefing-doc" | "analysis" | "custom";
      title = type === "custom" ? "Custom report" : REPORT_TYPE_LABELS[type];
      const doc = (await ask(buildReportPrompt(type, o.custom_prompt), { exhaustive: true })).trim();
      if (doc.length < 30) throw new Error("The report came back empty — try again.");
      data = doc;
      done = `Saved report “${title}” to Studio.`;
      break;
    }
    case "audio": {
      void setJobProgress("Drafting script…");
      const opts: AudioOptions = {
        format: o.format,
        length: o.length,
        mode: "conversation",
        sourceIds: [],
        description: o.focus,
      };
      const raw = await ask(buildAudioPrompt(opts), { exhaustive: true });
      const turns = parseScript(raw);
      if (turns.length < 4) throw new Error("Couldn't produce a usable script — try again.");
      let audio: string | null = null;
      let note: string | undefined;
      try {
        const result = await synthesizeScript(turns, settings, {
          onProgress: (i, total) => void setJobProgress(`Synthesizing audio ${i + 1}/${total}…`),
        });
        audio = result.audio;
        note = result.note;
      } catch (e) {
        note = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
      }
      title = "Audio overview";
      data = JSON.stringify({ audio, script: turns, note });
      done = `Saved an audio overview to Studio — ${turns.length} turns${audio ? " · audio ready" : ""}${note ? ` · ${note}` : ""}.`;
      break;
    }
    default:
      throw new Error(`Unknown generation kind: ${p.kind}`);
  }
  await addArtifact(p.notebook_id, p.kind as never, title, data);
  await touchNotebook(p.notebook_id);
  return done;
}

/* -------------------------------- helpers --------------------------------- */

async function setJobProgress(progress: string): Promise<void> {
  // Current running job = the one this runner is mid-flight on.
  const d = await getDb();
  await d.execute(
    "UPDATE jobs SET progress = $1 WHERE status = 'running'",
    [progress]
  );
}
