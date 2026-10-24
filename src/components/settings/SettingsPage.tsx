import {
  AudioLines,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Database,
  Info,
  Palette,
  RefreshCw,
  Smartphone,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { loadSettings, patchSettings } from "../../lib/settings";
import type { Settings } from "../../lib/types";
import type { UpdateInfo } from "../../lib/updates";
import { platform } from "../../platform";
import { usePhone } from "../../lib/usePhone";
import PairPhonePanel from "../PairPhonePanel";
import AboutSection from "./AboutSection";
import AiModelSection from "./AiModelSection";
import AppearanceSection from "./AppearanceSection";
import AudioSection from "./AudioSection";
import DataSection from "./DataSection";
import StudioSection from "./StudioSection";
import SyncSection, { useSyncStatus } from "./SyncSection";
import UsageSection from "./UsageSection";

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "ai", label: "AI Model", icon: Sparkles },
  { id: "studio", label: "Studio Defaults", icon: Wand2 },
  { id: "audio", label: "Audio Voices", icon: AudioLines },
  { id: "usage", label: "Usage & Cost", icon: BarChart3 },
  { id: "data", label: "Data & Storage", icon: Database },
  { id: "phone", label: "Phone Pairing", icon: Smartphone },
  { id: "sync", label: "Sync", icon: RefreshCw },
  { id: "about", label: "About & Updates", icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Full-page settings: sidebar sections + instant-apply controls. Rendered as a
 * layer over the current view so Home/Notebook state survives a settings trip.
 */
export default function SettingsPage({
  updateInfo,
  onClose,
}: {
  updateInfo: UpdateInfo | null;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [section, setSection] = useState<SectionId>("appearance");
  // Phones show the section list and one section at a time, not side by side.
  const phone = usePhone();
  const [listOpen, setListOpen] = useState(true);
  const showList = !phone || listOpen;
  const showSection = !phone || !listOpen;
  // Sync appears only in builds with a sync server configured (dev, for now).
  const syncAvailable = useSyncStatus().state !== "off";

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  /** Instant-apply: update local state immediately, persist only the changed keys. */
  const patch = (p: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    void patchSettings(p);
  };

  return (
    <div className="anim-fade fixed inset-0 z-50 flex flex-col bg-canvas text-ink">
      {/* Header */}
      <header className="safe-top flex shrink-0 items-center gap-3 border-b border-edge-soft px-4 py-3">
        <button
          onClick={phone && !listOpen ? () => setListOpen(true) : onClose}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <ChevronLeft size={15} strokeWidth={2} /> Back
        </button>
        <h1 className="text-[15px] font-semibold tracking-tight">
          {phone && !listOpen ? SECTIONS.find((s) => s.id === section)?.label : "Settings"}
        </h1>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Section nav */}
        {showList && (
          <nav
            className={`space-y-0.5 overflow-y-auto p-3 ${
              phone ? "safe-bottom flex-1" : "w-52 shrink-0 border-r border-edge-soft"
            }`}
          >
            {SECTIONS.filter(
              // Phone Pairing serves the library from this computer: desktop only.
              (s) => (s.id !== "sync" || syncAvailable) && (s.id !== "phone" || platform.kind === "desktop")
            ).map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setSection(s.id);
                    setListOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 text-left transition-colors ${
                    phone
                      ? "py-3 text-[15px] font-medium text-ink-2"
                      : active
                        ? "bg-hover py-2 text-[13px] font-semibold text-ink"
                        : "py-2 text-[13px] font-medium text-ink-3 hover:bg-hover-soft hover:text-ink-2"
                  }`}
                >
                  <Icon size={phone ? 18 : 15} strokeWidth={1.8} className="shrink-0" />
                  <span className="flex-1">{s.label}</span>
                  {phone && <ChevronRight size={16} className="text-ink-3" />}
                </button>
              );
            })}
          </nav>
        )}

        {/* Content */}
        {showSection && (
          <main className="safe-bottom min-w-0 flex-1 overflow-y-auto">
            {settings ? (
              <div key={section} className="anim-screen mx-auto max-w-4xl px-4 py-5 md:px-6 md:py-6">
                {section === "appearance" && <AppearanceSection settings={settings} patch={patch} />}
                {section === "ai" && <AiModelSection settings={settings} patch={patch} />}
                {section === "studio" && <StudioSection settings={settings} patch={patch} />}
                {section === "audio" && <AudioSection settings={settings} patch={patch} />}
                {section === "usage" && <UsageSection />}
                {section === "data" && <DataSection settings={settings} patch={patch} />}
                {section === "phone" && (
                  <div>
                    <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-ink">
                      Phone Pairing
                    </h2>
                    <div className="rounded-2xl border border-edge bg-panel px-4 py-3">
                      <PairPhonePanel />
                    </div>
                  </div>
                )}
                {section === "sync" && <SyncSection />}
                {section === "about" && (
                  <AboutSection settings={settings} patch={patch} updateInfo={updateInfo} />
                )}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
