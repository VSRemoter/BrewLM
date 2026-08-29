import { ExternalLink } from "lucide-react";
import {
  ELEVENLABS_VOICE_PRESETS,
  OPENAI_TTS_VOICES,
  OPENROUTER_TTS_VOICES,
  TTS_MODEL_PRESETS,
  TTS_PROVIDER_LABELS,
} from "../../lib/settings";
import type { Settings, TtsProvider } from "../../lib/types";
import { Card, SectionTitle } from "./controls";

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

function KeyRow({
  label,
  link,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  link: string;
  value: string;
  placeholder: string;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[12.5px] font-medium text-ink-2">{label}</label>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[12px] text-link hover:underline"
        >
          Get a key <ExternalLink size={11} />
        </a>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      {hint && <p className="mt-1.5 text-[11.5px] text-ink-3">{hint}</p>}
    </div>
  );
}

export default function AudioSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  return (
    <div>
      <SectionTitle
        title="Audio Voices"
        desc="Who narrates Audio overviews — independent of the chat provider."
      />

      <Card>
        <div className="py-3">
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {(Object.keys(TTS_PROVIDER_LABELS) as TtsProvider[]).map((p) => (
              <button
                key={p}
                onClick={() => patch({ ttsProvider: p })}
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
              <KeyRow
                label="OpenAI TTS API key"
                link="https://platform.openai.com/api-keys"
                value={settings.openaiTtsKey}
                placeholder="sk-proj-…"
                hint="Leave empty to reuse your OpenAI chat key."
                onChange={(v) => patch({ openaiTtsKey: v })}
              />
              <VoiceField
                label="TTS model"
                listId="tts-models-openai"
                listValues={TTS_MODEL_PRESETS.openai}
                value={settings.ttsModel}
                placeholder="gpt-4o-mini-tts"
                onChange={(v) => patch({ ttsModel: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice (host)"
                  listId="voices-openai"
                  listValues={OPENAI_TTS_VOICES}
                  value={settings.ttsVoiceAlex}
                  placeholder="nova"
                  onChange={(v) => patch({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice (co-host)"
                  listId="voices-openai"
                  listValues={OPENAI_TTS_VOICES}
                  value={settings.ttsVoiceSam}
                  placeholder="onyx"
                  onChange={(v) => patch({ ttsVoiceSam: v })}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                  How should the hosts sound?
                </label>
                <textarea
                  value={settings.ttsInstructions}
                  onChange={(e) => patch({ ttsInstructions: e.target.value })}
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
              <KeyRow
                label="OpenRouter TTS API key"
                link="https://openrouter.ai/keys"
                value={settings.openrouterTtsKey}
                placeholder="sk-or-v1-…"
                hint="Leave empty to reuse your OpenRouter chat key. The model must support audio output — OpenRouter only routes OpenAI's gpt-audio models for that."
                onChange={(v) => patch({ openrouterTtsKey: v })}
              />
              <VoiceField
                label="TTS model"
                listId="tts-models-openrouter"
                listValues={TTS_MODEL_PRESETS.openrouter}
                value={settings.ttsModel}
                placeholder="openai/gpt-audio-mini"
                onChange={(v) => patch({ ttsModel: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice (host)"
                  listId="voices-openrouter"
                  listValues={OPENROUTER_TTS_VOICES}
                  value={settings.ttsVoiceAlex}
                  placeholder="nova"
                  onChange={(v) => patch({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice (co-host)"
                  listId="voices-openrouter"
                  listValues={OPENROUTER_TTS_VOICES}
                  value={settings.ttsVoiceSam}
                  placeholder="onyx"
                  onChange={(v) => patch({ ttsVoiceSam: v })}
                />
              </div>
            </div>
          )}

          {settings.ttsProvider === "elevenlabs" && (
            <div className="mt-3.5 flex flex-col gap-3.5">
              <KeyRow
                label="ElevenLabs API key"
                link="https://elevenlabs.io/app/settings/api-keys"
                value={settings.elevenlabsKey}
                placeholder="sk_…"
                onChange={(v) => patch({ elevenlabsKey: v })}
              />
              <VoiceField
                label="TTS model"
                listId="tts-models-elevenlabs"
                listValues={TTS_MODEL_PRESETS.elevenlabs}
                value={settings.ttsModel}
                placeholder="eleven_multilingual_v2"
                onChange={(v) => patch({ ttsModel: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <VoiceField
                  label="Alex's voice ID (host)"
                  listId="voices-elevenlabs"
                  listValues={ELEVENLABS_VOICE_PRESETS.map((v) => v.id)}
                  value={settings.ttsVoiceAlex}
                  placeholder="21m00Tcm4TlvDq8ikWAM"
                  onChange={(v) => patch({ ttsVoiceAlex: v })}
                />
                <VoiceField
                  label="Sam's voice ID (co-host)"
                  listId="voices-elevenlabs"
                  listValues={ELEVENLABS_VOICE_PRESETS.map((v) => v.id)}
                  value={settings.ttsVoiceSam}
                  placeholder="pNInz6obpgDQGcFmaJgB"
                  onChange={(v) => patch({ ttsVoiceSam: v })}
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
      </Card>
    </div>
  );
}
