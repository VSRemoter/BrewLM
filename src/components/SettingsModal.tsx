import { Check, ExternalLink, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ELEVENLABS_VOICE_PRESETS,
  OPENAI_TTS_VOICES,
  OPENROUTER_TTS_VOICES,
  PROVIDER_LABELS,
  TTS_MODEL_PRESETS,
  TTS_PROVIDER_LABELS,
  defaultModelFor,
  loadModelList,
  loadSettings,
  saveModelList,
  saveSettings,
} from "../lib/settings";
import { THEMES, chooseTheme } from "../lib/themes";
import type { Provider, Settings, TtsProvider } from "../lib/types";
import { Modal, PrimaryButton } from "./ui";

const KEY_FIELD: Record<Provider, keyof Settings> = {
  openrouter: "openrouterKey",
  openai: "openaiKey",
  anthropic: "anthropicKey",
};

const KEY_LINKS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
};

/** Text input with autocomplete suggestions (voice names / model ids). */
function VoiceField({
  label,
  listId,
  listValues,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  listId: string;
  listValues: string[];
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</label>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      <datalist id={listId}>
        {listValues.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const provider = settings?.provider ?? "openrouter";

  // (Re)load the editable chip list whenever the provider changes.
  useEffect(() => {
    let cancelled = false;
    loadModelList(provider).then((list) => {
      if (!cancelled) setModelList(list);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (!settings) return null;

  const keyField = KEY_FIELD[settings.provider];

  const pickTheme = (id: string) => {
    setSettings((s) => (s ? { ...s, theme: id } : s));
    chooseTheme(id); // applies to the DOM immediately and persists
  };

  const pick = (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setSaved(false);
  };

  const addModel = () => {
    const m = newModel.trim();
    if (!m || modelList.includes(m)) return;
    const next = [...modelList, m];
    setModelList(next);
    saveModelList(provider, next);
    setNewModel("");
    if (!settings.model) pick({ model: m });
    setSaved(false);
  };

  const removeModel = (m: string) => {
    const next = modelList.filter((x) => x !== m);
    setModelList(next);
    saveModelList(provider, next);
    // If the removed chip was the active model, fall back sensibly.
    if (settings.model === m) {
      pick({ model: next[0] ?? defaultModelFor(provider) });
    } else {
      setSaved(false);
    }
  };

  const save = async () => {
    await saveSettings(settings);
    setSaved(true);
    setTimeout(onClose, 450);
  };

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="flex flex-col gap-5">
        {/* Theme */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label className="text-[12.5px] font-medium text-ink-2">Theme</label>
            <span className="text-[11px] text-ink-3">Applies instantly</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => {
              const active = settings.theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => pickTheme(t.id)}
                  className={`group flex flex-col gap-1.5 rounded-xl border p-1.5 text-left transition-all ${
                    active
                      ? "border-accent shadow-sm"
                      : "border-edge hover:border-ink-3"
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
                    <span className="block truncate text-[10px] leading-tight text-ink-3">
                      {t.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-edge-soft" />

        {/* Provider */}
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Provider</label>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
              <button
                key={p}
                onClick={() =>
                  pick({
                    provider: p,
                    // reset to the provider default — model ids are provider-namespaced,
                    // so a model from another provider is almost never valid here.
                    model: defaultModelFor(p),
                  })
                }
                className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                  settings.provider === p
                    ? "bg-panel text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
          {settings.provider === "openrouter" && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              One key, any model — Claude, GPT, Gemini, Llama, DeepSeek, and more.
            </p>
          )}
        </div>

        {/* API key */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[12.5px] font-medium text-ink-2">
              {PROVIDER_LABELS[settings.provider]} API key
            </label>
            <a
              href={KEY_LINKS[settings.provider]}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[12px] text-link hover:underline"
            >
              Get a key <ExternalLink size={11} />
            </a>
          </div>
          <input
            type="password"
            value={settings[keyField] as string}
            onChange={(e) => pick({ [keyField]: e.target.value } as Partial<Settings>)}
            placeholder={
              settings.provider === "openrouter"
                ? "sk-or-v1-…"
                : settings.provider === "openai"
                  ? "sk-proj-…"
                  : "sk-ant-…"
            }
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
          />
          <p className="mt-1.5 text-[11.5px] text-ink-3">
            Stored locally in the app's own database. Never sent anywhere except to your provider.
          </p>
        </div>

        {/* Model */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label className="text-[12.5px] font-medium text-ink-2">Model</label>
            <span className="text-[11px] text-ink-3">
              Click a chip to use it · × removes · saved per provider
            </span>
          </div>
          <input
            value={settings.model}
            onChange={(e) => pick({ model: e.target.value })}
            placeholder="model id"
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
          />

          {/* Editable chip list */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {modelList.map((m) => {
              const active = settings.model === m;
              return (
                <span
                  key={m}
                  className={`group inline-flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 font-mono text-[11px] transition-colors ${
                    active
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-edge bg-panel text-ink-2 hover:border-ink-3"
                  }`}
                >
                  <button
                    onClick={() => pick({ model: m })}
                    className="outline-none"
                    title={`Use ${m}`}
                  >
                    {m}
                  </button>
                  <button
                    onClick={() => removeModel(m)}
                    aria-label={`Remove ${m}`}
                    title="Remove"
                    className={`rounded-full p-0.5 transition-opacity ${
                      active
                        ? "text-accent-ink/80 hover:bg-white/20 hover:text-accent-ink"
                        : "text-ink-3 opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100"
                    }`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              );
            })}
          </div>

          {/* Add a model */}
          <div className="mt-2 flex gap-1.5">
            <input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
              placeholder={`Add a ${PROVIDER_LABELS[settings.provider]} model id…`}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-1.5 font-mono text-[12px] outline-none placeholder:text-ink-3 focus:border-ink-3"
            />
            <button
              onClick={addModel}
              disabled={!newModel.trim() || modelList.includes(newModel.trim())}
              title="Add model"
              className="flex items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={13} strokeWidth={2.5} /> Add
            </button>
          </div>
        </div>

        <div className="border-t border-edge-soft" />

        {/* Audio voices (TTS) — independent of the chat provider */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label className="text-[12.5px] font-medium text-ink-2">Audio voices</label>
            <span className="text-[11px] text-ink-3">Used by Audio overviews</span>
          </div>
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {(Object.keys(TTS_PROVIDER_LABELS) as TtsProvider[]).map((p) => (
              <button
                key={p}
                onClick={() => pick({ ttsProvider: p })}
                className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                  settings.ttsProvider === p
                    ? "bg-panel text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {TTS_PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>

          {settings.ttsProvider === "system" && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              Free and offline — the audio overview plays with your device's built-in voices, no
              file is produced. Choose OpenAI or ElevenLabs to generate a downloadable mp3.
            </p>
          )}

          {settings.ttsProvider === "openai" && (
            <div className="mt-3.5 flex flex-col gap-3.5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[12.5px] font-medium text-ink-2">OpenAI TTS API key</label>
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[12px] text-link hover:underline"
                  >
                    Get a key <ExternalLink size={11} />
                  </a>
                </div>
                <input
                  type="password"
                  value={settings.openaiTtsKey}
                  onChange={(e) => pick({ openaiTtsKey: e.target.value })}
                  placeholder="sk-proj-…"
                  className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
                />
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Leave empty to reuse your OpenAI chat key from above.
                </p>
              </div>

              <VoiceField
                label="TTS model"
                listId="tts-models-openai"
                listValues={TTS_MODEL_PRESETS.openai}
                value={settings.ttsModel}
                placeholder="gpt-4o-mini-tts"
                onChange={(v) => pick({ ttsModel: v })}
              />

              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice (host)"
                  listId="voices-openai"
                  listValues={OPENAI_TTS_VOICES}
                  value={settings.ttsVoiceAlex}
                  placeholder="nova"
                  onChange={(v) => pick({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice (co-host)"
                  listId="voices-openai"
                  listValues={OPENAI_TTS_VOICES}
                  value={settings.ttsVoiceSam}
                  placeholder="onyx"
                  onChange={(v) => pick({ ttsVoiceSam: v })}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                  How should the hosts sound?
                </label>
                <textarea
                  value={settings.ttsInstructions}
                  onChange={(e) => pick({ ttsInstructions: e.target.value })}
                  placeholder="e.g. Warm and curious podcast hosts; Alex speaks slowly and clearly, Sam is upbeat. Slight pause after questions."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-ink-3 focus:border-ink-3"
                />
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Sent to OpenAI as voice instructions — tone, pacing, accent, emotion.
                </p>
              </div>
            </div>
          )}

          {settings.ttsProvider === "openrouter" && (
            <div className="mt-3.5 flex flex-col gap-3.5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[12.5px] font-medium text-ink-2">OpenRouter TTS API key</label>
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[12px] text-link hover:underline"
                  >
                    Get a key <ExternalLink size={11} />
                  </a>
                </div>
                <input
                  type="password"
                  value={settings.openrouterTtsKey}
                  onChange={(e) => pick({ openrouterTtsKey: e.target.value })}
                  placeholder="sk-or-v1-…"
                  className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
                />
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Leave empty to reuse your OpenRouter chat key from above. The model must support
                  audio output — OpenRouter only routes OpenAI's gpt-audio models for that.
                </p>
              </div>

              <VoiceField
                label="TTS model"
                listId="tts-models-openrouter"
                listValues={TTS_MODEL_PRESETS.openrouter}
                value={settings.ttsModel}
                placeholder="openai/gpt-audio-mini"
                onChange={(v) => pick({ ttsModel: v })}
              />

              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice (host)"
                  listId="voices-openrouter"
                  listValues={OPENROUTER_TTS_VOICES}
                  value={settings.ttsVoiceAlex}
                  placeholder="nova"
                  onChange={(v) => pick({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice (co-host)"
                  listId="voices-openrouter"
                  listValues={OPENROUTER_TTS_VOICES}
                  value={settings.ttsVoiceSam}
                  placeholder="onyx"
                  onChange={(v) => pick({ ttsVoiceSam: v })}
                />
              </div>
            </div>
          )}

          {settings.ttsProvider === "elevenlabs" && (
            <div className="mt-3.5 flex flex-col gap-3.5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[12.5px] font-medium text-ink-2">ElevenLabs API key</label>
                  <a
                    href="https://elevenlabs.io/app/settings/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[12px] text-link hover:underline"
                  >
                    Get a key <ExternalLink size={11} />
                  </a>
                </div>
                <input
                  type="password"
                  value={settings.elevenlabsKey}
                  onChange={(e) => pick({ elevenlabsKey: e.target.value })}
                  placeholder="sk_…"
                  className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
                />
              </div>

              <VoiceField
                label="TTS model"
                listId="tts-models-elevenlabs"
                listValues={TTS_MODEL_PRESETS.elevenlabs}
                value={settings.ttsModel}
                placeholder="eleven_multilingual_v2"
                onChange={(v) => pick({ ttsModel: v })}
              />

              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice ID (host)"
                  listId="voices-elevenlabs"
                  listValues={ELEVENLABS_VOICE_PRESETS.map((v) => v.id)}
                  value={settings.ttsVoiceAlex}
                  placeholder="21m00Tcm4TlvDq8ikWAM"
                  onChange={(v) => pick({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice ID (co-host)"
                  listId="voices-elevenlabs"
                  listValues={ELEVENLABS_VOICE_PRESETS.map((v) => v.id)}
                  value={settings.ttsVoiceSam}
                  placeholder="pNInz6obpgDQGcFmaJgB"
                  onChange={(v) => pick({ ttsVoiceSam: v })}
                />
              </div>
              <p className="text-[11.5px] leading-relaxed text-ink-3">
                Voice IDs from elevenlabs.io/app/voice-lab — premade:{" "}
                {ELEVENLABS_VOICE_PRESETS.map((v) => v.name).join(", ")} (suggestions in the fields
                above).
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {saved && <span className="text-[12px] text-ok">Saved</span>}
          <PrimaryButton onClick={save}>Save settings</PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
