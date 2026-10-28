import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { AUTO_OUTPUT_TOKENS, supportsTemperature } from "../../lib/llm";
import { budgetForContext, isEmbeddingModel, listLocalModels, normalizeBaseUrl } from "../../lib/local";
import {
  DEFAULT_IMAGE_MODEL,
  defaultModelFor,
  LOCAL_CONTEXT_OPTIONS,
  LOCAL_PRESETS,
  MAX_OUTPUT_OPTIONS,
  THINKING_LABELS,
  loadImageModelList,
  loadModelList,
  loadResearchModelList,
  PROVIDER_LABELS,
  saveImageModelList,
  saveModelList,
  saveResearchModelList,
} from "../../lib/settings";
import type { Provider, Settings, Thinking } from "../../lib/types";
import { Spinner } from "../ui";
import { Card, Footnote, ModelIdInput, Row, SavedModelList, SectionTitle, Slider, Toggle } from "./controls";
import { platform } from "../../platform";

const KEY_FIELD: Record<Provider, keyof Settings> = {
  openrouter: "openrouterKey",
  openai: "openaiKey",
  anthropic: "anthropicKey",
  local: "localKey",
};

const KEY_LINKS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  local: "",
};

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; models: string[] }
  | { state: "error"; message: string };

/** Server address, presets, optional key and a connection test for the Local provider. */
function LocalServerRows({
  settings,
  patch,
  onModels,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  onModels: (models: string[]) => void;
}) {
  const [conn, setConn] = useState<Connection>({ state: "idle" });
  const activePreset = LOCAL_PRESETS.find((p) => p.url === settings.localBaseUrl)?.id ?? "custom";

  const test = async (baseUrl = settings.localBaseUrl, key = settings.localKey) => {
    setConn({ state: "testing" });
    try {
      const models = await listLocalModels({ baseUrl, key });
      setConn({ state: "ok", models });
      onModels(models);
      // First connection: pick sensible defaults so chat works right away.
      const chat = models.filter((m) => !isEmbeddingModel(m));
      const next: Partial<Settings> = {};
      if (!settings.model.trim() || !models.includes(settings.model)) next.model = chat[0] ?? "";
      if (!settings.localEmbedModel) next.localEmbedModel = models.find(isEmbeddingModel) ?? "";
      if (Object.keys(next).length) patch(next);
    } catch (e) {
      setConn({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Check the saved server once when the section opens.
  useEffect(() => {
    if (settings.localBaseUrl) void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Row label="Server" desc="Any app that serves an OpenAI-compatible API on your computer or network.">
        <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
          {LOCAL_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                patch({ localBaseUrl: p.url });
                void test(p.url);
              }}
              className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                activePreset === p.id ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {p.label}
            </button>
          ))}
          <span
            className={`rounded-md px-2 py-1.5 text-center text-[12.5px] font-medium ${
              activePreset === "custom" ? "bg-panel text-ink shadow-sm" : "text-ink-3"
            }`}
          >
            Custom
          </span>
        </div>
      </Row>
      <Row label="Address" alignTop>
        <div className="w-72">
          <input
            value={settings.localBaseUrl}
            onChange={(e) => patch({ localBaseUrl: e.target.value })}
            onBlur={(e) => {
              const url = normalizeBaseUrl(e.target.value);
              if (url !== e.target.value) patch({ localBaseUrl: url });
            }}
            placeholder="http://localhost:11434/v1"
            className={inputClass}
          />
        </div>
      </Row>
      <Row label="API key" desc="Optional. Only needed if your server asks for one." alignTop>
        <div className="w-72">
          <input
            type="password"
            value={settings.localKey}
            onChange={(e) => patch({ localKey: e.target.value })}
            placeholder="none"
            className={inputClass}
          />
        </div>
      </Row>
      <Row label="Connection" alignTop>
        <div className="flex w-72 flex-col items-end gap-1.5">
          <button
            onClick={() => void test()}
            disabled={!settings.localBaseUrl.trim() || conn.state === "testing"}
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-40"
          >
            {conn.state === "testing" ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Test connection
          </button>
          {conn.state === "ok" && (
            <p className="text-right text-[12px] text-ok">
              Connected. {conn.models.length === 0 ? "No models found. Download one in your server app." : `${conn.models.length} ${conn.models.length === 1 ? "model" : "models"} available.`}
            </p>
          )}
          {conn.state === "error" && <p className="text-right text-[12px] leading-relaxed text-danger">{conn.message}</p>}
        </div>
      </Row>
    </>
  );
}

export default function AiModelSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const provider = settings.provider;
  const isLocal = provider === "local";
  const [modelList, setModelList] = useState<string[]>([]);
  /** Everything the local server reports, embedding models included. */
  const [served, setServed] = useState<string[]>([]);
  const [listVersion, setListVersion] = useState(0);

  // (Re)load the editable chip list whenever the provider (or local server) changes.
  useEffect(() => {
    let cancelled = false;
    loadModelList(provider).then((list) => {
      if (!cancelled) setModelList(list);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, listVersion]);

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

  const [imageList, setImageList] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadImageModelList().then((list) => {
      if (!cancelled) setImageList(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Save the typed image model id to the list (Enter or Add). */
  const addImageModel = () => {
    const m = settings.imageModel.trim();
    if (!m || imageList.includes(m)) return;
    const next = [...imageList, m];
    setImageList(next);
    saveImageModelList(next);
  };

  const removeImageModel = (m: string) => {
    const next = imageList.filter((x) => x !== m);
    setImageList(next);
    saveImageModelList(next);
    if (settings.imageModel === m) patch({ imageModel: next[0] ?? DEFAULT_IMAGE_MODEL });
  };

  /* Research model: per provider; unset = the main model. */
  const researchModel = settings.researchModels[provider] ?? "";
  const setResearchModel = (id: string) =>
    patch({ researchModels: { ...settings.researchModels, [provider]: id } });
  const [researchList, setResearchList] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadResearchModelList(provider).then((list) => {
      if (!cancelled) setResearchList(list);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const addResearchModel = () => {
    const m = researchModel.trim();
    if (!m || researchList.includes(m)) return;
    const next = [...researchList, m];
    setResearchList(next);
    saveResearchModelList(provider, next);
  };

  const removeResearchModel = (m: string) => {
    const next = researchList.filter((x) => x !== m);
    setResearchList(next);
    saveResearchModelList(provider, next);
    if (researchModel === m) setResearchModel("");
  };

  const temp = settings.temperature;

  return (
    <div>
      <SectionTitle title="AI Model" desc="Provider, key, and the model everything runs on." />

      {/* Provider + key + model */}
      <Card>
        <Row label="Provider">
          <div
            className={`grid gap-1 rounded-lg border border-edge bg-canvas p-1 ${
              platform.kind === "desktop" ? "grid-cols-4" : "grid-cols-3"
            }`}
          >
            {(Object.keys(PROVIDER_LABELS) as Provider[])
              // Local models run on the computer: the web app can't reach them.
              .filter((p) => p !== "local" || platform.kind === "desktop")
              .map((p) => (
                <button
                  key={p}
                  onClick={() =>
                    // Reset to the provider default — model ids are
                    // provider-namespaced, so another provider's id is invalid.
                    patch(
                      p === "local"
                        ? { provider: p, model: "", localBaseUrl: settings.localBaseUrl || LOCAL_PRESETS[0].url }
                        : { provider: p, model: defaultModelFor(p) }
                    )
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
        {isLocal ? (
          <LocalServerRows
            key="local"
            settings={settings}
            patch={patch}
            onModels={(models) => {
              setServed(models);
              setListVersion((v) => v + 1);
            }}
          />
        ) : (
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
        )}
      </Card>

      {/* Local: how much the model can read at once, and how passages are found. */}
      {isLocal && (
        <>
          <Card>
            <Row
              label="Context window"
              desc={`How much text the model can read at once. Match your server's setting. BrewLM will send up to about ${Math.round(budgetForContext(settings.localContext).sources / 1000)}k characters of your sources per question.`}
              alignTop
            >
              <div className="grid grid-cols-5 gap-1 rounded-lg border border-edge bg-canvas p-1">
                {LOCAL_CONTEXT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => patch({ localContext: n })}
                    className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                      settings.localContext === n ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                    }`}
                  >
                    {n >= 1024 ? `${Math.round(n / 1024)}K` : n}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              label="Embedding model"
              desc="Finds the passages most related to your question. Leave empty to use keyword search instead."
              alignTop
            >
              <div className="w-72">
                <input
                  list="local-embed-models"
                  value={settings.localEmbedModel}
                  onChange={(e) => patch({ localEmbedModel: e.target.value })}
                  placeholder="e.g. nomic-embed-text"
                  className={inputClass}
                />
                <datalist id="local-embed-models">
                  {served.filter(isEmbeddingModel).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </Row>
          </Card>
          <Footnote>
            Everything stays on your computer with a local model. Ollama starts with a small context
            window; raise it with the <code>OLLAMA_CONTEXT_LENGTH</code> setting, then pick the same
            size here. Web search, deep research and <code>/image</code> still need a cloud provider.
          </Footnote>
        </>
      )}

      {/* Model: type any id to use it instantly; save favorites to the list. */}
      <Card>
        <Row
          label="Model"
          desc={
            isLocal
              ? "Models from your server appear below. Type an id if one is missing."
              : "The model everything runs on — type any id, or pick a saved one below."
          }
        >
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
              placeholder={isLocal ? "e.g. llama3.1:8b" : "model id"}
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
        <SavedModelList
          title="Saved models"
          models={modelList}
          active={settings.model}
          onPick={(m) => patch({ model: m })}
          onRemove={removeModel}
        />
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

      {/* Thinking effort + output limit */}
      <Card>
        {!isLocal && (
          <Row
            label="Thinking effort"
            desc="How long reasoning models think before answering. Lower is faster and cheaper, and leaves more room for long outputs. Auto uses each model's default; models that don't think ignore it."
            alignTop
          >
            <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
              {(Object.keys(THINKING_LABELS) as Thinking[]).map((t) => (
                <button
                  key={t}
                  onClick={() => patch({ thinking: t })}
                  className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                    settings.thinking === t ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {THINKING_LABELS[t]}
                </button>
              ))}
            </div>
          </Row>
        )}
        <Row
          label="Custom output limit"
          desc={
            isLocal
              ? "The most a reply can be. Off sizes it to your context window."
              : `The most a reply can be, thinking included. Off uses up to ${AUTO_OUTPUT_TOKENS / 1000}K tokens, within what each model allows. You only pay for what's written.`
          }
        >
          <Toggle
            label="Custom output limit"
            checked={settings.maxOutput != null}
            onChange={(on) => patch({ maxOutput: on ? 16384 : null })}
          />
        </Row>
        {settings.maxOutput != null && (
          <Row label="Limit" desc="Lowered automatically when a model allows less.">
            <div className="flex items-center gap-3">
              <Slider
                label="Output limit"
                min={0}
                max={MAX_OUTPUT_OPTIONS.length - 1}
                step={1}
                value={Math.max(0, MAX_OUTPUT_OPTIONS.indexOf(settings.maxOutput))}
                onChange={(i) => patch({ maxOutput: MAX_OUTPUT_OPTIONS[i] })}
              />
              <span className="w-10 text-right font-mono text-[12px] text-ink-2">{settings.maxOutput / 1024}K</span>
            </div>
          </Row>
        )}
      </Card>

      {/* Image generation (/image) */}
      <Card>
        <div className="py-3">
          <div className="text-[13px] font-medium text-ink">Image model</div>
          <div className="mt-0.5 mb-2.5 text-[12px] leading-relaxed text-ink-3">
            Used by <code>/image</code>. It runs separately from your chat model and gets only your
            prompt — no sources or chat history — so each picture costs just the image. If your
            selected chat model is itself an image model, that one is used instead. Needs an
            OpenRouter key. Type any image model id, or pick a saved one below.
          </div>
          <ModelIdInput
            value={settings.imageModel}
            onChange={(v) => patch({ imageModel: v })}
            onBlur={(v) => !v.trim() && patch({ imageModel: DEFAULT_IMAGE_MODEL })}
            onAdd={addImageModel}
            canAdd={!!settings.imageModel.trim() && !imageList.includes(settings.imageModel.trim())}
            placeholder={DEFAULT_IMAGE_MODEL}
            addTitle="Save to your image model list"
          />
          {!settings.openrouterKey && (
            <p className="mt-2 text-[12px] text-ink-3">
              No OpenRouter key yet — select OpenRouter above to add one (you can switch your chat
              provider back afterwards; keys are kept separately).
            </p>
          )}
        </div>
        <SavedModelList
          title="Saved image models"
          models={imageList}
          active={settings.imageModel}
          onPick={(m) => patch({ imageModel: m })}
          onRemove={removeImageModel}
        />
      </Card>

      {/* Research model (/research, /search) — web search needs a cloud provider. */}
      {!isLocal && (
        <Card>
          <div className="py-3">
            <div className="text-[13px] font-medium text-ink">Research model</div>
            <div className="mt-0.5 mb-2.5 text-[12px] leading-relaxed text-ink-3">
              Used by Deep Research and <code>/search</code>. A research run reads many pages and
              writes a long report, so you may want a stronger (or cheaper) model here than for chat.
              Leave it on “Same as main model” to use your main model.
              {provider === "openai" && (
                <> On OpenAI the web search itself always runs on gpt-4o-mini-search-preview; this model plans and writes the report.</>
              )}
            </div>
            <ModelIdInput
              value={researchModel}
              onChange={setResearchModel}
              onAdd={addResearchModel}
              canAdd={!!researchModel.trim() && !researchList.includes(researchModel.trim())}
              placeholder={`Same as main model (${settings.model || "not set"})`}
              addTitle="Save to your research model list"
            />
          </div>
          <SavedModelList
            title="Saved research models"
            models={researchList}
            active={researchModel}
            onPick={setResearchModel}
            onRemove={removeResearchModel}
            fallback={{
              label: `Same as main model · ${settings.model || "not set"}`,
              active: !researchModel.trim(),
              onPick: () => setResearchModel(""),
            }}
          />
        </Card>
      )}
    </div>
  );
}
