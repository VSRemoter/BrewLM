import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Job {
  id: string;
  kind: string;
  notebook_id: string;
  status: string;
  payload: string;
  result: string;
}

/** The `jobs` table, as the sharing server and the runner see it. */
let jobs: Job[] = [];
/** Signals the model calls were sent, newest last. */
const calls: AbortSignal[] = [];
/** Finishes every model call still waiting. */
let release: () => void = () => {};
const addArtifact = vi.fn(async () => {});
const deleteChat = vi.fn(async () => {});
const announceChanges = vi.fn();
/** Chats that exist, as `id@notebook`. */
let chats = new Set<string>();
const QUICK_KINDS = ["link", "chat.delete", "edit"];
/** The desktop functions an edit may call, by name → args. */
const edits: [string, unknown[]][] = [];
const record = (name: string) => async (...a: unknown[]) => {
  edits.push([name, a]);
};
const addSource = vi.fn(async (...a: unknown[]) => {
  edits.push(["addSource", a]);
  return { id: "new", title: a[2] };
});
const SOURCE = { id: "s1", notebook_id: "nb", type: "text", title: "Old", content: "body", text: "", pinned: 0 };
const ARTIFACTS: Record<string, { id: string; notebook_id: string; kind: string; title: string; data: string }> = {
  r1: { id: "r1", notebook_id: "nb", kind: "report", title: "Report", data: "# Findings" },
  d1: { id: "d1", notebook_id: "nb", kind: "drawing", title: "Sketch", data: "{}" },
};

const fakeDb = {
  async select(sql: string, bind: unknown[] = []) {
    if (sql.includes("WHERE status = 'pending'")) {
      const quick = !sql.includes("NOT (");
      return jobs.filter((j) => j.status === "pending" && QUICK_KINDS.includes(j.kind) === quick).slice(0, 1);
    }
    if (sql.startsWith("SELECT * FROM sources WHERE id")) {
      return bind[0] === SOURCE.id && bind[1] === SOURCE.notebook_id ? [SOURCE] : [];
    }
    if (sql.startsWith("SELECT content FROM messages")) {
      return bind[0] === "m2" ? [{ content: "## The answer\nDetails" }] : [];
    }
    if (sql.startsWith("SELECT title FROM chats WHERE id")) return [{ title: "Physics chat" }];
    if (sql.startsWith("SELECT id FROM chats WHERE id")) {
      return chats.has(`${bind[0]}@${bind[1]}`) ? [{ id: bind[0] }] : [];
    }
    if (sql.startsWith("SELECT status FROM jobs WHERE id")) {
      return jobs.filter((j) => j.id === bind[0]).map((j) => ({ status: j.status }));
    }
    throw new Error(`unexpected select: ${sql}`);
  },
  async execute(sql: string, bind: unknown[] = []) {
    const set = (id: unknown, from: string, to: Partial<Job>) => {
      const j = jobs.find((x) => x.id === id && x.status === from);
      if (j) Object.assign(j, to);
      return { rowsAffected: j ? 1 : 0 };
    };
    if (sql.includes("SET progress")) return { rowsAffected: 0 };
    if (sql.includes("SET status = 'running'")) return set(bind[1], "pending", { status: "running" });
    if (sql.includes("SET status = 'done'")) return set(bind[2], "running", { status: "done", result: String(bind[0]) });
    if (sql.includes("SET status = 'error'") && sql.includes("WHERE id")) {
      return set(bind[2], "running", { status: "error", result: String(bind[0]) });
    }
    if (sql.includes("SET status = 'error'")) {
      for (const j of jobs) if (j.status === "running") j.status = "error";
      return { rowsAffected: 0 };
    }
    throw new Error(`unexpected execute: ${sql}`);
  },
};

vi.mock("../components/ChatPanel", () => ({
  buildSystemParts: () => ({ stable: "", volatile: "" }),
  buildSystemPrompt: () => "system",
  selectChatHistory: () => [],
  replySourceTitle: (c: string) => `title of ${c.split("\n")[0]}`,
}));
vi.mock("./mentions", () => ({
  artifactText: (a: { kind: string; data: string }) => (a.kind === "drawing" ? null : a.data),
  buildMentionCatalog: () => [],
  resolveMentions: () => [],
}));
vi.mock("./chatTurns", () => ({
  isImageTurn: async (t: string) => t.startsWith("/image"),
  groundReply: (on: boolean) => `grounding ${on ? "on" : "off"}`,
  SUMMARIZE_RE: /^\/summarize(\s|$)/i,
}));
vi.mock("./db", () => ({
  addArtifact: (...a: unknown[]) => addArtifact(...(a as [])),
  deleteChat: (...a: unknown[]) => deleteChat(...(a as [])),
  addSource: (...a: unknown[]) => addSource(...a),
  updateSource: record("updateSource"),
  setSourcePinned: record("setSourcePinned"),
  deleteSource: record("deleteSource"),
  renameArtifact: record("renameArtifact"),
  setArtifactPinned: record("setArtifactPinned"),
  deleteArtifact: record("deleteArtifact"),
  getArtifact: async (id: string) => ARTIFACTS[id] ?? null,
  addMessage: async (...a: unknown[]) => {
    edits.push(["addMessage", a]);
    return { id: `msg${edits.length}` };
  },
  listMessages: async () => [],
  getNotebookGrounded: async () => 1,
  getNotebookConstitutionOn: async () => 1,
  setNotebookGrounded: record("setNotebookGrounded"),
  touchChat: async () => {},
  renameChat: async () => {},
  getDb: async () => fakeDb,
  listArtifacts: async () => [],
  listSources: async () => [{ id: "s1", type: "text", title: "S", content: "facts", text: "" }],
  sourceText: (s: { content: string }) => s.content,
  touchNotebook: async () => {},
}));
vi.mock("./llm", () => ({
  complete: (opts: { signal: AbortSignal }) => {
    calls.push(opts.signal);
    return new Promise<string>((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      const prev = release;
      release = () => {
        prev();
        resolve('[{"q":"?","options":["a","b"],"answer":0}]');
      };
    });
  },
  extractJson: (s: string) => s,
  isAbortError: (e: unknown) => e instanceof Error && e.name === "AbortError",
}));
vi.mock("./studioVariety", () => ({
  shuffleQuizOptions: (q: unknown) => q,
  varietyNote: () => "",
  withVariety: (p: string) => p,
}));
vi.mock("./genImage", () => ({}));
vi.mock("./rag", () => ({
  ensureIndexed: async () => {},
  isRetrievable: () => true,
  MAP_REDUCE_THRESHOLD: 1e9,
  rankChunks: async () => [],
}));
vi.mock("./media", () => ({}));
vi.mock("./source", () => ({}));
vi.mock("./research", () => ({}));
vi.mock("./local", () => ({ contextBudget: () => ({ sources: 1000, history: 1000 }) }));
vi.mock("./settings", () => ({
  activeKey: () => "key",
  loadSettings: async () => ({ provider: "openrouter", model: "m" }),
}));
vi.mock("./studio", () => ({ buildQuizPrompt: () => "make a quiz", REPORT_TYPE_LABELS: {} }));
vi.mock("./audioScript", () => ({}));
vi.mock("./tts", () => ({}));
vi.mock("./sync", () => ({ announceChanges: (...a: unknown[]) => announceChanges(...(a as [])) }));
vi.mock("./usage", () => ({
  meterTotal: () => null,
  meterUsage: () => {},
  newUsageMeter: () => ({}),
  recordUsage: async () => {},
}));

vi.stubGlobal("window", globalThis);
const { startJobRunner, stopJobRunner } = await import("./jobRunner");

const quizJob = (): Job => ({
  id: "j1",
  kind: "generate",
  notebook_id: "nb",
  status: "pending",
  payload: JSON.stringify({ notebook_id: "nb", kind: "quiz", options: {} }),
  result: "",
});
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("phone job cancel", () => {
  beforeEach(() => {
    jobs = [];
    calls.length = 0;
    release = () => {};
    addArtifact.mockClear();
    announceChanges.mockClear();
  });
  afterEach(() => stopJobRunner());

  it("a job the phone cancels mid-run stops its model call and saves nothing", async () => {
    jobs = [quizJob()];
    startJobRunner();
    await until(() => calls.length > 0);
    expect(jobs[0].status).toBe("running");

    jobs[0].status = "cancelled"; // what the sharing server's cancel does
    await until(() => calls[0].aborted);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(addArtifact).not.toHaveBeenCalled();
    expect(jobs[0].status).toBe("cancelled");
  });

  it("a job left alone still finishes and saves", async () => {
    jobs = [quizJob()];
    startJobRunner();
    await until(() => calls.length > 0);
    release();
    await until(() => jobs[0].status === "done");
    expect(addArtifact).toHaveBeenCalledTimes(1);
    expect(calls[0].aborted).toBe(false);
    // The desktop's open Studio list hears about it.
    expect(announceChanges).toHaveBeenCalledWith(
      expect.objectContaining({ tables: new Set(["artifacts", "notebooks"]), notebookIds: new Set(["nb"]) })
    );
  });
});

describe("phone chat delete", () => {
  const deleteJob = (id: string, chatId: string): Job => ({
    id,
    kind: "chat.delete",
    notebook_id: "nb",
    status: "pending",
    payload: JSON.stringify({ notebook_id: "nb", kind: "chat.delete", chat_id: chatId }),
    result: "",
  });
  beforeEach(() => {
    jobs = [];
    calls.length = 0;
    release = () => {};
    chats = new Set(["c1@nb"]);
    deleteChat.mockClear();
    announceChanges.mockClear();
  });
  afterEach(() => {
    release();
    stopJobRunner();
  });

  it("runs the desktop's deleteChat without waiting behind a Studio job", async () => {
    jobs = [quizJob(), deleteJob("d1", "c1")];
    startJobRunner();
    await until(() => jobs[1].status === "done");
    expect(jobs[0].status).toBe("running"); // the quiz is still mid-call
    expect(deleteChat).toHaveBeenCalledWith("c1");
    expect(announceChanges).toHaveBeenCalledWith({
      tables: new Set(["chats", "messages"]),
      notebookIds: new Set(["nb"]),
      chatIds: new Set(["c1"]),
    });
  });

  it("a chat that's already gone counts as deleted", async () => {
    jobs = [deleteJob("d2", "c-gone")];
    startJobRunner();
    await until(() => jobs[0].status === "done");
    expect(deleteChat).not.toHaveBeenCalled();
  });
});

describe("phone item edits", () => {
  const edit = (id: string, payload: Record<string, unknown>): Job => ({
    id,
    kind: "edit",
    notebook_id: "nb",
    status: "pending",
    payload: JSON.stringify({ notebook_id: "nb", kind: "edit", title: "", ...payload }),
    result: "",
  });
  beforeEach(() => {
    jobs = [];
    edits.length = 0;
    announceChanges.mockClear();
  });
  afterEach(() => stopJobRunner());

  it("runs each edit with the desktop's own functions", async () => {
    jobs = [
      edit("e1", { target: "source", id: "s1", op: "rename", title: "New" }),
      edit("e2", { target: "source", id: "s1", op: "pin" }),
      edit("e3", { target: "source", id: "s1", op: "delete" }),
      edit("e4", { target: "artifact", id: "r1", op: "unpin" }),
      edit("e5", { target: "artifact", id: "r1", op: "rename", title: "Renamed" }),
      edit("e6", { target: "artifact", id: "r1", op: "to-source" }),
      edit("e7", { target: "message", id: "m2", op: "to-source" }),
      edit("e8", { target: "artifact", id: "r1", op: "delete" }),
    ];
    startJobRunner();
    await until(() => jobs.every((j) => j.status === "done"), 8000);
    expect(edits).toEqual([
      ["updateSource", ["s1", "New", "body"]],
      ["setSourcePinned", ["s1", true]],
      ["deleteSource", ["s1"]],
      ["setArtifactPinned", ["r1", false]],
      ["renameArtifact", ["r1", "Renamed"]],
      ["addSource", ["nb", "text", "Report", "# Findings"]],
      ["addSource", ["nb", "text", "title of ## The answer", "## The answer\nDetails"]],
      ["deleteArtifact", ["r1"]],
    ]);
    expect(announceChanges).toHaveBeenCalledWith(expect.objectContaining({ tables: new Set(["sources"]) }));
    expect(announceChanges).toHaveBeenCalledWith(expect.objectContaining({ tables: new Set(["artifacts"]) }));
  });

  it("says why an edit can't run", async () => {
    jobs = [
      edit("e1", { target: "artifact", id: "d1", op: "to-source" }),
      edit("e2", { target: "source", id: "gone", op: "delete" }),
    ];
    startJobRunner();
    await until(() => jobs.every((j) => j.status === "error"), 8000);
    expect(jobs.map((j) => j.result)).toEqual([
      "This output has no readable text to add as a source.",
      "That source is gone.",
    ]);
    expect(edits).toEqual([]);
  });
});

describe("phone chat commands", () => {
  const chat = (id: string, content: string): Job => ({
    id,
    kind: "chat",
    notebook_id: "nb",
    status: "pending",
    payload: JSON.stringify({ notebook_id: "nb", content, chat_id: "c1" }),
    result: "",
  });
  const replies = () => edits.filter(([n, a]) => n === "addMessage" && a[2] === "assistant").map(([, a]) => a[3]);
  beforeEach(() => {
    jobs = [];
    edits.length = 0;
    calls.length = 0;
  });
  afterEach(() => stopJobRunner());

  it("answers commands as the desktop chat does, without the chat model", async () => {
    jobs = [chat("g", "/ground"), chat("n", "/note  Ohm's law: V = IR "), chat("m", "/model gpt-5")];
    startJobRunner();
    await until(() => jobs.every((j) => j.status === "done"), 12000);
    expect(calls).toHaveLength(0); // no model call
    expect(edits).toContainEqual(["setNotebookGrounded", ["nb", false]]);
    expect(edits).toContainEqual(["addSource", ["nb", "text", "Ohm's law: V = IR", "Ohm's law: V = IR"]]);
    expect(replies()).toEqual([
      "grounding off",
      "Saved “Ohm's law: V = IR” as a source — it's in Sources, and the AI can now ground answers in it.",
      "`/model` changes BrewLM on your computer — use it in the chat there. Type `/help` here to see what works from your phone.",
    ]);
    expect(JSON.parse(jobs[0].result)).toMatchObject({ chat_id: "c1", reply: "grounding off", details: "" });
  }, 15000);
});
