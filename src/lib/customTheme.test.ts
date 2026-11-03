import { describe, expect, it } from "vitest";
import { contrast, hexToRgb, hsvToRgb, normalizeHex, rgbToHex, rgbToHsv } from "./color";
import { customPalette, DEFAULT_CUSTOM_BG, DEFAULT_CUSTOM_TEXT } from "./customTheme";

const PAIRS: [string, string][] = [
  [DEFAULT_CUSTOM_BG, DEFAULT_CUSTOM_TEXT],
  ["#000000", "#ffffff"],
  ["#ffffff", "#000000"],
  ["#000000", "#22e05c"],
  ["#fff8f3", "#f2541b"], // light bg, mid-contrast text
  ["#808080", "#7f7f80"], // near-identical greys
  ["#ffff00", "#ffffaa"], // light on light
  ["#000033", "#000066"], // dark on dark
  ["#ff0000", "#00ff00"],
  ["#123456", "#123456"], // the same color twice
];

describe("customPalette", () => {
  it.each(PAIRS)("keeps text readable on %s with %s", (bg, text) => {
    const p = customPalette({ bg, text });
    for (const surface of [p["--color-panel"], p["--color-hover"]]) {
      for (const ink of ["--color-ink", "--color-ink-2", "--color-ink-3", "--color-link"])
        expect(contrast(p[ink], surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p["--color-accent"], p["--color-panel"])).toBeGreaterThanOrEqual(3);
    expect(contrast(p["--color-accent-ink"], p["--color-accent"])).toBeGreaterThanOrEqual(3);
    expect(contrast(p["--color-pre-ink"], p["--color-pre-bg"])).toBeGreaterThanOrEqual(7);
  });

  it("uses the picks as is when they already read well", () => {
    const p = customPalette({ bg: "#000000", text: "#22e05c" });
    expect(p["--color-canvas"]).toBe("#000000");
    expect(p["--color-ink"]).toBe("#22e05c");
    expect(p["--color-accent"]).toBe("#22e05c");
  });

  it.each(PAIRS)("keeps buttons and links readable with a separate accent on %s", (bg, text) => {
    for (const accent of ["#ff8a1f", "#000000", "#ffffff", bg]) {
      const p = customPalette({ bg, text, accent });
      expect(contrast(p["--color-accent"], p["--color-panel"])).toBeGreaterThanOrEqual(3);
      expect(contrast(p["--color-accent-ink"], p["--color-accent"])).toBeGreaterThanOrEqual(3);
      expect(contrast(p["--color-link"], p["--color-hover"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the accent for buttons and keeps the text as picked", () => {
    const p = customPalette({ bg: "#000000", text: "#e8e8e8", accent: "#ff8a1f" });
    expect(p["--color-ink"]).toBe("#e8e8e8");
    expect(p["--color-accent"]).toBe("#ff8a1f");
  });

  it("treats an empty accent as the text color", () => {
    const pair = { bg: DEFAULT_CUSTOM_BG, text: DEFAULT_CUSTOM_TEXT };
    expect(customPalette({ ...pair, accent: "" })).toEqual(customPalette(pair));
    expect(customPalette({ ...pair, accent: DEFAULT_CUSTOM_TEXT })).toEqual(customPalette(pair));
  });

  it("follows the background for light or dark mode", () => {
    expect(customPalette({ bg: "#000000", text: "#ffffff" })["color-scheme"]).toBe("dark");
    expect(customPalette({ bg: "#ffffff", text: "#000000" })["color-scheme"]).toBe("light");
  });
});

describe("color helpers", () => {
  it("round-trips hex through HSV", () => {
    for (const [bg, text] of PAIRS)
      for (const hex of [bg, text]) expect(rgbToHex(hsvToRgb(...rgbToHsv(hexToRgb(hex))))).toBe(hex);
  });

  it("normalizes hex input", () => {
    expect(normalizeHex("F0a")).toBe("#ff00aa");
    expect(normalizeHex(" #12ABef ")).toBe("#12abef");
    expect(normalizeHex("#12345")).toBeNull();
  });
});
