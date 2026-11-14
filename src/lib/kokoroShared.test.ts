import { describe, expect, it } from "vitest";
import { splitForKokoro } from "./kokoroShared";

describe("splitForKokoro", () => {
  it("keeps short text whole and joins sentences up to the limit", () => {
    expect(splitForKokoro("Hello there.  How are you?")).toEqual(["Hello there. How are you?"]);
    expect(splitForKokoro("One two. Three four. Five six.", 12)).toEqual(["One two.", "Three four.", "Five six."]);
  });

  it("splits a sentence longer than the limit at commas or spaces, losing nothing", () => {
    const long = "alpha beta gamma, delta epsilon zeta, eta theta iota kappa lambda mu.";
    const parts = splitForKokoro(long, 30);
    expect(parts.every((p) => p.length <= 30)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("returns nothing for empty text", () => {
    expect(splitForKokoro("   ")).toEqual([]);
  });
});
