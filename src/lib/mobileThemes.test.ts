import { describe, expect, it, vi } from "vitest";
import html from "../../src-tauri/mobile.js?raw";
import { customPalette, DEFAULT_CUSTOM_BG, DEFAULT_CUSTOM_TEXT } from "./customTheme";
import { RETIRED_THEMES, THEMES } from "./themes";

vi.mock("./db", () => ({ setSetting: vi.fn() }));

/** The phone page's theme code (src-tauri/mobile.js), run on its own. */
type PhoneTheme = { name: string; scheme: string; v: Record<string, string> };
const code = html.slice(html.indexOf("const M_THEMES = {"), html.indexOf("function applyMobileTheme("));
const phone = new Function(`${code}; return { M_THEMES, RETIRED_THEMES, customTheme, addCustomTheme };`)() as {
  M_THEMES: Record<string, PhoneTheme>;
  RETIRED_THEMES: Record<string, string>;
  customTheme: (c: { bg: string; text: string; accent: string }) => PhoneTheme;
  addCustomTheme: (c: unknown) => void;
};

describe("phone page themes", () => {
  it("offers the desktop's themes, names and order", () => {
    const desktop = THEMES.filter((t) => t.id !== "custom");
    expect(Object.keys(phone.M_THEMES)).toEqual(desktop.map((t) => t.id));
    expect(Object.values(phone.M_THEMES).map((t) => t.name)).toEqual(desktop.map((t) => t.name));
    for (const t of desktop) {
      const v = phone.M_THEMES[t.id].v;
      expect([v.bg, v.panel, v.ink, v.accent], t.id).toEqual([t.swatch.canvas, t.swatch.panel, t.swatch.ink, t.swatch.accent]);
    }
    expect(phone.RETIRED_THEMES).toEqual(RETIRED_THEMES);
  });

  it.each([
    [DEFAULT_CUSTOM_BG, DEFAULT_CUSTOM_TEXT, ""],
    ["#060023", "#ff83f0", "#00fff8"],
    ["#ffffff", "#000000", ""],
    ["#fff8f3", "#f2541b", "#123456"],
    ["#808080", "#7f7f80", ""],
  ])("builds Custom Blend like the desktop (%s, %s, %s)", (bg, text, accent) => {
    const d = customPalette({ bg, text, accent });
    const p = phone.customTheme({ bg, text, accent });
    expect(p.scheme).toBe(d["color-scheme"]);
    expect(p.v).toEqual({
      bg: d["--color-canvas"],
      panel: d["--color-panel"],
      panel2: d["--color-hover"],
      edge: d["--color-edge"],
      ink: d["--color-ink"],
      ink2: d["--color-ink-2"],
      ink3: d["--color-ink-3"],
      accent: d["--color-accent"],
      onAccent: d["--color-accent-ink"],
    });
  });

  it("adds Custom Blend only when the desktop sends real colors", () => {
    phone.addCustomTheme({ bg: "", text: "", accent: "" });
    phone.addCustomTheme({ bg: "red", text: "#ffffff", accent: "" });
    expect(phone.M_THEMES.custom).toBeUndefined();
    phone.addCustomTheme({ bg: "#000000", text: "#ffffff", accent: "nope" });
    expect(phone.M_THEMES.custom.v.accent).toBe("#ffffff");
  });
});
