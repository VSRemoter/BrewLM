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

const fakeDb = {
  async select(sql: string, bind: unknown[] = []) {
    if (sql.includes("WHERE status = 'pending'")) {
      const links = sql.includes("kind = 'link'");
      return jobs.filter((j) => j.status === "pending" && (j.kind === "link") === links).slice(0, 1);
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
}));
vi.mock("./db", () => ({
  addArtifact: (...a: unknown[]) => addArtifact(...(a as [])),
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
  });
});
