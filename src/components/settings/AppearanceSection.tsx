import { Check } from "lucide-react";
import { useState } from "react";
import { chooseFont, FONTS } from "../../lib/fonts";
import { chooseTheme, THEMES } from "../../lib/themes";
import { getZoom, setZoom } from "../../lib/zoom";
import type { Settings } from "../../lib/types";
import { Card, Row, SectionTitle, Slider } from "./controls";

export default function AppearanceSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [zoomPct, setZoomPct] = useState(() => Math.round(getZoom() * 100));

  const pickTheme = (id: string) => {
    patch({ theme: id });
    chooseTheme(id); // applies to the DOM immediately and persists
  };

  const pickFont = (id: string) => {
    patch({ font: id });
    chooseFont(id);
  };

  return (
    <div>
      <SectionTitle title="Appearance" />

      {/* Text size — preview the number while dragging, apply on release so
          the UI (slider included) doesn't rescale under the cursor. */}
      <Card>
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
      </Card>

      {/* Theme */}
      <SectionTitle title="Theme" />
      <div className="mb-6 grid grid-cols-4 gap-2">
        {THEMES.map((t) => {
          const active = settings.theme === t.id;
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
                style={{ background: t.swatch.canvas }}
              >
                <span
                  className="absolute left-1.5 top-1.5 h-[calc(100%-12px)] w-[62%] rounded-[5px]"
                  style={{ background: t.swatch.panel }}
                >
                  <span
                    className="absolute left-1.5 right-3 top-1.5 h-[3px] rounded-full"
                    style={{ background: t.swatch.accent }}
                  />
                  <span
                    className="absolute left-1.5 right-5 top-3.5 h-[3px] rounded-full opacity-30"
                    style={{ background: t.swatch.ink }}
                  />
                  <span
                    className="absolute left-1.5 right-4 top-[21px] h-[3px] rounded-full opacity-30"
                    style={{ background: t.swatch.ink }}
                  />
                </span>
                <span
                  className="absolute bottom-1.5 right-1.5 h-4 w-4 rounded-full"
                  style={{ background: t.swatch.accent }}
                />
                {active && (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink">
                    <Check size={10} strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className="px-0.5 pb-0.5">
                <span
                  className={`block text-[11.5px] leading-tight ${active ? "font-semibold" : "font-medium"}`}
                >
                  {t.name}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Font */}
      <SectionTitle title="Font" />
      <div className="grid grid-cols-3 gap-2">
        {FONTS.map((f) => {
          const active = settings.font === f.id;
          return (
            <button
              key={f.id}
              onClick={() => pickFont(f.id)}
              className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all ${
                active ? "border-accent shadow-sm" : "border-edge hover:border-ink-3"
              }`}
            >
              <span className="text-[16px] leading-none" style={{ fontFamily: f.stack }}>
                Ag
              </span>
              <span className={`text-[12px] leading-tight ${active ? "font-semibold" : "font-medium"}`}>
                {f.name}
              </span>
              {active && <Check size={12} strokeWidth={3} className="ml-auto shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
