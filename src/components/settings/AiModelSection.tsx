import { MAX_TOOL_ROUNDS } from "../../lib/agent";
import { ArrowRight, ExternalLink, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { AUTO_OUTPUT_TOKENS, supportsTemperature } from "../../lib/llm";
import { acceptsAudio, AUTO_TRANSCRIBE_MODEL, transcribeProviders } from "../../lib/media";
import { staysLocal } from "../../lib/featureRoute";
import { AUTO_CONTEXT, budgetForContext, isEmbeddingModel, listLocalModels, normalizeBaseUrl, readServerContext, type ServerContext } from "../../lib/local";
import { goToSettingsSection } from "../../lib/settingsNav";
import {
  DEFAULT_IMAGE_MODEL,
  defaultModelFor,
  LOCAL_CONTEXT_OPTIONS,
  LOCAL_PRESETS,
  MAX_OUTPUT_OPTIONS,
  THINKING_LABELS,
  thinkingLevels,
  loadImageModelList,
  loadModelList,
  loadResearchModelList,
  loadTranscribeModelList,
  PROVIDER_LABELS,
  saveImageModelList,
  saveModelList,
  saveResearchModelList,
  saveTranscribeModelList,
} from "../../lib/settings";
import type { Provider, Settings, Thinking } from "../../lib/types";
import {
  Card,
  Disclosure,
  Footnote,
  GroupLabel,
  ModelIdInput,
  Row,
  SavedModelList,
  SectionTitle,
  Slider,
  Toggle,
} from "./controls";
import { Segmented } from "../ui";
import { LocalServerRows } from "./LocalModelsSection";
import ProviderRoutingCard from "./ProviderRoutingCard";
import WebSearchCard from "./WebSearchCard";
import { BrewLmAiStatusRow, BrewLmTierRow, useAiOffered } from "./BrewLmAi";
import { platform } from "../../platform";

const KEY_FIELD: Record<Provider, keyof Settings> = {
  brewlm: "openrouterKey", // unused: BrewLM AI needs no key
  openrouter: "openrouterKey",
  openai: "openaiKey",
  anthropic: "anthropicKey",
  local: "localKey",
};

const KEY_LINKS: Record<Provider, string> = {
  brewlm: "",
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  local: "",
};

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

/** One provider's transcription pick: a model id box plus its saved list, "Automatic" on top. */
function TranscriptionModelRows({
  provider,
  settings,
  patch,
  showLabel,
}: {
  provider: Provider;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  showLabel: boolean;
}) {
  const model = settings.transcribeModels[provider] ?? "";
  const setModel = (id: string) =>
    patch({ transcribeModels: { ...settings.transcribeModels, [provider]: id } });
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadTranscribeModelList(provider).then((l) => {
      if (!cancelled) setList(l);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Flag an id OpenRouter doesn't list as taking audio, so a bad pick is caught here, not on upload.
  const [audioOk, setAudioOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    acceptsAudio(provider, model).then((ok) => {
      if (!cancelled) setAudioOk(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, model]);

  const add = () => {
    const m = model.trim();
    if (!m || list.includes(m)) return;
    const next = [...list, m];
    setList(next);
    saveTranscribeModelList(provider, next);
  };

  const remove = (m: string) => {
    const next = list.filter((x) => x !== m);
    setList(next);
    saveTranscribeModelList(provider, next);
    if (model === m) setModel("");
  };

  const auto = AUTO_TRANSCRIBE_MODEL[provider] ?? "";
  return (
    <>
      <div className="py-3">
        {showLabel && <div className="mb-1.5 text-[12px] font-medium text-ink-2">{PROVIDER_LABELS[provider]}</div>}
        <ModelIdInput
          value={model}
          onChange={setModel}
          onAdd={add}
          canAdd={!!model.trim() && !list.includes(model.trim())}
          placeholder={`Automatic (${auto})`}
          addTitle="Save to your transcription model list"
        />
        {audioOk === false && (
          <p className="mt-2 text-[12px] leading-relaxed text-warn">
            OpenRouter doesn't list “{model.trim()}” as accepting audio, so recordings will fall back to
            Automatic.
          </p>
        )}
      </div>
      <SavedModelList
        title={`Saved transcription models${showLabel ? ` · ${PROVIDER_LABELS[provider]}` : ""}`}
        models={list}
        active={model}
        onPick={setModel}
        onRemove={remove}
        fallback={{
          label: `Automatic · ${auto}`,
          active: !model.trim(),
          onPick: () => setModel(""),
        }}
      />
    </>
  );
}

/**
 * Speech-to-text model for audio/video sources, for each provider that has a
 * key, in the order they're tried. Empty = Automatic; a pick that fails falls
 * back to it (media.ts).
 */
function TranscriptionModelCard({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  // BrewLM AI transcribes with its own model: nothing to pick.
  const providers = transcribeProviders(settings).filter((p) => p !== "brewlm");
  // Transcription kept on this computer: no cloud model to pick (Settings → Local Models says why).
  if (settings.provider === "brewlm" || staysLocal(settings, "transcribe")) return null;
  return (
    <Card>
      <div className="pt-3">
        <div className="text-[13px] font-medium text-ink">Transcription model</div>
        <div className="mt-0.5 pb-3 text-[12px] leading-relaxed text-ink-3">
          Turns audio and video sources into text the AI can read. It's separate from your chat
          model because most chat models can't hear audio. Type any model id that accepts audio, or
          pick a saved one below. If it fails, Automatic is used instead.
          {providers.length > 1 && ` ${PROVIDER_LABELS[providers[0]]} is tried first; ${PROVIDER_LABELS[providers[1]]} is the backup.`}
          {providers.length === 0 && " Needs an OpenAI or OpenRouter key; Anthropic models can't take audio."}
        </div>
      </div>
      {providers.map((p) => (
        <TranscriptionModelRows key={p} provider={p} settings={settings} patch={patch} showLabel={providers.length > 1} />
      ))}
    </Card>
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
  const isBrewlm = provider === "brewlm";
  // BrewLM AI is listed once the server offers it to this account (or it's already picked).
  const aiOffered = useAiOffered();
  const providers = (Object.keys(PROVIDER_LABELS) as Provider[])
    // Local models run on the computer: the web app can't reach them.
    .filter((p) => p !== "local" || platform.kind === "desktop")
    .filter((p) => p !== "brewlm" || aiOffered || isBrewlm);
  const [modelList, setModelList] = useState<string[]>([]);
  /** Everything the local server reports, embedding models included. */
  const [served, setServed] = useState<string[]>([]);
  /** Models on the separate embedding server, when one is set. */
  const [embedServed, setEmbedServed] = useState<string[]>([]);
  useEffect(() => {
    if (!isLocal || !settings.localEmbedBaseUrl.trim()) return setEmbedServed([]);
    let cancelled = false;
    const t = setTimeout(() => {
      listLocalModels({ baseUrl: settings.localEmbedBaseUrl, key: settings.localEmbedKey })
        .then((m) => !cancelled && setEmbedServed(m))
        .catch(() => !cancelled && setEmbedServed([]));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isLocal, settings.localEmbedBaseUrl, settings.localEmbedKey]);
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
    // If the removed chip was the active model, fall back to the next saved one.
    if (settings.model === m) {
      patch({ model: next[0] ?? "" });
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
  const serverCtx = useServerContext(settings);
  const localWindow = windowFor(settings, serverCtx);
  const tokens = (n: number) => n.toLocaleString();

  /* What the optional groups show while closed. */
  const behaviorSummary = [
    `${THINKING_LABELS[settings.thinking === "off" && !isLocal ? "auto" : settings.thinking]} thinking`,
    temp == null ? "default temperature" : `temperature ${temp.toFixed(2)}`,
    settings.maxOutput == null ? "automatic length" : `up to ${settings.maxOutput / 1024}K tokens`,
    !settings.agentTools && "look deeper off",
    !settings.agentStudio && "study items from chat off",
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());

  const showImage =
    settings.imageRunsOn !== "local" && !(settings.imageRunsOn === "auto" && (isLocal || isBrewlm));
  const showWeb = !isBrewlm && platform.kind === "desktop";
  const showResearch = !isBrewlm;
  const showTranscribe = !isBrewlm && !staysLocal(settings, "transcribe");
  const shortId = (id: string) => id.trim().split("/").pop() ?? id;
  const customJobs = [
    showResearch && researchModel.trim() && `Research: ${shortId(researchModel)}`,
    showImage && settings.imageModel !== DEFAULT_IMAGE_MODEL && `Images: ${shortId(settings.imageModel)}`,
    showTranscribe && Object.values(settings.transcribeModels).some((m) => m?.trim()) && "custom transcription",
    showWeb && settings.searchService !== "auto" && "custom web search",
  ].filter(Boolean) as string[];
  const jobsSummary = customJobs.length ? customJobs.join(" · ") : "All automatic";

  return (
    <div>
      <SectionTitle
        title="AI Model"
        desc="Choose who runs the AI and which model. That's all most people need; everything under More options is optional."
      />

      {/* Provider + key + model */}
      <Card>
        <Row label="Provider">
          <Segmented<Provider>
            options={providers.map((p) => ({ id: p, label: PROVIDER_LABELS[p] }))}
            value={provider}
            onChange={(p) =>
              // Model ids are provider-namespaced, so another provider's
              // id is invalid: start empty and let the user pick.
              patch(
                p === "local"
                  ? { provider: p, model: "", localBaseUrl: settings.localBaseUrl || LOCAL_PRESETS[0].url }
                  : p === "brewlm"
                    ? { provider: p, model: defaultModelFor(p) }
                    : { provider: p, model: "" }
              )
            }
          />
        </Row>
        {isBrewlm ? (
          <BrewLmAiStatusRow model={settings.model} />
        ) : isLocal ? (
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
            <LocalContextRow settings={settings} patch={patch} />
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
                  {(settings.localEmbedBaseUrl ? embedServed : served).filter(isEmbeddingModel).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </Row>
            <Row
              label="Embedding server"
              desc="Leave empty to use the chat server. Set one when your chat engine has no embedding models (Strata, for one) — for example Ollama with nomic-embed-text."
              alignTop
            >
              <div className="flex w-72 flex-col gap-1.5">
                <input
                  value={settings.localEmbedBaseUrl}
                  onChange={(e) => patch({ localEmbedBaseUrl: e.target.value })}
                  onBlur={(e) => {
                    const url = e.target.value.trim() ? normalizeBaseUrl(e.target.value) : "";
                    if (url !== e.target.value) patch({ localEmbedBaseUrl: url });
                  }}
                  placeholder="Same as chat server"
                  className={inputClass}
                />
                {settings.localEmbedBaseUrl && (
                  <input
                    type="password"
                    value={settings.localEmbedKey}
                    onChange={(e) => patch({ localEmbedKey: e.target.value })}
                    placeholder="API key (optional)"
                    className={inputClass}
                  />
                )}
              </div>
            </Row>
          </Card>
          <Footnote>
            BrewLM never sends more than the window your server loaded the model with. Ollama starts
            models with a small one; raise it with the <code>OLLAMA_CONTEXT_LENGTH</code> setting. Image reading,
            transcription and other jobs each have their own setting in{" "}
            <button
              onClick={() => goToSettingsSection("local")}
              className="inline-flex items-center gap-0.5 text-link hover:underline"
            >
              Local Models <ArrowRight size={10} />
            </button>
            .
          </Footnote>
        </>
      )}

      {/* Model: type any id to use it instantly; save favorites to the list. BrewLM AI: a tier. */}
      {isBrewlm ? (
        <>
          <Card>
            <BrewLmTierRow settings={settings} patch={patch} />
          </Card>
          <Footnote>
            BrewLM AI also handles research, audio overview voices, transcription, pictures and
            search for you, each on a model picked for the job. Your sources and chats go to the AI
            model only to answer you; they aren't stored by BrewLM.
          </Footnote>
        </>
      ) : (
      <Card>
        <Row
          label="Model"
          desc={
            isLocal
              ? "Models from your server appear below. Type an id if one is missing."
              : "The model everything runs on."
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
      )}

      {/* Everything below is optional: closed by default, with a summary of what's set. */}
      <GroupLabel>More options</GroupLabel>
      <Disclosure id="ai-behavior" title="Response style" summary={behaviorSummary}>
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
            “{settings.model}” doesn't take a custom temperature, so it's left at the model's default.
            The setting stays saved for your other models.
          </Footnote>
        )}

        {/* Thinking effort + output limit */}
        <Card>
          <Row
            label="Thinking effort"
            desc={
              isLocal
                ? "How long reasoning models think before answering. Off answers straight away and leaves the small window for the reply. Auto uses each model's default; some models only switch thinking on or off, and models that don't think ignore it."
                : "How long reasoning models think before answering. Lower is faster and cheaper, and leaves more room for long outputs. Auto uses each model's default; models that don't think ignore it."
            }
            alignTop
          >
            <Segmented<Thinking>
              options={thinkingLevels(provider).map((t) => ({ id: t, label: THINKING_LABELS[t] }))}
              value={settings.thinking === "off" && !isLocal ? "auto" : settings.thinking}
              onChange={(t) => patch({ thinking: t })}
            />
          </Row>
          <Row
            label="Custom output limit"
            desc={
              isLocal
                ? `The most a reply can be. Off gives replies about ${tokens(budgetForContext(localWindow).maxOutput)} tokens, a quarter of the ${tokens(localWindow)}-token window. A custom limit can use more, up to what the window has left after your sources.`
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
            <Row
              label="Limit"
              desc={
                isLocal
                  ? `Lowered automatically to fit: with a ${tokens(localWindow)}-token window, a reply can't be longer than what's left after the prompt${settings.maxOutput > localWindow ? ", so anything above that acts the same" : ""}.`
                  : "Lowered automatically when a model allows less."
              }
            >
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

        {/* Look deeper (agent.ts): read-only look-ups in big notebooks. */}
        <Card>
          <Row
            label="Look deeper in big notebooks"
            desc={
              isLocal
                ? "Not available with local models yet: small models use tools unreliably. Your setting is kept for cloud models."
                : `When a notebook is too big to send whole, the AI can search and read more of its sources before answering: up to ${MAX_TOOL_ROUNDS} extra rounds per message, each shown above the reply and counted in its cost. It can only read this notebook's sources. It can't change, delete or send anything.`
            }
            alignTop
          >
            <Toggle
              label="Look deeper in big notebooks"
              checked={settings.agentTools}
              onChange={(on) => patch({ agentTools: on })}
            />
          </Row>
          <Row
            label="Make study items from chat"
            desc={
              isLocal
                ? "Not available with local models yet. Your setting is kept for cloud models."
                : "Ask in your own words for flashcards, a quiz, a mind map, a report or a document (Word, PowerPoint, Excel or Markdown), and the AI sets it up. Nothing is made until you click Make it, and it makes one at most per message. Audio overviews and deep research stay in the Studio panel."
            }
            alignTop
          >
            <Toggle
              label="Make study items from chat"
              checked={settings.agentStudio}
              onChange={(on) => patch({ agentStudio: on })}
            />
          </Row>
        </Card>
      </Disclosure>
      {(showImage || showWeb || showResearch || showTranscribe) && (
        <Disclosure id="ai-jobs" title="Models for specific jobs" summary={jobsSummary}>
          {/* Image generation (/image); BrewLM AI uses its own image model, a local server is set in Local Models. */}
          {showImage && (
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
          )}

          {/* Where research, /search and /fetch find pages. Desktop only: see loadSettings. */}
          {showWeb && <WebSearchCard settings={settings} patch={patch} />}

          {/* Research model (/research, /search). */}
          {!isBrewlm && (
            <Card>
              <div className="py-3">
                <div className="text-[13px] font-medium text-ink">Research model</div>
                <div className="mt-0.5 mb-2.5 text-[12px] leading-relaxed text-ink-3">
                  Used by Deep Research and <code>/search</code>. A research run reads many pages and
                  writes a long report, so you may want a stronger (or cheaper) model here than for chat.
                  Leave it on “Same as main model” to use your main model.
                  {provider === "openai" && settings.searchService === "auto" && (
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

          <TranscriptionModelCard settings={settings} patch={patch} />
        </Disclosure>
      )}
      {provider === "openrouter" && (
        <Disclosure id="ai-routing" title="OpenRouter routing" summary="Provider priority, privacy and pins">
          <ProviderRoutingCard settings={settings} patch={patch} models={modelList} />
        </Disclosure>
      )}
      <div className="border-t border-edge-soft" />
    </div>
  );
}

/** "32K" for 32768, "4K" for 4096. */
const tokensLabel = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));

/** How each server's window is made bigger. */
const RAISE_HINT: Record<ServerContext["server"], string> = {
  Ollama: "To give it more, set OLLAMA_CONTEXT_LENGTH (for example to 32768) and restart Ollama.",
  "LM Studio": "To give it more, raise Context Length in the model's load settings in LM Studio and load it again.",
  "llama.cpp": "To give it more, start llama-server with a larger -c.",
  vLLM: "To give it more, start vLLM with a larger --max-model-len.",
  SGLang: "To give it more, start SGLang with a larger --context-length.",
  Strata: "To give it more, start Strata with a larger --context (32k, 64k or 128k).",
  KoboldCpp: "To give it more, start KoboldCpp with a larger --contextsize.",
  TabbyAPI: "To give it more, raise max_seq_len in TabbyAPI's config.yml and load the model again.",
};

/**
 * Settings → AI Model → Context window, for local models: Automatic (the size
 * the server loaded the model with) or a fixed size, shown against what the
 * server reports. Only reads the server — viewing Settings never loads a model.
 */
/**
 * What the local server says about the chat model's window, read when the
 * address or model changes ("checking" meanwhile). Only reads: viewing
 * Settings never loads a model.
 */
function useServerContext(settings: Settings): ServerContext | null | "checking" {
  const [ctx, setCtx] = useState<ServerContext | null | "checking">("checking");
  const { localBaseUrl, localKey, model } = settings;
  const local = settings.provider === "local";
  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    setCtx("checking");
    const t = setTimeout(() => {
      readServerContext({ baseUrl: localBaseUrl, key: localKey }, model)
        .then((c) => !cancelled && setCtx(c))
        .catch(() => !cancelled && setCtx(null));
    }, 400); // typing an address or model id: ask once it settles
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [local, localBaseUrl, localKey, model]);
  return ctx;
}

/** The window local requests are sized for: what the server loaded (never more than a picked size), else the pick or 8K. */
function windowFor(settings: Settings, ctx: ServerContext | null | "checking"): number {
  const loaded = ctx !== "checking" ? (ctx?.loaded ?? null) : null;
  const picked = settings.localContext;
  return loaded ? (picked ? Math.min(picked, loaded) : loaded) : picked || 8192;
}

function LocalContextRow({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const ctx = useServerContext(settings);
  const { model } = settings;
  const known = ctx !== "checking" ? ctx : null;
  const loaded = known?.loaded ?? null;
  const picked = settings.localContext;
  const used = windowFor(settings, ctx);
  const name = model.trim() || "the model";
  const fmt = (n: number) => n.toLocaleString();

  let status: string;
  if (ctx === "checking") status = "Checking your server…";
  else if (!known)
    status = picked
      ? "Your server doesn't say how much it holds, so BrewLM goes by the size picked here — match your server's setting."
      : "Your server doesn't say how much it holds, so Automatic uses 8K. Pick your server's size if it's different.";
  else if (!loaded)
    status = `${known.server} hasn't loaded ${name} yet. BrewLM reads its window right before your first question and sends no more than fits.`;
  else {
    status = `${known.server} has ${name} loaded with ${fmt(loaded)} tokens${known.max && known.max > loaded ? ` (the model can take ${fmt(known.max)})` : ""}.`;
    if (picked && picked > loaded) status += " BrewLM uses that, not the larger size picked here.";
    if (loaded < 32768 && (!known.max || known.max > loaded)) status += ` ${RAISE_HINT[known.server]}`;
  }

  return (
    <Row
      label="Context window"
      desc={`How much text the model can read at once. ${status} Each question carries up to about ${Math.round(budgetForContext(used).sources / 1000)}k characters of your sources.`}
      alignTop
    >
      <div className="grid grid-cols-6 gap-1 rounded-lg border border-edge bg-canvas p-1">
        {LOCAL_CONTEXT_OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => patch({ localContext: n })}
            title={n === AUTO_CONTEXT ? "Use the window your server loaded the model with" : undefined}
            className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
              picked === n ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {n === AUTO_CONTEXT ? "Auto" : tokensLabel(n)}
          </button>
        ))}
      </div>
    </Row>
  );
}
