import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ setSetting: vi.fn() }));
vi.mock("../platform", () => ({ platform: { kind: "desktop", setAppIcon: vi.fn() } }));

import {
  BUILT_IN_LOOKS,
  DEFAULT_LOOK_PREFS,
  DEFAULT_STYLE,
  decodeLook,
  encodeLook,
  FEEL_STOPS,
  feelIndex,
  lookFromSettings,
  parseLook,
  parseLookPrefs,
  parseMyLooks,
  sanitizeCss,
  settingsForLook,
  wearing,
  type AppearanceSettings,
} from "./look";
import { APP_ICONS, iconSvgFor, parseAppIcon } from "./appIcon";
import { isNotebookColor, notebookTintStyle } from "./notebookColors";
import { COVER_STYLES } from "./covers";
import { THEMES } from "./themes";
import { FONTS } from "./fonts";

const base: AppearanceSettings = {
  theme: "brew",
  font: "system",
  customBg: "#0c0306",
  customText: "#ff6b8f",
  customAccent: "",
  look: { ...DEFAULT_LOOK_PREFS },
};

describe("look prefs", () => {
  it("a fresh install looks like it always did", () => {
    expect(parseLookPrefs("")).toEqual(DEFAULT_LOOK_PREFS);
    expect(DEFAULT_STYLE).toMatchObject({ shape: "soft", density: "cozy", leading: "normal", width: "medium" });
  });

  it("keeps what's valid and drops the rest", () => {
    const p = parseLookPrefs(
      JSON.stringify({ shape: "round", density: "huge", readFont: "serif", codeFont: "nope", darkTheme: "midnight", contrast: true, focusRings: "yes" })
    );
    expect(p.shape).toBe("round");
    expect(p.density).toBe("cozy");
    expect(p.readFont).toBe("serif");
    expect(p.codeFont).toBe("default");
    expect(p.darkTheme).toBe("midnight");
    expect(p.contrast).toBe(true);
    expect(p.focusRings).toBe(false);
  });

  it("survives garbage", () => {
    expect(parseLookPrefs("{not json")).toEqual(DEFAULT_LOOK_PREFS);
    expect(parseLookPrefs("[1,2]")).toEqual(DEFAULT_LOOK_PREFS);
    expect(parseMyLooks("{oops")).toEqual([]);
  });
});

describe("built-in looks", () => {
  it("use themes and fonts that exist, with unique ids", () => {
    const ids = new Set<string>();
    for (const l of BUILT_IN_LOOKS) {
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
      expect(THEMES.some((t) => t.id === l.theme)).toBe(true);
      expect(FONTS.some((f) => f.id === l.font)).toBe(true);
      expect(parseLook(l)).toMatchObject({ theme: l.theme, font: l.font, shape: l.shape, chatStyle: l.chatStyle });
    }
  });

  it("House Blend is what a fresh install wears", () => {
    expect(wearing(BUILT_IN_LOOKS[0], base)).toBe(true);
    expect(BUILT_IN_LOOKS.slice(1).some((l) => wearing(l, base))).toBe(false);
  });
});

describe("wearing a look", () => {
  it("puts every detail on", () => {
    const espresso = BUILT_IN_LOOKS.find((l) => l.id === "espresso")!;
    const next = { ...base, ...settingsForLook(espresso, base) } as AppearanceSettings;
    expect(next.theme).toBe("copper");
    expect(next.look.lookId).toBe("espresso");
    expect(wearing(espresso, next)).toBe(true);
  });

  it("fills the dark slot when matching the system", () => {
    const s = { ...base, look: { ...base.look, matchSystem: true, darkTheme: "copper" } };
    const night = BUILT_IN_LOOKS.find((l) => l.id === "nightshift")!;
    const p = settingsForLook(night, s);
    expect(p.theme).toBeUndefined();
    expect(p.look?.darkTheme).toBe("midnight");
  });

  it("brings Custom Blend's colors along", () => {
    const s = { ...base, theme: "custom", customBg: "#101820", customText: "#fee715" };
    const mine = lookFromSettings(s, "  Bumblebee  ");
    expect(mine.name).toBe("Bumblebee");
    expect(mine.custom).toEqual({ bg: "#101820", text: "#fee715", accent: "" });
    const p = settingsForLook(mine, base);
    expect(p).toMatchObject({ theme: "custom", customBg: "#101820", customText: "#fee715" });
  });
});

describe("share codes", () => {
  it("round-trip a look", () => {
    const mine = lookFromSettings({ ...base, look: { ...base.look, shape: "round", chatStyle: "transcript" } }, "Mine ☕");
    const code = encodeLook(mine);
    expect(code.startsWith("BREWLOOK1.")).toBe(true);
    const back = decodeLook(`Here you go: ${code} enjoy`);
    expect(back).toMatchObject({ name: "Mine ☕", theme: "brew", shape: "round", chatStyle: "transcript" });
    expect(back?.id).not.toBe(mine.id);
  });

  it("never carries custom CSS or accessibility choices", () => {
    const code = encodeLook(lookFromSettings({ ...base, look: { ...base.look, customCss: "body{}", contrast: true } }, "x"));
    const json = atob(code.slice("BREWLOOK1.".length).replace(/-/g, "+").replace(/_/g, "/"));
    expect(json).not.toContain("customCss");
    expect(json).not.toContain("contrast");
  });

  it("refuses codes that aren't looks", () => {
    expect(decodeLook("hello")).toBeNull();
    expect(decodeLook("BREWLOOK1.!!!")).toBeNull();
    expect(decodeLook(`BREWLOOK1.${btoa(JSON.stringify({ name: "x", theme: "nope" }))}`)).toBeNull();
    expect(decodeLook(`BREWLOOK1.${btoa(JSON.stringify({ name: "x", theme: "custom", custom: { bg: "red" } }))}`)).toBeNull();
  });
});

describe("feel slider", () => {
  it("each stop is found again, and a mix is no stop", () => {
    FEEL_STOPS.forEach((f, i) => expect(feelIndex(f)).toBe(i));
    expect(feelIndex(DEFAULT_STYLE)).toBe(2);
    expect(feelIndex({ shape: "sharp", density: "roomy", leading: "tight", width: "full" })).toBe(-1);
  });
});

describe("custom CSS", () => {
  it("keeps ordinary rules", () => {
    expect(sanitizeCss(".md h2 { color: var(--color-accent); }")).toBe(".md h2 { color: var(--color-accent); }");
  });

  it("takes out anything that could load from the network", () => {
    const evil = [
      "@import 'https://x.test/a.css';",
      "body { background: url(https://x.test/p.png) }",
      "body { background: URL ( 'https://x.test' ) }",
      "body { background: u\\72 l(https://x.test) }",
      "body { background: ur/**/l(https://x.test) }",
      "body { background-image: image-set('https://x.test/a.png' 1x) }",
      "body { background-image: -webkit-image-set('https://x.test/a.png' 1x) }",
      "</style><script>alert(1)</script>",
    ].join("\n");
    const out = sanitizeCss(evil);
    expect(out).not.toMatch(/url\s*\(/i);
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/image-set\(/i);
    expect(out).not.toMatch(/<\/?style/i);
  });
});

describe("app icons", () => {
  it("recolors every part of the icon in one pass", () => {
    for (const v of APP_ICONS.slice(1)) {
      const svg = iconSvgFor(v.id);
      expect(svg).not.toContain("#FF4B1F");
      expect(svg).toContain(v.base[0]);
    }
    // Cream's tile is white like the original mug, and its mug is orange: the tile must stay white.
    const cream = iconSvgFor("cream");
    expect(cream).toContain('stop-color="#FFFFFF"');
    expect(cream).toContain('fill="#F2541B"');
  });

  it("falls back to the house icon", () => {
    expect(parseAppIcon("nope")).toBe("classic");
    expect(parseAppIcon("matcha")).toBe("matcha");
  });
});

describe("notebook colors", () => {
  it("give a light and a dark shade, each with readable text", () => {
    expect(isNotebookColor("teal")).toBe(true);
    expect(isNotebookColor("plaid")).toBe(false);
    for (const c of COVER_STYLES) expect(isNotebookColor(c.color)).toBe(true);
    expect(notebookTintStyle("")).toBeUndefined();
    expect(notebookTintStyle("blue")).toMatchObject({ "--nb-light": "#2563eb", "--nb-light-ink": "#ffffff" });
    expect(notebookTintStyle("amber")).toMatchObject({ "--nb-dark-ink": "#111111" });
  });
});
