import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { supportsTemperature } from "../../lib/llm";
import {
  defaultModelFor,
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
        <Row label="Model" alignTop>
          <div className="w-72">
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
                    <button onClick={() => patch({ model: m })} className="outline-none" title={`Use ${m}`}>
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
          </div>
        </Row>
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
    </div>
  );
}
