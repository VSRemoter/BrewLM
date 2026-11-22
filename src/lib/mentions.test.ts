import { describe, expect, it, vi } from "vitest";

// mentions.ts pulls in db.ts and interactive.ts, which need the app's platform.
vi.mock("./db", () => ({ sourceText: (s: { content: string }) => s.content }));
vi.mock("./interactive", () => ({ parseInteractive: () => null }));

import { linkKey, resolveMentions, type MentionItem } from "./mentions";

const link = (id: string, url: string): MentionItem => ({ id, title: `Page ${id}`, group: "source", type: "link", text: "body", url });

describe("linkKey", () => {
  it("ignores scheme, www, trailing slash and share-tracking parameters", () => {
    expect(linkKey("https://x.com/hqmank/status/2113443767009304792?s=20")).toBe(linkKey("http://twitter.com/hqmank/status/2113443767009304792/"));
    expect(linkKey("https://www.example.com/a?utm_source=x")).toBe("example.com/a");
  });
  it("keeps parameters that pick the page", () => {
    expect(linkKey("https://www.youtube.com/watch?v=abc&t=30")).toBe("youtube.com/watch?v=abc");
    expect(linkKey("https://youtube.com/watch?v=abc")).not.toBe(linkKey("https://youtube.com/watch?v=xyz"));
  });
});

describe("resolveMentions", () => {
  it("treats a pasted link source address as a mention", () => {
    const items = [link("a", "https://x.com/hqmank/status/2113443767009304792"), link("b", "https://example.com/other")];
    const got = resolveMentions("Here it is https://x.com/hqmank/status/2113443767009304792?s=46 — what does it say?", items);
    expect(got.map((m) => m.id)).toEqual(["a"]);
  });
  it("finds nothing for unrelated addresses", () => {
    expect(resolveMentions("see https://news.example.org/story", [link("a", "https://x.com/a/status/1")])).toEqual([]);
  });
});

import {
  keptRefs,
  matchScore,
  mentionBudget,
  parseMentionRefs,
  parseScope,
  pickerRows,
  segmentMentions,
  serializeMentionRefs,
  shareBudget,
  type IndexItem,
  type MentionIndex,
  type MentionRef,
} from "./mentions";

const item = (id: string, notebookId: string, title: string, group: "source" | "output" = "source"): IndexItem => ({
  id,
  notebookId,
  title,
  group,
  type: group === "source" ? "pdf" : "report",
  createdAt: 0,
});

const index: MentionIndex = {
  folders: [{ id: "f1", name: "Courses" }],
  notebooks: [
    { id: "here", title: "Physics", folderId: "", starred: false, updatedAt: 50 },
    { id: "stats", title: "Stats 101", folderId: "f1", starred: false, updatedAt: 40 },
    { id: "old", title: "Stats 101", folderId: "", starred: false, updatedAt: 10 },
    { id: "ml", title: "ML/AI", folderId: "f1", starred: true, updatedAt: 5 },
  ],
  items: [
    item("p1", "stats", "Probability review", "output"),
    item("p2", "stats", "Week 3 lecture"),
    item("p3", "old", "Probability review", "output"),
    item("p4", "ml", "Bayes notes"),
  ],
};
const local = [item("h1", "here", "Kinematics"), item("h2", "here", "Probability in physics")];

describe("mention refs", () => {
  it("round-trips and drops malformed entries", () => {
    const refs: MentionRef[] = [{ kind: "output", id: "p1", notebookId: "stats", title: "Probability review" }];
    expect(parseMentionRefs(serializeMentionRefs(refs))).toEqual(refs);
    expect(parseMentionRefs('[{"kind":"x","id":1}]')).toEqual([]);
    expect(parseMentionRefs("not json")).toEqual([]);
    expect(serializeMentionRefs([])).toBe("");
  });
  it("keeps only picks still in the text, once each", () => {
    const r = (id: string, title: string): MentionRef => ({ kind: "source", id, notebookId: "n", title });
    const kept = keptRefs([r("a", "Alpha"), r("b", "Beta"), r("a", "Alpha")], "compare @Alpha with this");
    expect(kept.map((x) => x.id)).toEqual(["a"]);
  });
  it("a pick wins over a same-named item in this notebook", () => {
    const pick = { id: "away", title: "Notes", group: "source" as const, type: "pdf", text: null, notebookId: "other" };
    const here = { id: "here", title: "Notes", group: "source" as const, type: "text", text: "x" };
    const segs = segmentMentions("see @Notes.", [pick, here]);
    expect(segs.map((s) => s.text)).toEqual(["see ", "@Notes", "."]);
    expect(segs.find((s) => s.item)?.item?.id).toBe("away");
  });
  it("matches a renamed item by the title it was mentioned with", () => {
    const renamed = { id: "a", title: "New name", matchTitle: "Old name", group: "output" as const, type: "report", text: null };
    expect(segmentMentions("use @Old name please", [renamed]).find((s) => s.item)?.text).toBe("@Old name");
  });
});

describe("parseScope", () => {
  it("opens a folder, then a notebook inside it", () => {
    expect(parseScope(index, "Courses/").scope?.folder?.id).toBe("f1");
    const { scope, rest } = parseScope(index, "Courses/Stats 101/prob");
    expect(scope?.notebook?.id).toBe("stats");
    expect(rest).toBe("prob");
  });
  it("handles a title containing a slash", () => {
    expect(parseScope(index, "ML/AI/bay").scope?.notebook?.id).toBe("ml");
  });
  it("same-named notebooks: the most recent by name, the picked one by hint", () => {
    expect(parseScope(index, "Stats 101/").scope?.notebook?.id).toBe("stats");
    expect(parseScope(index, "Stats 101/", { path: "Stats 101/", notebookId: "old" }).scope?.notebook?.id).toBe("old");
  });
  it("no slash, no scope", () => {
    expect(parseScope(index, "Stats").scope).toBeNull();
  });
});

describe("pickerRows", () => {
  it("@ alone: this notebook's items, then notebooks and folders to open", () => {
    const kinds = pickerRows(index, "", "here", local).rows.map((r) => r.kind);
    expect(kinds.slice(0, 2)).toEqual(["item", "item"]);
    expect(kinds).toContain("notebook");
    expect(kinds).toContain("folder");
  });
  it("searches every notebook, this one first, and says where each lives", () => {
    const rows = pickerRows(index, "prob", "here", local).rows;
    expect(rows[0]).toMatchObject({ kind: "item", item: { id: "h2" } });
    const away = rows.filter((r) => r.kind === "item" && r.notebook);
    expect(away.map((r) => (r.kind === "item" ? r.notebook?.id : ""))).toEqual(["stats", "old"]);
  });
  it("inside another notebook: 'all of it' first, then its items", () => {
    const rows = pickerRows(index, "Stats 101/", "here", local).rows;
    expect(rows[0]).toMatchObject({ kind: "whole", notebook: { id: "stats" } });
    expect(rows.slice(1).map((r) => (r.kind === "item" ? r.item.id : ""))).toEqual(["p1", "p2"]);
  });
  it("inside a folder: its notebooks", () => {
    const rows = pickerRows(index, "Courses/", "here", local).rows;
    expect(rows.every((r) => r.kind === "notebook")).toBe(true);
    expect(rows.length).toBe(2);
  });
  it("this notebook as a scope offers no 'all of it'", () => {
    const rows = pickerRows(index, "Physics/", "here", local).rows;
    expect(rows.some((r) => r.kind === "whole")).toBe(false);
    expect(rows.length).toBe(2);
  });
});

describe("matchScore", () => {
  it("ranks exact > prefix > word starts > anywhere", () => {
    const s = (t: string) => matchScore(t, "prob rev") ?? -1;
    expect(matchScore("prob", "prob")!).toBeGreaterThan(matchScore("probability", "prob")!);
    expect(s("Probability review")).toBeGreaterThan(s("improbable preview"));
    expect(matchScore("Kinematics", "prob")).toBeNull();
  });
});

describe("budget", () => {
  it("shares fairly: small items whole, the rest split", () => {
    expect(shareBudget([100, 10_000, 10_000], 10_100)).toEqual([100, 5000, 5000]);
    const caps = shareBudget([3, 7, 50], 30);
    expect(caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
    expect(caps.slice(0, 2)).toEqual([3, 7]);
  });
  it("gives other notebooks' material more room", () => {
    const b = { mentions: 16_000, sources: 200_000 };
    const here = { id: "a", title: "A", group: "source" as const, type: "pdf", text: "" };
    expect(mentionBudget(b, [here])).toBe(16_000);
    expect(mentionBudget(b, [{ ...here, notebookId: "other" }])).toBe(40_000);
    expect(mentionBudget({ mentions: 3000, sources: 6000 }, [{ ...here, group: "notebook" }])).toBe(3000);
  });
});
