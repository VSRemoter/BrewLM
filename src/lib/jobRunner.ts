/**
 * Mobile job runner: phones queue chat/generate/link jobs into the `jobs`
 * table (via the sharing server); this loop — running in the desktop webview —
 * drains them with the exact same pipelines as the desktop (LLM chat, Studio,
 * the Add link reader), writing results (chat messages, artifacts, sources)
 * straight into the shared SQLite database.
 *
 * Quick jobs (links, chat deletes, item edits) run in a lane of their own: reading a page
 * takes seconds, and shouldn't wait behind a podcast or deep research the
 * phone also queued. Every finished job announces what it changed, so the
 * desktop's open screens refresh as they do for Sync.
 */
import { buildSystemParts, buildSystemPrompt, replySourceTitle, selectChatHistory } from "../components/ChatPanel";
import {
  addArtifact,
  addMessage,
  addSource,
  createChat,
  deleteArtifact,
  deleteChat,
  deleteSource,
  getArtifact,
  getDb,
  getNotebookConstitutionOn,
  getNotebookGrounded,
  listArtifacts,
  listMessages,
  listSources,
  renameArtifact,
  renameChat,
  setArtifactPinned,
  setMessageReasoning,
  setNotebookConstitutionOn,
  setNotebookGrounded,
  setSourcePinned,
  sourceText,
  touchChat,
  touchNotebook,
  updateSource,
} from "./db";
import { artifactText, buildMentionCatalog, resolveMentions, type MentionItem } from "./mentions";
import { complete, extractJson, isAbortError, streamChat, type StreamUsage } from "./llm";
import {
  constitutionTurn,
  fetchTurn,
  groundReply,
  imageTurn,
  isImageTurn,
  searchTurn,
  SUMMARIZE_PROMPT,
  SUMMARIZE_RE,
} from "./chatTurns";
import { stripFetchMarker } from "./fetchList";
import { interactivePrior, pickAngle, pickFormat, shuffleQuizOptions, varietyNote, withVariety } from "./studioVariety";
import { buildPagePrompt, buildStoryboardPrompt, PAGE_SYSTEM, writePage } from "./interactive";
import { storeGeneratedImages, stripHistoryImages } from "./genImage";
import {
  condenseNotebook,
  condensedSystemPrompt,
  ensureIndexed,
  indexSource,
  isRetrievable,
  MAP_REDUCE_THRESHOLD,
  rankChunks,
  wholeNotebookFits,
} from "./rag";
import { ensureMediaText } from "./media";
import { fetchLinkContent } from "./source";
import { deepResearch } from "./research";
import { contextBudget } from "./local";
import { activeKey, loadSettings } from "./settings";
import {
  buildFlashcardsPrompt,
  buildMindmapPrompt,
  buildQuizPrompt,
  buildReportPrompt,
  REPORT_TYPE_LABELS,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type AudioMode,
  type AudioOptions,
  type Difficulty,
} from "./studio";
import { writeAudioScript } from "./audioScript";
import { synthesizeScript } from "./tts";
import { fmtUsageLine, meterTotal, meterUsage, newUsageMeter, recordUsage, replyCostUsd } from "./usage";
import { announceChanges } from "./sync";
import type { ChatMessage, Source, Thinking } from "./types";

const POLL_MS = 3000;

interface JobRow {
  id: string;
  kind: string;
  notebook_id: string;
  status: string;
  payload: string;
}

/** Job kinds the quick lane runs; everything else (chat, generate) is the main lane. */
const QUICK = "kind IN ('link', 'chat.delete', 'edit')";

let timer: number | null = null;
let busy = false;
let linkBusy = false;

/** Tell the desktop's open screens what a phone job changed (as Sync does). */
function announce(tables: string[], notebookId: string, chatId?: string | null): void {
  announceChanges({
    tables: new Set(tables),
    notebookIds: new Set([notebookId]),
    chatIds: new Set(chatId ? [chatId] : []),
  });
}

/** Call once on app boot; safe to call again (idempotent). */
export function startJobRunner(): void {
  if (timer !== null) return;
  console.info("MOBILE_JOB_RUNNER_STARTED");
  const tick = () => {
    void drainOnce().catch((e) => console.warn("job runner:", e));
    void drainLinksOnce().catch((e) => console.warn("job runner (links):", e));
  };
  timer = window.setInterval(tick, POLL_MS);
  // Fail anything the last run left mid-flight before draining, so the
  // first drain can't race it.
  busy = linkBusy = true;
  void failInterruptedJobs()
    .catch((e) => console.warn("job runner:", e))
    .finally(() => {
      busy = linkBusy = false;
      tick();
    });
}

/**
 * A job still `running` at boot was cut off by a crash or quit — nothing is
 * working on it, and the drain loop only picks up `pending` ones. Fail it so
 * the phone stops showing it as in progress.
 */
async function failInterruptedJobs(): Promise<void> {
  const d = await getDb();
  await d.execute(
    "UPDATE jobs SET status = 'error', result = $1, progress = '', updated_at = $2 WHERE status = 'running'",
    ["BrewLM closed before this finished — try again.", Date.now()]
  );
}

export function stopJobRunner(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

/** Chat and Studio jobs, one at a time. */
async function drainOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runNext(`NOT (${QUICK})`, (payload, signal) => runJob(payload, signal));
  } finally {
    busy = false;
  }
}

/** Phone-added links, chat deletes and item edits, one at a time, beside the chat/Studio lane. */
async function drainLinksOnce(): Promise<void> {
  if (linkBusy) return;
  linkBusy = true;
  try {
    // Quick jobs back to back, so a few taps on the phone don't each wait a tick.
    while (
      await runNext(QUICK, (payload, signal) =>
        payload.kind === "chat.delete"
          ? runChatDeleteJob(payload as never)
          : payload.kind === "edit"
            ? runEditJob(payload as never)
            : runLinkJob(payload as never, signal)
      )
    );
  } finally {
    linkBusy = false;
  }
}

/** How often a running job checks whether the phone cancelled it. */
const CANCEL_POLL_MS = 1500;

/**
 * Claim the oldest pending job matching `where`, run it, and record the
 * outcome. False when there was nothing to run.
 */
async function runNext(
  where: string,
  run: (payload: { notebook_id: string } & Record<string, unknown>, signal: AbortSignal) => Promise<string>
): Promise<boolean> {
  const d = await getDb();
  const rows = await d.select<JobRow[]>(
    `SELECT id, kind, notebook_id, status, payload FROM jobs WHERE status = 'pending' AND ${where} ORDER BY created_at ASC LIMIT 1`
  );
  const job = rows[0];
  if (!job) return false;
  // Only if still pending: the phone may have cancelled it since the select.
  const claimed = await d.execute(
    "UPDATE jobs SET status = 'running', updated_at = $1 WHERE id = $2 AND status = 'pending'",
    [Date.now(), job.id]
  );
  if (claimed.rowsAffected === 0) return true; // taken or cancelled meanwhile: look again
  console.info("MOBILE_JOB_RUNNING", job.kind, job.id);
  // The phone cancels by setting the row's status (see the sharing server).
  const ctrl = new AbortController();
  const watch = window.setInterval(() => {
    void d
      .select<{ status: string }[]>("SELECT status FROM jobs WHERE id = $1", [job.id])
      .then((r) => {
        if (r[0]?.status === "cancelled") ctrl.abort();
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);
  // Outcomes only land on a job still running, so a cancel is never overwritten.
  try {
    const result = await run(JSON.parse(job.payload), ctrl.signal);
    await d.execute(
      "UPDATE jobs SET status = 'done', result = $1, progress = '', updated_at = $2 WHERE id = $3 AND status = 'running'",
      [result, Date.now(), job.id]
    );
    console.info("MOBILE_JOB_DONE", job.id);
  } catch (e) {
    if (ctrl.signal.aborted) {
      console.info("MOBILE_JOB_CANCELLED", job.id);
      return true;
    }
    const msg = e instanceof Error ? e.message : String(e);
    await d.execute(
      "UPDATE jobs SET status = 'error', result = $1, updated_at = $2 WHERE id = $3 AND status = 'running'",
      [msg, Date.now(), job.id]
    );
    console.warn("MOBILE_JOB_ERROR", job.id, msg);
  } finally {
    window.clearInterval(watch);
  }
  return true;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

async function runJob(
  payload: { notebook_id: string; content?: string; kind?: string } & Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  if (payload.kind === undefined && typeof payload.content === "string") return runChatJob(payload as never, signal);
  return runGenerateJob(payload as never, signal);
}

/* ---------------------------------- link ---------------------------------- */

/** A link added from the phone: read exactly as Add link on the desktop does, then saved as a source. */
async function runLinkJob(p: { notebook_id: string; url: string }, signal: AbortSignal): Promise<string> {
  const { title, text, finalUrl } = await fetchLinkContent(p.url);
  throwIfAborted(signal);
  const src = await addSource(p.notebook_id, "link", title, text, finalUrl);
  await touchNotebook(p.notebook_id);
  announce(["sources", "notebooks"], p.notebook_id);
  void loadSettings()
    .then((settings) => indexSource(src, settings))
    .catch(() => {});
  return JSON.stringify({ id: src.id, title: src.title });
}

/* ------------------------------- chat delete ------------------------------ */

/**
 * A chat deleted from the phone: the desktop's own deleteChat, as Delete in
 * its chat list runs it — the messages, their stored reasoning and any
 * picture only this chat used go with it. Already gone counts as done.
 */
async function runChatDeleteJob(p: { notebook_id: string; chat_id: string }): Promise<string> {
  const d = await getDb();
  const rows = await d.select<{ id: string }[]>(
    "SELECT id FROM chats WHERE id = $1 AND notebook_id = $2",
    [p.chat_id, p.notebook_id]
  );
  if (rows.length > 0) await deleteChat(p.chat_id);
  announce(["chats", "messages"], p.notebook_id, p.chat_id);
  return JSON.stringify({ deleted: p.chat_id });
}

/* ------------------------------- item edits ------------------------------- */

interface EditJob {
  notebook_id: string;
  target: "source" | "artifact" | "message";
  id: string;
  op: "rename" | "pin" | "unpin" | "delete" | "to-source";
  title: string;
}

/**
 * One edit from the phone, run with the same functions as the desktop's own
 * buttons: the Sources list (rename, pin, remove), the Studio list (rename,
 * pin, delete), an output's "Add to sources" and a reply's "Save to Sources".
 */
async function runEditJob(p: EditJob): Promise<string> {
  const d = await getDb();
  if (p.target === "source") {
    const rows = await d.select<Source[]>("SELECT * FROM sources WHERE id = $1 AND notebook_id = $2", [
      p.id,
      p.notebook_id,
    ]);
    const s = rows[0];
    if (!s) throw new Error("That source is gone.");
    if (p.op === "rename") await updateSource(s.id, p.title, s.content);
    else if (p.op === "pin" || p.op === "unpin") await setSourcePinned(s.id, p.op === "pin");
    else if (p.op === "delete") await deleteSource(s.id);
    else throw new Error(`Unknown action: ${p.op}`);
    announce(["sources"], p.notebook_id);
    return JSON.stringify({ ok: true });
  }

  if (p.target === "artifact") {
    const a = await getArtifact(p.id);
    if (!a || a.notebook_id !== p.notebook_id) throw new Error("That output is gone.");
    if (p.op === "to-source") {
      const text = artifactText(a);
      if (!text) throw new Error("This output has no readable text to add as a source.");
      await addSource(a.notebook_id, "text", a.title, text);
      announce(["sources"], p.notebook_id);
      return JSON.stringify({ ok: true });
    }
    if (p.op === "rename") await renameArtifact(a.id, p.title);
    else if (p.op === "pin" || p.op === "unpin") await setArtifactPinned(a.id, p.op === "pin");
    else if (p.op === "delete") await deleteArtifact(a.id);
    else throw new Error(`Unknown action: ${p.op}`);
    announce(["artifacts"], p.notebook_id);
    return JSON.stringify({ ok: true });
  }

  if (p.target === "message" && p.op === "to-source") {
    const rows = await d.select<{ content: string }[]>(
      "SELECT content FROM messages WHERE id = $1 AND notebook_id = $2 AND role = 'assistant'",
      [p.id, p.notebook_id]
    );
    const content = rows[0]?.content ?? "";
    if (!content.trim()) throw new Error("That reply is gone.");
    await addSource(p.notebook_id, "text", replySourceTitle(content), content);
    announce(["sources"], p.notebook_id);
    return JSON.stringify({ ok: true });
  }
  throw new Error(`Unknown action: ${p.target} ${p.op}`);
}

/* ---------------------------------- chat ---------------------------------- */

/** Desktop chat commands that only make sense on the computer (settings, windows). */
const DESKTOP_ONLY_COMMANDS = /^\/(model|imagemodel|researchmodel|voice|voicehost|voicecohost|provider|thinking|font|fonts|move|clone|remove|queue|return|star)(?=\s|$)/i;

/**
 * A chat command from the phone, answered as the desktop chat answers it (the
 * same code, in chatTurns.ts): pictures, /search, /fetch, /ground,
 * /constitution, /note, /url. Null = not a command; send it to the model.
 */
async function runChatCommand(
  text: string,
  c: {
    notebookId: string;
    chatId: string;
    history: ChatMessage[];
    sources: Source[];
    catalog: MentionItem[];
    grounded: boolean;
    constitutionOn: boolean;
    imageId?: string | null;
    signal: AbortSignal;
  }
): Promise<string | null> {
  const settings = await loadSettings();
  if (await isImageTurn(text, settings)) {
    return imageTurn({
      text,
      history: c.history,
      settings,
      notebookId: c.notebookId,
      chatId: c.chatId,
      imageId: c.imageId ?? undefined,
      signal: c.signal,
    });
  }
  if (/^\/search(\s|$)/i.test(text)) {
    const query = text.replace(/^\/search\s*/i, "").trim();
    return searchTurn({
      query,
      settings,
      sources: c.sources,
      mentioned: resolveMentions(query, c.catalog),
      grounded: c.grounded,
      constitution: c.constitutionOn,
      signal: c.signal,
    });
  }
  if (/^\/fetch(\s|$)/i.test(text)) {
    return fetchTurn({ request: text.replace(/^\/fetch\s*/i, ""), settings, signal: c.signal });
  }
  if (/^\/ground(\s|$)/i.test(text)) {
    await setNotebookGrounded(c.notebookId, !c.grounded);
    announce(["notebooks"], c.notebookId);
    return groundReply(!c.grounded);
  }
  if (/^\/constitution(\s|$)/i.test(text)) {
    const { reply, next } = constitutionTurn(
      text.replace(/^\/constitution\s*/i, ""),
      c.constitutionOn,
      c.sources.some((s) => s.type === "context")
    );
    if (next !== null) {
      await setNotebookConstitutionOn(c.notebookId, next);
      announce(["notebooks"], c.notebookId);
    }
    return reply;
  }
  if (/^\/note(\s|$)/i.test(text)) {
    const body = text.replace(/^\/note\s*/i, "").trim();
    if (!body) return "Paste your note right after the command, e.g. `/note today's lecture covered…`";
    // Titled as the desktop titles /note (NotebookView's handleAddNote).
    const flat = body.replace(/\s+/g, " ").trim();
    const title = flat.length > 42 ? flat.slice(0, 42).trimEnd() + "…" : flat || "Pasted note";
    const src = await addSource(c.notebookId, "text", title, body);
    announce(["sources"], c.notebookId);
    return `Saved “${src.title}” as a source — it's in Sources, and the AI can now ground answers in it.`;
  }
  if (/^\/url(\s|$)/i.test(text)) {
    const raw = text.replace(/^\/url\s*/i, "").trim();
    if (!raw) return "Give me a link to add, e.g. `/url https://en.wikipedia.org/wiki/Photosynthesis`";
    if (!/^https?:\/\//i.test(raw)) return "Links need to start with http:// or https:// — try again with the full URL.";
    const { title, text: body, finalUrl } = await fetchLinkContent(raw);
    const src = await addSource(c.notebookId, "link", title, body, finalUrl);
    void indexSource(src, settings).catch(() => {});
    announce(["sources"], c.notebookId);
    return `Saved “${src.title}” as a source — it's in Sources, and the AI can now ground answers in it.`;
  }
  const desktopOnly = DESKTOP_ONLY_COMMANDS.exec(text)?.[0];
  if (desktopOnly)
    return `\`${desktopOnly}\` changes BrewLM on your computer — use it in the chat there. Type \`/help\` here to see what works from your phone.`;
  return null;
}

/** How often a streaming phone reply is written out for the phone to show. */
const STREAM_PROGRESS_MS = 500;

async function runChatJob(p: {
  notebook_id: string;
  content: string;
  chat_id?: string | null;
  new_chat?: boolean;
  /** The phone's Thinking effort pick; absent (older phone page) = the desktop's. */
  thinking?: Thinking | null;
  /** The picture an image action works on (/edit, /remix, /more); else the chat's latest. */
  image_id?: string | null;
}, signal: AbortSignal): Promise<string> {
  const settings = await loadSettings();

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
  const [history, allSources, artifacts] = await Promise.all([
    listMessages(chatId),
    listSources(p.notebook_id),
    listArtifacts(p.notebook_id),
  ]);
  const text = p.content.trim();
  const grounded = (await getNotebookGrounded(p.notebook_id)) !== 0;
  const constitutionOn = (await getNotebookConstitutionOn(p.notebook_id)) !== 0;
  const catalog = buildMentionCatalog(allSources, artifacts);

  let answer: string;
  /** The usage line under the reply ("9.8k in · 637 out · $0.0042"), as /details shows it. */
  let details = "";
  const command = await runChatCommand(text, {
    notebookId: p.notebook_id,
    chatId,
    history,
    sources: allSources,
    catalog,
    grounded,
    constitutionOn,
    imageId: p.image_id,
    signal,
  });
  if (command !== null) {
    throwIfAborted(signal);
    answer = command;
    await addMessage(chatId, p.notebook_id, "assistant", answer);
  } else {
    const key = activeKey(settings);
    if (!key) throw new Error("Add an API key in Settings on the desktop first.");
    const isSummarize = SUMMARIZE_RE.test(text);
    // Mentions from recent user turns keep their priority across follow-ups.
    const mentioned = resolveMentions(
      history
        .filter((m) => m.role === "user")
        .slice(-8)
        .map((m) => m.content)
        .join("\n"),
      catalog
    );
    const sources = await withoutConstitutionIfOff(p.notebook_id, allSources);
    // Same prompt layout as desktop chat: a notebook that fits is sent whole and
    // unchanged on every message (served from the prompt cache); a bigger one
    // gets per-question excerpts in a second system message after the cached part.
    const budget = contextBudget(settings);
    let retrieved: Awaited<ReturnType<typeof rankChunks>> | undefined;
    let whole = false;
    if (grounded) {
      try {
        await ensureMediaText(sources, settings);
        whole = wholeNotebookFits(sources, budget.sources);
        if (whole) {
          void ensureIndexed(sources, settings).catch(() => {});
        } else {
          await ensureIndexed(sources, settings);
          const ranked = await rankChunks(sources, p.content, settings, budget.sources);
          const mentionedIds = new Set(mentioned.filter((m) => m.group === "source").map((m) => m.id));
          const filtered = ranked.filter((r) => !mentionedIds.has(r.sourceId));
          if (filtered.length) retrieved = filtered;
        }
      } catch (e) {
        console.warn("rag: retrieval skipped", e);
      }
    }
    const system = buildSystemParts(sources, mentioned, retrieved, { grounded, budget, whole });
    const turns = selectChatHistory(history, budget.history);
    let acc = "";
    let thought = "";
    let usage: StreamUsage | null = null;
    let shown = 0;
    try {
      for await (const delta of streamChat({
        provider: settings.provider,
        apiKey: key,
        model: settings.model,
        temperature: settings.temperature ?? undefined,
        thinking: p.thinking ?? settings.thinking,
        maxOutput: settings.maxOutput,
        signal,
        onUsage: (u) => {
          usage = u;
          void recordUsage("chat", settings.provider, settings.model, u);
        },
        onReasoning: (r) => {
          thought = r;
        },
        cacheKey: p.notebook_id,
        // Per-question excerpts sit before the history, so a history breakpoint
        // would only pay the cache-write premium (see ChatPanel).
        cacheHistory: !retrieved,
        messages: [
          { role: "system", content: system.stable },
          ...(system.volatile ? [{ role: "system" as const, content: system.volatile }] : []),
          ...turns.map((m, i) => ({
            role: m.role,
            // The bubble keeps "/summarize"; the model gets the real prompt.
            content: stripFetchMarker(
              stripHistoryImages(
                isSummarize && i === turns.length - 1 && m.role === "user" ? SUMMARIZE_PROMPT : m.content
              )
            ),
          })),
        ],
      })) {
        acc += delta;
        // The phone shows the reply as it's written.
        if (Date.now() - shown > STREAM_PROGRESS_MS) {
          shown = Date.now();
          void setJobProgress(acc);
        }
      }
      throwIfAborted(signal);
    } catch (e) {
      // A failure partway keeps what was written, as the desktop does; a stop keeps nothing.
      if (!signal.aborted && !isAbortError(e) && acc.trim()) {
        const partial = await addMessage(chatId, p.notebook_id, "assistant", acc);
        if (thought.trim()) await setMessageReasoning(partial.id, thought.trim());
        announce(["chats", "messages"], p.notebook_id, chatId);
      }
      throw e;
    }
    answer = await storeGeneratedImages(acc.trim() || "(no response)", {
      notebookId: p.notebook_id,
      chatId,
      prompt: p.content,
      model: settings.model,
    });
    const reply = await addMessage(chatId, p.notebook_id, "assistant", answer);
    // Reasoning stays beside the reply (never in it, so it isn't sent back to the model).
    if (thought.trim()) await setMessageReasoning(reply.id, thought.trim());
    if (usage) {
      const u: StreamUsage = usage;
      const cost = replyCostUsd(settings.provider, settings.model, u);
      details = fmtUsageLine({ ...u, costUsd: cost?.usd, estimated: cost?.estimated });
    }
  }
  await touchChat(chatId);
  await touchNotebook(p.notebook_id);

  // Give brand-new mobile chats a real title from the first message.
  const d = await getDb();
  const cur = await d.select<{ title: string }[]>("SELECT title FROM chats WHERE id = $1", [chatId]);
  if (cur[0] && (cur[0].title === "Mobile chat" || cur[0].title === "New chat")) {
    const first = SUMMARIZE_RE.test(text) ? "Notebook summary" : p.content.slice(0, 50);
    await renameChat(chatId, first || "Mobile chat");
  }
  announce(["chats", "messages", "notebooks"], p.notebook_id, chatId);
  return JSON.stringify({ chat_id: chatId, reply: answer, details });
}

/* -------------------------------- generate -------------------------------- */

const isTextSource = isRetrievable;

interface GenOpts {
  amount: Amount;
  difficulty: Difficulty;
  focus: string;
  format: AudioFormat;
  length: AudioLength;
  /** "" (or absent, from an older phone page) = the desktop's Studio Defaults pick. */
  mode?: AudioMode | "";
  report_type: string;
  custom_prompt: string;
  topic: string;
}

async function runGenerateJob(p: {
  notebook_id: string;
  kind: string;
  options: GenOpts;
}, signal: AbortSignal): Promise<string> {
  const settings = await loadSettings();
  const key = activeKey(settings);
  if (!key) throw new Error("Add an API key in Settings on the desktop first.");

  // Studio ignores the constitution — its tools carry their own settings.
  const grounding = (await listSources(p.notebook_id)).filter(isTextSource);
  const o = p.options;
  /** What this output cost to make, saved with it. */
  const meter = newUsageMeter();

  if (p.kind === "research") {
    const outcome = await deepResearch({
      settings,
      title: o.topic,
      description: "",
      signal,
      onPhase: (phase) => void setJobProgress(phase),
      onUsage: (provider, model, u) => meterUsage(meter, provider, model, u),
    });
    throwIfAborted(signal);
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
      }),
      meterTotal(meter)
    );
    await touchNotebook(p.notebook_id);
    announce(["artifacts", "sources", "notebooks"], p.notebook_id);
    return `Saved research “${o.topic}” to Studio — ${outcome.pages.length} pages read & imported as sources.`;
  }

  if (grounding.length === 0 || !grounding.some(isTextSource)) {
    throw new Error("This notebook needs at least one text-based source (note, PDF, or link) first.");
  }
  await ensureIndexed(grounding, settings);
  /** Total prompt-usable text — decides direct generation vs. cached full-coverage condense. */
  const totalSourceChars = grounding
    .filter(isRetrievable)
    .reduce((sum, s) => sum + sourceText(s).length, 0);
  const tally = (u: StreamUsage) => {
    void recordUsage("studio", settings.provider, settings.model, u);
    meterUsage(meter, settings.provider, settings.model, u);
  };
  /** `query` = what to retrieve from the sources (defaults to the prompt itself). */
  const ask = async (prompt: string, opts: { exhaustive?: boolean; query?: string } = {}) => {
    // Huge notebooks: cached whole-notebook condensation so every tool covers
    // ALL sources (the expensive pass is computed once, then shared).
    if (opts.exhaustive && totalSourceChars > MAP_REDUCE_THRESHOLD) {
      const notes = await condenseNotebook(
        p.notebook_id,
        grounding,
        settings,
        (ph) => void setJobProgress(ph),
        signal
      );
      return complete({
        provider: settings.provider,
        apiKey: key,
        model: settings.model,
        thinking: settings.thinking,
        maxOutput: settings.maxOutput,
        temperature: settings.temperature ?? undefined,
        signal,
        onUsage: tally,
        messages: [
          { role: "system", content: condensedSystemPrompt(notes) },
          { role: "user", content: prompt },
        ],
      });
    }
    const retrieved = await rankChunks(grounding, opts.query ?? prompt, settings, contextBudget(settings).sources);
    return complete({
      provider: settings.provider,
      apiKey: key,
      model: settings.model,
      thinking: settings.thinking,
      maxOutput: settings.maxOutput,
      temperature: settings.temperature ?? undefined,
      signal,
      onUsage: tally,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(grounding, [], retrieved.length ? retrieved : undefined, { budget: contextBudget(settings) }),
        },
        { role: "user", content: prompt },
      ],
    });
  };

  // Variety, as in the Studio panel: what the notebook already has of this
  // kind, plus a random angle when no focus was given.
  const artifacts = await listArtifacts(p.notebook_id);
  const focused = (o.focus ?? "").trim() !== "";
  const vary = (kind: "flashcards" | "quiz" | "mindmap", prompt: string) =>
    withVariety(prompt, varietyNote(kind, artifacts, { focused }));

  let title: string;
  let data: string;
  let done: string;
  switch (p.kind) {
    case "flashcards": {
      const base = buildFlashcardsPrompt({ amount: o.amount, difficulty: o.difficulty, sourceIds: [], description: o.focus });
      const raw = await ask(vary("flashcards", base), { exhaustive: true, query: base });
      const parsed = JSON.parse(extractJson(raw));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("The model returned an unexpected format. Try again.");
      title = "Flashcards";
      data = JSON.stringify(parsed);
      done = `Saved ${parsed.length} flashcards to Studio.`;
      break;
    }
    case "quiz": {
      const base = buildQuizPrompt({ amount: o.amount, difficulty: o.difficulty, sourceIds: [], description: o.focus });
      const raw = await ask(vary("quiz", base), { exhaustive: true, query: base });
      const parsed = JSON.parse(extractJson(raw));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("The model returned an unexpected format. Try again.");
      title = "Quiz";
      data = JSON.stringify(shuffleQuizOptions(parsed));
      done = `Saved a ${parsed.length}-question quiz to Studio.`;
      break;
    }
    case "mindmap": {
      const base = buildMindmapPrompt(o.focus);
      const raw = await ask(vary("mindmap", base), { exhaustive: true, query: base });
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
      const opts: AudioOptions = {
        format: o.format,
        length: o.length,
        mode: o.mode || settings.defAudioMode,
        sourceIds: [],
        description: o.focus,
        variety: varietyNote("audio", artifacts, { focused }),
      };
      const turns = await writeAudioScript(
        opts,
        (prompt, focus) => ask(prompt, { exhaustive: true, query: focus }),
        (phase) => void setJobProgress(phase)
      );
      if (turns.length < 4) throw new Error("Couldn't produce a usable script — try again.");
      let audio: string | null = null;
      let note: string | undefined;
      try {
        const result = await synthesizeScript(turns, settings, {
          signal,
          onProgress: (i, total) => void setJobProgress(`Synthesizing audio ${i + 1}/${total}…`),
        });
        audio = result.audio;
        note = result.note;
      } catch (e) {
        if (isAbortError(e) || signal.aborted) throw e;
        note = `TTS failed (${e instanceof Error ? e.message : "unknown error"}) — script only`;
      }
      title = "Audio overview";
      data = JSON.stringify({ audio, script: turns, note });
      done = `Saved an audio overview to Studio — ${turns.length} turns${audio ? " · audio ready" : ""}${note ? ` · ${note}` : ""}.`;
      break;
    }
    case "interactive": {
      // As the Studio panel builds it: a storyboard grounded in the sources,
      // then the page written from the storyboard alone.
      const topic = (o.topic ?? "").trim();
      // No topic: draw an angle and a format so blank runs don't all pick the same idea.
      const lens = topic ? {} : { angle: pickAngle(), format: pickFormat() };
      void setJobProgress("Planning the storyboard…");
      const storyboard = (
        await ask(buildStoryboardPrompt({ topic }, { ...lens, prior: interactivePrior(artifacts) }), {
          exhaustive: true,
          query: topic || buildStoryboardPrompt({ topic }, lens),
        })
      ).trim();
      if (storyboard.length < 100) throw new Error("The storyboard came back empty — try again.");
      void setJobProgress("Building the page…");
      const html = await writePage({
        provider: settings.provider,
        apiKey: key,
        model: settings.model,
        thinking: settings.thinking,
        maxOutput: settings.maxOutput,
        temperature: settings.temperature ?? undefined,
        signal,
        onUsage: tally,
        messages: [
          { role: "system", content: PAGE_SYSTEM },
          { role: "user", content: buildPagePrompt(storyboard) },
        ],
        onProgress: (chars) =>
          void setJobProgress(`Building the page… ${Math.max(1, Math.round(chars / 1024))} KB written`),
      });
      title = "Interactive";
      data = JSON.stringify({ html, storyboard });
      done = "Saved an interactive page to Studio.";
      break;
    }
    default:
      throw new Error(`Unknown generation kind: ${p.kind}`);
  }
  throwIfAborted(signal);
  await addArtifact(p.notebook_id, p.kind as never, title, data, meterTotal(meter));
  await touchNotebook(p.notebook_id);
  announce(["artifacts", "notebooks"], p.notebook_id);
  return done;
}

/* -------------------------------- helpers --------------------------------- */

/** /constitution off: the constitution source stays, but no prompt sees it. */
async function withoutConstitutionIfOff(notebookId: string, sources: Source[]): Promise<Source[]> {
  if ((await getNotebookConstitutionOn(notebookId)) !== 0) return sources;
  return sources.filter((s) => s.type !== "context");
}

async function setJobProgress(progress: string): Promise<void> {
  // Current running job = the one this runner is mid-flight on.
  const d = await getDb();
  await d.execute(
    `UPDATE jobs SET progress = $1 WHERE status = 'running' AND NOT (${QUICK})`,
    [progress]
  );
}
