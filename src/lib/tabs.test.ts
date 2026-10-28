import { describe, expect, it } from "vitest";
import { activate, close, cycle, EMPTY_TABS, MAX_TABS, move, open, prune, type TabsState } from "./tabs";

const withTabs = (...ids: string[]): TabsState => ids.reduce((s, id) => open(s, id), EMPTY_TABS);

describe("tabs", () => {
  it("opens a tab and shows it", () => {
    const s = open(EMPTY_TABS, "a");
    expect(s.ids).toEqual(["a"]);
    expect(s.active).toBe("a");
    expect(s.loaded).toEqual(["a"]);
  });

  it("opens in the background without showing or loading it", () => {
    const s = open(open(EMPTY_TABS, "a"), "b", true);
    expect(s.ids).toEqual(["a", "b"]);
    expect(s.active).toBe("a");
    expect(s.loaded).toEqual(["a"]);
  });

  it("re-opening an open notebook focuses its tab instead of adding one", () => {
    const s = open(withTabs("a", "b"), "a");
    expect(s.ids).toEqual(["a", "b"]);
    expect(s.active).toBe("a");
  });

  it("closing the active tab shows its right neighbour, then left, then Home", () => {
    let s = activate(withTabs("a", "b", "c"), "b");
    s = close(s, "b");
    expect(s.active).toBe("c");
    s = close(s, "c");
    expect(s.active).toBe("a");
    s = close(s, "a");
    expect(s.active).toBeNull();
    expect(s.ids).toEqual([]);
  });

  it("closing a background tab keeps the active one", () => {
    const s = close(withTabs("a", "b"), "a");
    expect(s.active).toBe("b");
  });

  it("makes room by closing the least recently used idle tab", () => {
    const ids = Array.from({ length: MAX_TABS }, (_, i) => `n${i}`);
    let s = withTabs(...ids);
    s = activate(s, "n0"); // n0 is now the most recent; n1 the least
    s = open(s, "new", false, (id) => id === "n1"); // …but n1 is busy
    expect(s.ids).toHaveLength(MAX_TABS);
    expect(s.ids).not.toContain("n2");
    expect(s.ids).toContain("n1");
    expect(s.active).toBe("new");
  });

  it("goes over the cap rather than close a busy tab", () => {
    const ids = Array.from({ length: MAX_TABS }, (_, i) => `n${i}`);
    const s = open(withTabs(...ids), "new", false, () => true);
    expect(s.ids).toHaveLength(MAX_TABS + 1);
  });

  it("reorders", () => {
    expect(move(withTabs("a", "b", "c"), "c", 0).ids).toEqual(["c", "a", "b"]);
    expect(move(withTabs("a", "b", "c"), "a", 99).ids).toEqual(["b", "c", "a"]);
  });

  it("cycles with wrap-around, and from Home starts at an end", () => {
    let s = withTabs("a", "b", "c"); // c active
    expect(cycle(s, 1).active).toBe("a");
    expect(cycle(s, -1).active).toBe("b");
    s = activate(s, null);
    expect(cycle(s, 1).active).toBe("a");
    expect(cycle(s, -1).active).toBe("c");
  });

  it("prunes tabs whose notebook is gone", () => {
    const s = prune(activate(withTabs("a", "b", "c"), "b"), (id) => id !== "b");
    expect(s.ids).toEqual(["a", "c"]);
    expect(s.active).toBe("c");
  });
});
