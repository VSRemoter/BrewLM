import { ArrowLeftRight, ExternalLink, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  builtInVoices,
  OPENROUTER_TTS_VOICES,
  DEFAULT_TTS_MODELS,
  findVoice,
  hostVoice,
  loadTtsModelList,
  loadVoiceList,
  saveTtsModelList,
  saveVoiceList,
  TTS_PROVIDER_LABELS,
  voiceLabel,
  type Host,
  type SavedVoice,
  type VoiceProvider,
  voicesNeedIds,
} from "../../lib/settings";
import type { Settings, TtsProvider } from "../../lib/types";
import { Card, ModelIdInput, SavedModelList, SectionTitle } from "./controls";

type SectionProps = {
  provider: VoiceProvider;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
};

const HOST_FIELD: Record<Host, "ttsVoiceAlex" | "ttsVoiceSam"> = { Alex: "ttsVoiceAlex", Sam: "ttsVoiceSam" };
const HOST_LABEL: Record<Host, string> = { Alex: "Host", Sam: "Co-Host" };

/** TTS model box + saved list for one TTS provider ("" = the provider default). */
function TtsModelPicker({ provider, settings, patch }: SectionProps) {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadTtsModelList(provider).then((l) => !cancelled && setList(l));
    return () => {
      cancelled = true;
    };
  }, [provider]);
  const value = settings.ttsModel;
  const active = value.trim() || DEFAULT_TTS_MODELS[provider];
  const add = () => {
    const m = value.trim();
    if (!m || list.includes(m)) return;
    const next = [...list, m];
    setList(next);
    saveTtsModelList(provider, next);
  };
  const remove = (m: string) => {
    const next = list.filter((x) => x !== m);
    setList(next);
    saveTtsModelList(provider, next);
    if (active === m) patch({ ttsModel: next[0] ?? "" });
  };
  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">TTS model</label>
      <ModelIdInput
        value={value}
        onChange={(v) => patch({ ttsModel: v })}
        onAdd={add}
        canAdd={!!value.trim() && !list.includes(value.trim())}
        placeholder={DEFAULT_TTS_MODELS[provider]}
        addTitle="Save to your TTS model list"
      />
      <SavedModelList
        title="Saved TTS models"
        models={list}
        active={active}
        onPick={(m) => patch({ ttsModel: m })}
        onRemove={remove}
      />
    </div>
  );
}

/**
 * Saved voices for one TTS provider: each row toggles Host / Co-host, plus a
 * swap button. ElevenLabs voices are a name + voice ID; OpenAI and OpenRouter
 * only accept their built-in voice names.
 */
function VoiceLibrary({ provider, settings, patch }: SectionProps) {
  const [list, setList] = useState<SavedVoice[]>([]);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadVoiceList(provider).then((l) => !cancelled && setList(l));
    setName("");
    setId("");
    setError(null);
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const builtIn = builtInVoices(provider);
  const needsId = voicesNeedIds(provider);
  /** Autocomplete for the name box: the only valid voices (OpenAI) or gpt-audio's starters (OpenRouter). */
  const suggestions = needsId ? null : (builtIn ?? OPENROUTER_TTS_VOICES);
  const current: Record<Host, string> = { Alex: hostVoice(settings, "Alex"), Sam: hostVoice(settings, "Sam") };
  const assign = (host: Host, voiceId: string) => patch({ [HOST_FIELD[host]]: voiceId });

  const save = (next: SavedVoice[]) => {
    setList(next);
    saveVoiceList(provider, next);
  };

  const add = () => {
    setError(null);
    const n = name.trim();
    if (!n) return;
    if (!needsId) {
      if (/\s/.test(n)) {
        setError("Voice names have no spaces — use the exact value from the model's page, e.g. voice_3150.");
        return;
      }
      const match = builtIn ? builtIn.find((v) => v.toLowerCase() === n.toLowerCase()) : n;
      if (!match) {
        setError(`${TTS_PROVIDER_LABELS[provider]} has no voice “${n}”. Its voices: ${builtIn?.join(", ")}.`);
        return;
      }
      if (findVoice(list, match)) {
        setError(`“${match}” is already in your list.`);
        return;
      }
      save([...list, { name: match, id: match }]);
    } else {
      const v = id.trim();
      if (!v) {
        setError("Paste the voice ID too — find it on the voice's page in ElevenLabs.");
        return;
      }
      if (/\s/.test(v)) {
        setError("Voice IDs have no spaces, e.g. 21m00Tcm4TlvDq8ikWAM.");
        return;
      }
      if (list.some((x) => x.name.toLowerCase() === n.toLowerCase())) {
        setError(`You already have a voice named “${n}”.`);
        return;
      }
      save([...list, { name: n, id: v }]);
    }
    setName("");
    setId("");
  };

  const inputClass =
    "w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[12.5px] font-medium text-ink-2">Voices</label>
        <button
          onClick={() => patch({ ttsVoiceAlex: current.Sam, ttsVoiceSam: current.Alex })}
          title="Swap the Host and Co-Host voices"
          className="flex items-center gap-1 text-[12px] text-ink-3 transition-colors hover:text-ink"
        >
          <ArrowLeftRight size={12} strokeWidth={2} />
          Swap
        </button>
      </div>
      <p className="mb-2 text-[12px] text-ink-3">
        Host: <span className="font-medium text-ink-2">{current.Alex ? voiceLabel(list, current.Alex) : "not set"}</span>
        {" · "}Co-Host: <span className="font-medium text-ink-2">{current.Sam ? voiceLabel(list, current.Sam) : "not set"}</span>
      </p>
      {list.length > 0 && (
        <div className="max-h-56 divide-y divide-edge-soft overflow-y-auto rounded-lg border border-edge">
          {list.map((v) => (
            <div key={`${v.name}:${v.id}`} className="group flex items-center gap-2 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                {v.name}
                {v.id !== v.name && <span className="ml-2 font-mono text-[11px] text-ink-3">{v.id}</span>}
              </span>
              {(Object.keys(HOST_FIELD) as Host[]).map((h) => {
                const on = current[h] === v.id;
                return (
                  <button
                    key={h}
                    onClick={() => assign(h, v.id)}
                    aria-pressed={on}
                    title={on ? `${HOST_LABEL[h]} voice` : `Use for the ${HOST_LABEL[h].toLowerCase()}`}
                    className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      on ? "bg-accent text-accent-ink" : "text-ink-3 hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {HOST_LABEL[h]}
                  </button>
                );
              })}
              <button
                onClick={() => save(list.filter((x) => x !== v))}
                aria-label={`Remove ${v.name}`}
                title="Remove"
                className="shrink-0 rounded-full p-1 text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <input
          list={suggestions ? `voices-${provider}` : undefined}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder={
            builtIn ? "Voice name, e.g. coral" : needsId ? "Name, e.g. Rachel" : "Voice, e.g. nova or voice_3150"
          }
          className={inputClass}
        />
        {suggestions ? (
          <datalist id={`voices-${provider}`}>
            {suggestions
              .filter((b) => !findVoice(list, b))
              .map((b) => (
                <option key={b} value={b} />
              ))}
          </datalist>
        ) : (
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
            placeholder="Voice ID"
            className={`${inputClass} font-mono`}
          />
        )}
        <button
          onClick={add}
          disabled={!name.trim()}
          title="Save to your voices"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2.5} />
          Add
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
      <p className="mt-1.5 text-[11.5px] text-ink-3">
        {builtIn
          ? "Add back any built-in voice you removed. In chat: /voicehost, /voicecohost, /voice swap."
          : needsId
            ? "Voice IDs are on each voice's page at elevenlabs.io. In chat: /voice add <name> <id>, /voicehost, /voicecohost, /voice swap."
            : "Voices depend on the TTS model: gpt-audio uses alloy, nova, onyx…; other models list theirs on their OpenRouter page (Voxtral TTS 3 has voice_3150, for example). In chat: /voicehost <voice>, /voicecohost <voice>, /voice swap."}
      </p>
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
              <TtsModelPicker provider="openai" settings={settings} patch={patch} />
              <VoiceLibrary provider="openai" settings={settings} patch={patch} />
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
                  How should the hosts sound?
                </label>
                <textarea
                  value={settings.ttsInstructions}
                  onChange={(e) => patch({ ttsInstructions: e.target.value })}
                  placeholder="e.g. Warm and curious podcast hosts; the Host speaks slowly and clearly, the Co-Host is upbeat. Slight pause after questions."
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
                hint="Leave empty to reuse your OpenRouter chat key. Any OpenRouter text-to-speech model works (e.g. mistralai/voxtral-mini-tts-3-0), as do OpenAI's gpt-audio models."
                onChange={(v) => patch({ openrouterTtsKey: v })}
              />
              <TtsModelPicker provider="openrouter" settings={settings} patch={patch} />
              <VoiceLibrary provider="openrouter" settings={settings} patch={patch} />
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
              <TtsModelPicker provider="elevenlabs" settings={settings} patch={patch} />
              <VoiceLibrary provider="elevenlabs" settings={settings} patch={patch} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
