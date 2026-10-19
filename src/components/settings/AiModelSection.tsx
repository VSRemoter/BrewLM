import { Check, ExternalLink, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { supportsTemperature } from "../../lib/llm";
import {
  DEFAULT_IMAGE_MODEL,
  defaultModelFor,
  IMAGE_MODEL_PRESETS,
  loadModelList,
  PROVIDER_LABELS,
  saveModelList,
} from "../../lib/settings";
import type { Provider, Settings } from "../../lib/types";
import { Card, Footnote, Row, SectionTitle, Slider, Toggle } from "./controls";

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

export default function AiModelSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const provider = settings.provider;
  const [modelList, setModelList] = useState<string[]>([]);

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

  const keyField = KEY_FIELD[provider];

  /** Add the typed model id to the chip list (Enter in the Model field). */
  const addModel = () => {
    const m = settings.model.trim();
    if (!m || modelList.includes(m)) return;
    const next = [...modelList, m];
    setModelList(next);
    saveModelList(provider, next);
  };

  const removeModel = (m: string) => {
    const next = modelList.filter((x) => x !== m);
    setModelList(next);
    saveModelList(provider, next);
    // If the removed chip was the active model, fall back sensibly.
    if (settings.model === m) {
      patch({ model: next[0] ?? defaultModelFor(provider) });
    }
  };

  const temp = settings.temperature;

  return (
    <div>
      <SectionTitle title="AI Model" desc="Provider, key, and the model everything runs on." />

      {/* Provider + key + model */}
      <Card>
        <Row label="Provider">
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
              <button
                key={p}
                onClick={() =>
                  // Reset to the provider default — model ids are
                  // provider-namespaced, so another provider's id is invalid.
                  patch({ provider: p, model: defaultModelFor(p) })
                }
                className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                  provider === p ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </Row>
        <Row label={`${PROVIDER_LABELS[provider]} API key`} alignTop>
          <div className="w-72">
            <input
              type="password"
              value={settings[keyField] as string}
              onChange={(e) => patch({ [keyField]: e.target.value } as Partial<Settings>)}
              placeholder={
                provider === "openrouter" ? "sk-or-v1-…" : provider === "openai" ? "sk-proj-…" : "sk-ant-…"
              }
              className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
            />
            <a
              href={KEY_LINKS[provider]}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 flex items-center justify-end gap-1 text-[12px] text-link hover:underline"
            >
              Get a key <ExternalLink size={11} />
            </a>
          </div>
        </Row>
      </Card>

      {/* Model: type any id to use it instantly; save favorites to the list. */}
      <Card>
        <Row label="Model" desc="The model everything runs on — type any id, or pick a saved one below.">
          <div className="flex w-72 gap-1.5">
            <input
              value={settings.model}
              onChange={(e) => patch({ model: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
              placeholder="model id"
              className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
            />
            <button
              onClick={addModel}
              disabled={!settings.model.trim() || modelList.includes(settings.model.trim())}
              title="Save to your model list"
              className="flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40"
            >
              <Plus size={12} strokeWidth={2.5} />
              Add
            </button>
          </div>
        </Row>
        {modelList.length > 0 && (
          <div className="py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                Saved models
              </span>
              <span className="text-[11px] text-ink-3">{modelList.length}</span>
            </div>
            <div className="max-h-56 divide-y divide-edge-soft overflow-y-auto rounded-lg border border-edge">
              {modelList.map((m) => {
                const active = settings.model === m;
                return (
                  <div
                    key={m}
                    role="button"
                    tabIndex={0}
                    onClick={() => patch({ model: m })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        patch({ model: m });
                      }
                    }}
                    title={m}
                    className={`group flex cursor-pointer items-center gap-2 px-2.5 py-2 transition-colors ${
                      active ? "bg-hover" : "hover:bg-hover"
                    }`}
                  >
                    <Check
                      size={13}
                      strokeWidth={2.5}
                      className={`shrink-0 ${active ? "text-ink" : "text-transparent"}`}
                    />
                    <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${active ? "text-ink" : "text-ink-2"}`}>
                      {m}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeModel(m);
                      }}
                      aria-label={`Remove ${m}`}
                      title="Remove"
                      className="shrink-0 rounded-full p-1 text-ink-3 opacity-0 transition-opacity hover:bg-panel hover:text-ink group-hover:opacity-100"
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {/* Temperature */}
      <Card>
        <Row
          label="Custom temperature"
          desc="Sampling creativity for chat and Studio generations. Off uses each provider's default — nothing is sent."
        >
          <Toggle
            label="Custom temperature"
            checked={temp != null}
            onChange={(on) => patch({ temperature: on ? 0.7 : null })}
          />
        </Row>
        {temp != null && (
          <Row label="Creativity" desc="0 = precise and deterministic · 1 = creative and varied">
            <div className="flex items-center gap-3">
              <Slider
                label="Temperature"
                min={0}
                max={1}
                step={0.05}
                value={temp}
                onChange={(v) => patch({ temperature: v })}
              />
              <span className="w-9 text-right font-mono text-[12px] text-ink-2">{temp.toFixed(2)}</span>
            </div>
          </Row>
        )}
      </Card>
      {temp != null && !supportsTemperature(settings.model) && (
        <Footnote>
          “{settings.model}” is a reasoning model and ignores temperature — the setting stays saved
          for your other models.
        </Footnote>
      )}

      {/* Image generation (/image) */}
      <Card>
        <div className="py-3">
          <div className="text-[13px] font-medium text-ink">Image model</div>
          <div className="mt-0.5 mb-2.5 text-[12px] leading-relaxed text-ink-3">
            Used by <code>/image</code>. It runs separately from your chat model and gets only your
            prompt — no sources or chat history — so each picture costs just the image. If your
            selected chat model is itself an image model, that one is used instead. Needs an
            OpenRouter key.
          </div>
          <input
            list="image-models"
            value={settings.imageModel}
            onChange={(e) => patch({ imageModel: e.target.value })}
            onBlur={(e) => !e.target.value.trim() && patch({ imageModel: DEFAULT_IMAGE_MODEL })}
            placeholder={DEFAULT_IMAGE_MODEL}
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3"
          />
          <datalist id="image-models">
            {IMAGE_MODEL_PRESETS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {!settings.openrouterKey && (
            <p className="mt-2 text-[12px] text-ink-3">
              No OpenRouter key yet — select OpenRouter above to add one (you can switch your chat
              provider back afterwards; keys are kept separately).
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
