import { ArrowLeftRight, Check, Download, Save } from "lucide-react";
import { useState } from "react";
import { FONTS } from "../../lib/fonts";
import { DEFAULT_THEME, isDarkTheme, THEMES } from "../../lib/themes";
import { applyCustomColors, customSwatch, type CustomColors } from "../../lib/customTheme";
import { setSmoothScroll } from "../../lib/smoothScroll";
import { getZoom, setZoom } from "../../lib/zoom";
import {
  activeThemeFor,
  applyAppearance,
  BUILT_IN_LOOKS,
  CHAT_SIDES,
  CHAT_STYLES,
  CODE_FONTS,
  CODE_THEMES,
  CSS_MAX,
  DENSITIES,
  encodeLook,
  FEEL_STOPS,
  feelIndex,
  nearestFeel,
  LEADINGS,
  lookFromSettings,
  settingsForLook,
  SHAPES,
  wearing,
  WIDTHS,
  type Look,
  type LookPrefs,
} from "../../lib/look";
import { APP_ICONS, chooseAppIcon, iconDataUrl } from "../../lib/appIcon";
import { confirmAction } from "../ConfirmDialog";
import { platform } from "../../platform";
import type { Settings } from "../../lib/types";
import { SelectMenu } from "../ui";
import ColorField from "./ColorField";
import { Card, Disclosure, Row, SectionTitle, Slider, Toggle } from "./controls";
import { ImportLookDialog, LookCard, SaveLookDialog, Segmented } from "./LookParts";

const CUSTOM_LABELS: Record<keyof CustomColors, string> = { bg: "Background", text: "Text", accent: "Accent" };

const nameOf = <T extends string>(list: { id: T; name: string }[], id: T) => list.find((x) => x.id === id)?.name ?? id;

export default function AppearanceSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [zoomPct, setZoomPct] = useState(() => Math.round(getZoom() * 100));
  const look = settings.look;

  /** Every appearance change: saved, and on screen at once. */
  const update = (p: Partial<Settings>) => {
    patch(p);
    applyAppearance({ ...settings, ...p });
  };
  const updateLook = (p: Partial<LookPrefs>) => update({ look: { ...look, ...p } });

  /* ---------------------------------- theme --------------------------------- */

  // With Match system on, a dark theme fills the dark slot and a light one the light slot.
  const pickTheme = (id: string) => {
    if (look.matchSystem && isDarkTheme(id)) updateLook({ darkTheme: id });
    else update({ theme: id });
  };
  const setMatchSystem = (on: boolean) => {
    if (!on) {
      // Keep the theme that's on screen.
      update({ theme: activeThemeFor(settings), look: { ...look, matchSystem: false } });
      return;
    }
    let theme = settings.theme;
    let darkTheme = isDarkTheme(look.darkTheme) ? look.darkTheme : "copper";
    if (isDarkTheme(theme)) {
      darkTheme = theme;
      theme = DEFAULT_THEME;
    }
    update({ theme, look: { ...look, matchSystem: true, darkTheme } });
  };

  // Custom theme: live while dragging in the picker, saved once a pick settles.
  const [custom, setCustom] = useState<Required<CustomColors>>({
    bg: settings.customBg,
    text: settings.customText,
    accent: settings.customAccent,
  });
  const previewCustom = (next: Required<CustomColors>) => {
    setCustom(next);
    applyCustomColors(next);
  };
  const saveCustom = (next: Required<CustomColors>) => {
    setCustom(next);
    update({ customBg: next.bg, customText: next.text, customAccent: next.accent });
  };

  /* ---------------------------------- looks --------------------------------- */

  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 2500);
  };
  const allLooks = [...BUILT_IN_LOOKS, ...settings.myLooks];
  const worn = allLooks.find((l) => wearing(l, settings));
  const baseLook = allLooks.find((l) => l.id === look.lookId);

  const wear = (l: Look) => {
    const p = settingsForLook(l, settings);
    if (l.custom) setCustom(l.custom);
    update(p);
  };
  const saveLook = (name: string) => {
    const l = lookFromSettings(settings, name);
    update({ myLooks: [...settings.myLooks, l], look: { ...look, lookId: l.id } });
    setSaving(false);
    flash(`Saved “${l.name}”`);
  };
  const importLook = (l: Look) => {
    const myLooks = [...settings.myLooks, l];
    if (l.custom) setCustom(l.custom);
    update({ ...settingsForLook(l, settings), myLooks });
    setImporting(false);
    flash(`Added “${l.name}”`);
  };
  const shareLook = async (l: Look) => {
    try {
      await navigator.clipboard.writeText(encodeLook(l));
      flash("Share code copied. Anyone can paste it into Import a Look.");
    } catch {
      flash("Couldn't copy the code.");
    }
  };
  const deleteLook = async (l: Look) => {
    const ok = await confirmAction({
      title: `Delete “${l.name}”?`,
      message: "The Look goes from your list. What's on screen now stays as it is.",
    });
    if (ok) update({ myLooks: settings.myLooks.filter((x) => x.id !== l.id) });
  };

  /* ---------------------------------- feel ---------------------------------- */

  const feel = feelIndex(look);
  const [feelDraft, setFeelDraft] = useState<number | null>(null);
  const feelShown = feelDraft ?? (feel >= 0 ? feel : nearestFeel(look));
  const commitFeel = () => {
    if (feelDraft === null) return;
    const { name: _name, ...stop } = FEEL_STOPS[feelDraft];
    setFeelDraft(null);
    updateLook(stop);
  };

  /* ---------------------------------- custom css ---------------------------------- */

  const [cssDraft, setCssDraft] = useState(look.customCss);

  const readFontName = look.readFont ? nameOf(FONTS, look.readFont) : "Same as interface";
  const iconWhere = platform.kind === "desktop" ? "Your Dock icon while BrewLM is open." : "The icon on BrewLM's browser tab.";

  return (
    <div>
      <SectionTitle title="Appearance" />

      <Card>
        {/* Text size — preview the number while dragging, apply on release so
            the UI (slider included) doesn't rescale under the cursor. */}
        <Row label="Text size">
          <div className="flex items-center gap-3">
            <Slider
              label="Text size"
              min={60}
              max={160}
              step={5}
              value={zoomPct}
              onChange={setZoomPct}
              onCommit={() => setZoomPct(Math.round(setZoom(zoomPct / 100) * 100))}
            />
            <span className="w-11 text-right font-mono text-[12px] text-ink-2">{zoomPct}%</span>
            {zoomPct !== 100 && (
              <button
                onClick={() => setZoomPct(Math.round(setZoom(1) * 100))}
                className="text-[12px] text-link hover:underline"
              >
                Reset
              </button>
            )}
          </div>
        </Row>
        <Row label="Feel" desc="Corners, spacing, line spacing and reading width in one slider.">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-3">Roomy</span>
            <Slider
              label="Feel"
              min={0}
              max={FEEL_STOPS.length - 1}
              step={1}
              value={feelShown}
              onChange={setFeelDraft}
              onCommit={commitFeel}
            />
            <span className="text-[11px] text-ink-3">Compact</span>
            <span className="w-16 text-right text-[12px] font-medium text-ink-2">
              {feelDraft !== null ? FEEL_STOPS[feelDraft].name : feel >= 0 ? FEEL_STOPS[feel].name : "Mixed"}
            </span>
          </div>
        </Row>
        <Row
          label="Match system light and dark"
          desc={
            look.matchSystem
              ? `${nameOf(THEMES, settings.theme)} in light mode, ${nameOf(THEMES, look.darkTheme)} in dark mode. Pick a light and a dark theme below.`
              : "Switch between a light and a dark theme with your computer's appearance."
          }
        >
          <Toggle label="Match system light and dark" checked={look.matchSystem} onChange={setMatchSystem} />
        </Row>
      </Card>

      {/* Looks */}
      <SectionTitle
        title="Look"
        desc="A complete style in one pick: colors, fonts, corners, spacing and chat style."
      />
      <div className="mb-2 grid grid-cols-4 gap-2">
        {allLooks.map((l) => {
          const mine = settings.myLooks.some((m) => m.id === l.id);
          return (
            <LookCard
              key={l.id}
              look={l}
              active={worn?.id === l.id}
              onPick={() => wear(l)}
              onShare={mine ? () => void shareLook(l) : undefined}
              onDelete={mine ? () => void deleteLook(l) : undefined}
            />
          );
        })}
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {!worn && (
          <span className="mr-auto text-[12px] text-ink-3">
            {baseLook ? `Your own take on ${baseLook.name}` : "Your own mix"}
          </span>
        )}
        {notice && <span className="mr-auto text-[12px] text-ok">{notice}</span>}
        <button
          onClick={() => setSaving(true)}
          disabled={!!worn}
          title={worn ? "Change something first: this is already a Look" : undefined}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <Save size={13} /> Save as a Look
        </button>
        <button
          onClick={() => setImporting(true)}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <Download size={13} /> Import a Look
        </button>
      </div>

      {/* Theme */}
      <SectionTitle
        title="Theme"
        desc={look.matchSystem ? "Pick one light and one dark theme; BrewLM follows your computer between them." : undefined}
      />
      <div className="mb-6 grid grid-cols-4 gap-2">
        {THEMES.map((t) => {
          const slot = look.matchSystem
            ? t.id === settings.theme
              ? "Light"
              : t.id === look.darkTheme
                ? "Dark"
                : ""
            : "";
          const active = look.matchSystem ? !!slot : settings.theme === t.id;
          const swatch = t.id === "custom" ? customSwatch(custom) : t.swatch;
          return (
            <button
              key={t.id}
              onClick={() => pickTheme(t.id)}
              className={`group flex flex-col gap-1.5 rounded-xl border p-1.5 text-left transition-all ${
                active ? "border-accent shadow-sm" : "border-edge hover:border-ink-3"
              }`}
              title={t.blurb}
            >
              {/* mini window preview */}
              <span
                className="relative block h-14 w-full overflow-hidden rounded-lg border border-edge"
                style={{ background: swatch.canvas }}
              >
                <span
                  className="absolute left-1.5 top-1.5 h-[calc(100%-12px)] w-[62%] rounded-[5px]"
                  style={{ background: swatch.panel }}
                >
                  <span
                    className="absolute left-1.5 right-3 top-1.5 h-[3px] rounded-full"
                    style={{ background: swatch.accent }}
                  />
                  <span
                    className="absolute left-1.5 right-5 top-3.5 h-[3px] rounded-full opacity-30"
                    style={{ background: swatch.ink }}
                  />
                  <span
                    className="absolute left-1.5 right-4 top-[21px] h-[3px] rounded-full opacity-30"
                    style={{ background: swatch.ink }}
                  />
                </span>
                <span
                  className="absolute bottom-1.5 right-1.5 h-4 w-4 rounded-full"
                  style={{ background: swatch.accent }}
                />
                {active && (
                  <span className="absolute right-1 top-1 flex h-4 items-center justify-center gap-0.5 rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-ink">
                    <Check size={10} strokeWidth={3} />
                    {slot}
                  </span>
                )}
              </span>
              <span className="px-0.5 pb-0.5">
                <span className={`block text-[11.5px] leading-tight ${active ? "font-semibold" : "font-medium"}`}>
                  {t.name}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Custom theme's colors — only while that theme is on */}
      {(settings.theme === "custom" || (look.matchSystem && look.darkTheme === "custom")) && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">Custom colors</h2>
            <button
              onClick={() => saveCustom({ ...custom, bg: custom.text, text: custom.bg })}
              title="Swap background and text"
              aria-label="Swap background and text"
              className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink"
            >
              <ArrowLeftRight size={14} />
            </button>
          </div>
          <Card>
            {(["bg", "text", "accent"] as const).map((k) => (
              <Row key={k} label={CUSTOM_LABELS[k]}>
                <ColorField
                  label={CUSTOM_LABELS[k]}
                  value={custom[k]}
                  fallback={custom.text}
                  placeholder={k === "accent" ? "Same as text" : undefined}
                  onChange={(hex) => previewCustom({ ...custom, [k]: hex })}
                  onCommit={(hex) => saveCustom({ ...custom, [k]: hex })}
                  onClear={k === "accent" ? () => saveCustom({ ...custom, accent: "" }) : undefined}
                />
              </Row>
            ))}
          </Card>
        </>
      )}

      {/* Customize: every detail a Look sets, one by one */}
      <SectionTitle
        title="Customize"
        desc="Fine-tune any detail. Save the result as a Look to keep it, or share it."
      />
      <div className="mb-6 border-b border-edge-soft">
        <Disclosure
          id="look.fonts"
          title="Fonts"
          summary={`${nameOf(FONTS, settings.font)} · ${readFontName} for reading · ${nameOf(CODE_FONTS, look.codeFont)} for code`}
        >
          <p className="mb-2 text-[12px] text-ink-3">Interface</p>
          <div className="mb-3 grid grid-cols-3 gap-2">
            {FONTS.map((f) => {
              const active = settings.font === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => update({ font: f.id })}
                  className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all ${
                    active ? "border-accent shadow-sm" : "border-edge hover:border-ink-3"
                  }`}
                >
                  <span className="text-[16px] leading-none" style={{ fontFamily: f.stack }}>
                    Ag
                  </span>
                  <span className={`text-[12px] leading-tight ${active ? "font-semibold" : "font-medium"}`}>{f.name}</span>
                  {active && <Check size={12} strokeWidth={3} className="ml-auto shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
          <Card>
            <Row label="Reading" desc="Chat replies, your messages and Studio reports.">
              <SelectMenu
                label="Reading font"
                value={look.readFont || "ui"}
                onChange={(id) => updateLook({ readFont: id === "ui" ? "" : id })}
                options={[
                  { id: "ui", label: "Same as interface" },
                  ...FONTS.filter((f) => f.id !== "system").map((f) => ({ id: f.id, label: f.name })),
                ]}
              />
            </Row>
            <Row label="Code">
              <SelectMenu
                label="Code font"
                value={look.codeFont}
                onChange={(id) => updateLook({ codeFont: id })}
                options={CODE_FONTS.map((f) => ({ id: f.id, label: f.name }))}
              />
            </Row>
          </Card>
        </Disclosure>

        <Disclosure
          id="look.shape"
          title="Shape and spacing"
          summary={`${nameOf(SHAPES, look.shape)} corners · ${nameOf(DENSITIES, look.density)} · ${nameOf(WIDTHS, look.width)} column`}
        >
          <Card>
            <Row label="Corners">
              <Segmented label="Corners" value={look.shape} options={SHAPES} onChange={(shape) => updateLook({ shape })} />
            </Row>
            <Row label="Density" desc="How much room buttons, lists and panels get.">
              <Segmented label="Density" value={look.density} options={DENSITIES} onChange={(density) => updateLook({ density })} />
            </Row>
            <Row label="Line spacing" desc="In the chat.">
              <Segmented label="Line spacing" value={look.leading} options={LEADINGS} onChange={(leading) => updateLook({ leading })} />
            </Row>
            <Row label="Reading width" desc="How wide the chat column gets.">
              <Segmented label="Reading width" value={look.width} options={WIDTHS} onChange={(width) => updateLook({ width })} />
            </Row>
          </Card>
        </Disclosure>

        <Disclosure
          id="look.chat"
          title="Chat and code"
          summary={`${nameOf(CHAT_STYLES, look.chatStyle)} · ${nameOf(CODE_THEMES, look.codeTheme)} code blocks`}
        >
          <Card>
            <Row label="Chat style" desc="How your messages look.">
              <Segmented
                label="Chat style"
                value={look.chatStyle}
                options={CHAT_STYLES}
                onChange={(chatStyle) => updateLook({ chatStyle })}
              />
            </Row>
            {look.chatStyle !== "transcript" && (
              <Row label="Your messages sit on the">
                <Segmented label="Message side" value={look.chatSide} options={CHAT_SIDES} onChange={(chatSide) => updateLook({ chatSide })} />
              </Row>
            )}
            <Row label="Code blocks" desc="Theme follows your colors; the others stay the same in every theme.">
              <Segmented label="Code blocks" value={look.codeTheme} options={CODE_THEMES} onChange={(codeTheme) => updateLook({ codeTheme })} />
            </Row>
          </Card>
        </Disclosure>

        <Disclosure id="look.css" title="Custom CSS" summary={look.customCss.trim() ? "On" : "Off"}>
          <p className="mb-2 text-[12px] leading-relaxed text-ink-3">
            For tinkerers: your own CSS on top of everything else, using the same color variables as the themes
            (like <code className="font-mono">--color-accent</code>). Anything that would load from the internet
            (url(), @import) is left out. Your own CSS stays out of shared Looks.
          </p>
          <textarea
            value={cssDraft}
            onChange={(e) => setCssDraft(e.target.value.slice(0, CSS_MAX))}
            rows={6}
            spellCheck={false}
            placeholder={".md h2 {\n  color: var(--color-accent);\n}"}
            aria-label="Custom CSS"
            className="w-full resize-y rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent/70 focus:ring-3 focus:ring-accent/15"
          />
          <div className="mt-2 flex justify-end gap-2">
            {look.customCss && (
              <button
                onClick={() => {
                  setCssDraft("");
                  updateLook({ customCss: "" });
                }}
                className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-3 hover:bg-hover hover:text-ink"
              >
                Remove
              </button>
            )}
            <button
              onClick={() => updateLook({ customCss: cssDraft })}
              disabled={cssDraft === look.customCss}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        </Disclosure>
      </div>

      {/* App icon */}
      <SectionTitle title="App icon" desc={iconWhere} />
      <div className="mb-6 grid grid-cols-5 gap-2 sm:grid-cols-9">
        {APP_ICONS.map((v) => {
          const active = settings.appIcon === v.id;
          return (
            <button
              key={v.id}
              onClick={() => {
                patch({ appIcon: v.id });
                void chooseAppIcon(v.id);
              }}
              title={v.name}
              aria-label={`${v.name} app icon`}
              aria-pressed={active}
              className={`relative flex flex-col items-center gap-1 rounded-xl border p-1.5 transition-all ${
                active ? "border-accent shadow-sm" : "border-transparent hover:border-edge"
              }`}
            >
              <img src={iconDataUrl(v.id)} alt="" className="h-12 w-12" draggable={false} />
              <span className={`w-full truncate text-center text-[10.5px] ${active ? "font-semibold" : "text-ink-2"}`}>
                {v.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Accessibility */}
      <SectionTitle title="Accessibility" />
      <Card>
        <Row label="High contrast" desc="Darker secondary text and stronger borders, in any theme.">
          <Toggle label="High contrast" checked={look.contrast} onChange={(contrast) => updateLook({ contrast })} />
        </Row>
        <Row label="Strong focus rings" desc="A bold outline on whatever the keyboard is on.">
          <Toggle label="Strong focus rings" checked={look.focusRings} onChange={(focusRings) => updateLook({ focusRings })} />
        </Row>
        <Row label="Reduce motion" desc="No animations, even if your system allows them. Moving backgrounds hold still.">
          <Toggle label="Reduce motion" checked={look.reduceMotion} onChange={(reduceMotion) => updateLook({ reduceMotion })} />
        </Row>
      </Card>

      {/* Display behaviors */}
      <SectionTitle title="Display" />
      <Card>
        <Row label="Smooth scrolling">
          <Toggle
            label="Smooth scrolling"
            checked={settings.smoothScroll}
            onChange={(on) => {
              patch({ smoothScroll: on });
              setSmoothScroll(on);
            }}
          />
        </Row>
        <Row
          label="Animate backgrounds"
          desc="GIF and video chat backgrounds play on a loop. Off, they stay on their first frame. Only for this device; they also stop when your system asks for reduced motion."
        >
          <Toggle
            label="Animate backgrounds"
            checked={settings.animateBackgrounds}
            onChange={(on) => patch({ animateBackgrounds: on })}
          />
        </Row>
        <Row
          label="Response details"
          desc="Token counts and cost under each AI reply and at the foot of each Studio output. /details in chat toggles this too."
        >
          <Toggle label="Response details" checked={settings.showDetails} onChange={(on) => patch({ showDetails: on })} />
        </Row>
        <Row
          label="Open reasoning"
          desc="Reasoning models' thinking sits folded above each reply; on, it starts open. /thinking show and /thinking hide in chat switch this too."
        >
          <Toggle label="Open reasoning" checked={settings.showReasoning} onChange={(on) => patch({ showReasoning: on })} />
        </Row>
      </Card>

      {saving && <SaveLookDialog onSave={saveLook} onClose={() => setSaving(false)} />}
      {importing && <ImportLookDialog onImport={importLook} onClose={() => setImporting(false)} />}
    </div>
  );
}
