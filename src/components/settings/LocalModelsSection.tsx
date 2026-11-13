/**
 * Settings → Local Models: the local server connection (shared with AI Model
 * when chat runs locally) and where each job runs — this computer or a cloud
 * provider (featureRoute.ts).
 */
import { ArrowRight, Check, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { planHasAi } from "../../lib/brewlmAi";
import { CLOUD_PROVIDERS, imageRoute, LOCAL_CAPABLE, type MediaFeature, staysLocal } from "../../lib/featureRoute";
import { detectImageServer, generateLocalImages, type ImageServer, imageServerRoot } from "../../lib/localImage";
import {
  detectLocalServers,
  type FoundServer,
  isEmbeddingModel,
  isTranscribeModel,
  isVisionModel,
  listLocalModels,
  normalizeBaseUrl,
} from "../../lib/local";
import { LOCAL_STT_DEFAULT_MODEL, mediaProviders, testLocalTranscription, testLocalVision, type VisionTest } from "../../lib/media";
import { DEFAULT_TTS_MODELS, LOCAL_IMAGE_PRESETS, LOCAL_PRESETS, LOCAL_STT_PRESETS, PROVIDER_LABELS, TTS_PROVIDER_LABELS } from "../../lib/settings";
import { goToSettingsSection, type SettingsSectionId } from "../../lib/settingsNav";
import type { ImageRunsOn, RunsOn, Settings } from "../../lib/types";
import { SEARCH_SERVICE_LABELS } from "../../lib/webSearch";
import { Spinner } from "../ui";
import { Card, Footnote, Row, SectionTitle } from "./controls";

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

const smallButton =
  "flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-40";

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; models: string[] }
  | { state: "error"; message: string };

/**
 * Server address, presets, optional key and a connection test. Used by AI
 * Model (chat on Local) and Local Models; `detect` adds a port scan.
 */
export function LocalServerRows({
  settings,
  patch,
  onModels,
  detect = false,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  onModels: (models: string[]) => void;
  detect?: boolean;
}) {
  const [conn, setConn] = useState<Connection>({ state: "idle" });
  const [found, setFound] = useState<FoundServer[] | "looking" | null>(null);
  const activePreset = LOCAL_PRESETS.find((p) => p.url === settings.localBaseUrl)?.id ?? "custom";

  const test = async (baseUrl = settings.localBaseUrl, key = settings.localKey) => {
    setConn({ state: "testing" });
    try {
      const models = await listLocalModels({ baseUrl, key });
      setConn({ state: "ok", models });
      onModels(models);
      // First connection: pick sensible defaults so things work right away.
      const chat = models.filter((m) => !isEmbeddingModel(m));
      const next: Partial<Settings> = {};
      // Only when chat runs locally: a cloud chat model is never swapped for a local one.
      if (settings.provider === "local" && (!settings.model.trim() || !models.includes(settings.model)))
        next.model = chat[0] ?? "";
      if (!settings.localEmbedModel) next.localEmbedModel = models.find(isEmbeddingModel) ?? "";
      if (!settings.localVisionModel) next.localVisionModel = chat.find(isVisionModel) ?? "";
      if (Object.values(next).some((v) => v)) patch(next);
    } catch (e) {
      setConn({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Check the saved server once when the section opens.
  useEffect(() => {
    if (settings.localBaseUrl) void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const use = (url: string) => {
    patch({ localBaseUrl: url });
    void test(url, "");
  };

  return (
    <>
      {detect && (
        <Row label="Find servers" desc="Looks for Ollama, LM Studio, llama.cpp, Jan and vLLM on their usual ports." alignTop>
          <div className="flex w-72 flex-col items-end gap-1.5">
            <button
              onClick={async () => {
                setFound("looking");
                setFound(await detectLocalServers());
              }}
              disabled={found === "looking"}
              className={smallButton}
            >
              {found === "looking" ? <Spinner size={12} /> : <Search size={12} />}
              Find
            </button>
            {Array.isArray(found) && found.length === 0 && (
              <p className="text-right text-[12px] leading-relaxed text-ink-3">
                Nothing found. Start your server app, or type its address below.
              </p>
            )}
            {Array.isArray(found) &&
              found.map((f) => {
                const current = normalizeBaseUrl(settings.localBaseUrl) === f.baseUrl;
                return (
                  <div key={f.baseUrl} className="flex w-full items-center justify-between gap-2 text-[12px]">
                    <span className="truncate text-ink-2">
                      <span className="font-medium text-ink">{f.label}</span> · {f.models.length}{" "}
                      {f.models.length === 1 ? "model" : "models"}
                    </span>
                    {current ? (
                      <span className="flex items-center gap-1 text-ok">
                        <Check size={12} /> In use
                      </span>
                    ) : (
                      <button onClick={() => use(f.baseUrl)} className="font-medium text-link hover:underline">
                        Use
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </Row>
      )}
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
            className={smallButton}
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

/* ------------------------------ where jobs run ------------------------------ */

const RUNS_ON_KEY: Record<MediaFeature, "visionRunsOn" | "transcribeRunsOn"> = {
  vision: "visionRunsOn",
  transcribe: "transcribeRunsOn",
};

/** A job's "Runs on" picker, plus a line saying what will actually happen. */
function RunsOnRow({
  feature,
  label,
  desc,
  settings,
  patch,
}: {
  feature: MediaFeature;
  label: string;
  desc: string;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const key = RUNS_ON_KEY[feature];
  const value = settings[key];
  const chatLocal = settings.provider === "local";
  const options: { value: RunsOn; label: string }[] = [
    {
      value: "auto",
      label: chatLocal ? "Automatic · this computer" : `Automatic · ${PROVIDER_LABELS[settings.provider]} first`,
    },
    ...(LOCAL_CAPABLE[feature] ? [{ value: "local" as RunsOn, label: "This computer" }] : []),
    ...CLOUD_PROVIDERS[feature]
      .filter((p) => p !== "brewlm" || planHasAi() || value === "brewlm")
      .map((p) => ({ value: p as RunsOn, label: PROVIDER_LABELS[p] })),
  ];
  return (
    <Row label={label} desc={desc} alignTop>
      <div className="w-72">
        <select
          value={value}
          onChange={(e) => patch({ [key]: e.target.value as RunsOn } as Partial<Settings>)}
          className={inputClass}
          aria-label={`Where ${label.toLowerCase()} runs`}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <RouteStatus feature={feature} settings={settings} />
      </div>
    </Row>
  );
}

function RouteStatus({ feature, settings }: { feature: MediaFeature; settings: Settings }) {
  const providers = mediaProviders(settings, feature);
  const r = settings[RUNS_ON_KEY[feature]];
  let tone = "text-ink-3";
  let text: string;
  if (providers[0] === "local") {
    tone = "text-ok";
    text =
      feature === "vision"
        ? `Runs on this computer with ${settings.localVisionModel}.`
        : `Runs on this computer with ${settings.localSttModel || LOCAL_STT_DEFAULT_MODEL}.`;
  } else if (providers.length) {
    text =
      providers.length === 1
        ? `Sent to ${PROVIDER_LABELS[providers[0]]}.`
        : `Sent to ${PROVIDER_LABELS[providers[0]]}, with ${providers.slice(1).map((p) => PROVIDER_LABELS[p]).join(" and ")} as backup.`;
  } else if (staysLocal(settings, feature)) {
    tone = "text-warn";
    text =
      feature === "vision"
        ? "Pick a vision model below. Until then, images aren't read, and nothing is sent to the cloud."
        : "Set the address of a transcription server below. Until then, recordings aren't transcribed, and nothing is sent to the cloud.";
  } else {
    tone = "text-warn";
    text =
      r === "auto"
        ? "Needs a key that can do this. Add one in AI Model."
        : `No ${PROVIDER_LABELS[r]} key yet. Add one in AI Model.`;
  }
  return <p className={`mt-1.5 text-right text-[12px] leading-relaxed ${tone}`}>{text}</p>;
}

/** Local vision model: pick from the server's models (likely vision ones first) and test it. */
function VisionModelRows({
  settings,
  patch,
  served,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  served: string[];
}) {
  const [result, setResult] = useState<VisionTest | "testing" | null>(null);
  useEffect(() => setResult(null), [settings.localVisionModel, settings.localBaseUrl]);
  const candidates = served.filter((m) => !isEmbeddingModel(m));
  const likely = candidates.filter(isVisionModel);
  const rest = candidates.filter((m) => !isVisionModel(m));
  return (
    <Row
      label="Vision model"
      desc="A model on your server that can see images, such as qwen2.5vl, gemma3 or llava. It describes each picture and copies out its text."
      alignTop
    >
      <div className="flex w-72 flex-col items-end gap-1.5">
        <select
          value={settings.localVisionModel}
          onChange={(e) => patch({ localVisionModel: e.target.value })}
          className={inputClass}
          aria-label="Local vision model"
        >
          <option value="">{candidates.length ? "Pick a model" : "No models found on the server"}</option>
          {settings.localVisionModel && !candidates.includes(settings.localVisionModel) && (
            <option value={settings.localVisionModel}>{settings.localVisionModel} (not on the server)</option>
          )}
          {likely.length > 0 && (
            <optgroup label="Likely to read images">
              {likely.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label={likely.length ? "Other models" : "Models"}>
              {rest.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {candidates.length > 0 && likely.length === 0 && (
          <p className="text-right text-[12px] leading-relaxed text-ink-3">
            None of your models look like vision models. In Ollama, run <code>ollama pull qwen2.5vl</code>.
          </p>
        )}
        <button
          onClick={async () => {
            setResult("testing");
            setResult(await testLocalVision(settings));
          }}
          disabled={!settings.localVisionModel || !settings.localBaseUrl.trim() || result === "testing"}
          className={smallButton}
        >
          {result === "testing" ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {result === "testing" ? "Reading a test picture…" : "Test"}
        </button>
        {result && result !== "testing" && (
          <p className={`text-right text-[12px] leading-relaxed ${result.ok ? "text-ok" : "text-danger"}`}>
            {result.ok ? `It read the test picture correctly in ${result.seconds}s.` : result.message}
          </p>
        )}
      </div>
    </Row>
  );
}

/**
 * Local transcription server: its own address (chat servers like Ollama
 * don't transcribe), optional key, model and a test.
 */
function TranscriptionServerRows({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [result, setResult] = useState<VisionTest | "testing" | { listError: string } | null>(null);
  const activePreset = LOCAL_STT_PRESETS.find((p) => p.url === settings.localSttBaseUrl)?.id ?? "custom";

  /** The server's speech-to-text models; picks one when none is set or the pick is gone. */
  const load = async (baseUrl = settings.localSttBaseUrl, key = settings.localSttKey) => {
    try {
      const all = await listLocalModels({ baseUrl, key });
      const stt = all.filter(isTranscribeModel);
      setModels(stt);
      if (stt.length && !stt.includes(settings.localSttModel)) patch({ localSttModel: stt[0] });
    } catch (e) {
      // Not every server lists models (whisper.cpp doesn't); the test still tells whether it works.
      setModels([]);
      if (!/answered 404/.test(e instanceof Error ? e.message : "")) setResult({ listError: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    if (settings.localSttBaseUrl) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (result && result !== "testing" && !("listError" in result)) setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.localSttModel, settings.localSttBaseUrl]);

  const choose = (url: string) => {
    patch({ localSttBaseUrl: url });
    setResult(null);
    void load(url);
  };

  return (
    <>
      <Row label="Transcription server" desc="Chat servers like Ollama can't transcribe, so this is its own app: Speaches, whisper.cpp's server or LocalAI." alignTop>
        <div className="flex w-72 flex-col gap-2">
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {LOCAL_STT_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => choose(p.url)}
                className={`rounded-md px-1.5 py-1.5 text-[12px] font-medium transition-colors ${
                  activePreset === p.id ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {p.label}
              </button>
            ))}
            <span
              className={`rounded-md px-1.5 py-1.5 text-center text-[12px] font-medium ${
                activePreset === "custom" ? "bg-panel text-ink shadow-sm" : "text-ink-3"
              }`}
            >
              Custom
            </span>
          </div>
          <input
            value={settings.localSttBaseUrl}
            onChange={(e) => patch({ localSttBaseUrl: e.target.value })}
            onBlur={(e) => {
              const url = normalizeBaseUrl(e.target.value);
              if (url !== e.target.value) patch({ localSttBaseUrl: url });
              if (url) void load(url);
            }}
            placeholder="http://localhost:8000/v1"
            aria-label="Transcription server address"
            className={inputClass}
          />
          <input
            type="password"
            value={settings.localSttKey}
            onChange={(e) => patch({ localSttKey: e.target.value })}
            placeholder="API key (optional)"
            aria-label="Transcription server API key"
            className={inputClass}
          />
          {activePreset === "whispercpp" && (
            <p className="text-[12px] leading-relaxed text-ink-3">
              Start whisper.cpp's server with <code>--inference-path /v1/audio/transcriptions</code>.
            </p>
          )}
        </div>
      </Row>
      <Row label="Transcription model" desc="Leave on the server's default if it lists none." alignTop>
        <div className="flex w-72 flex-col items-end gap-1.5">
          {models && models.length > 0 ? (
            <select
              value={settings.localSttModel}
              onChange={(e) => patch({ localSttModel: e.target.value })}
              className={inputClass}
              aria-label="Local transcription model"
            >
              {settings.localSttModel && !models.includes(settings.localSttModel) && (
                <option value={settings.localSttModel}>{settings.localSttModel} (not on the server)</option>
              )}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={settings.localSttModel}
              onChange={(e) => patch({ localSttModel: e.target.value.trim() })}
              placeholder={`Server default (${LOCAL_STT_DEFAULT_MODEL})`}
              aria-label="Local transcription model"
              className={inputClass}
            />
          )}
          <button
            onClick={async () => {
              setResult("testing");
              setResult(await testLocalTranscription(settings));
            }}
            disabled={!settings.localSttBaseUrl.trim() || result === "testing"}
            className={smallButton}
          >
            {result === "testing" ? <Spinner size={12} /> : <RefreshCw size={12} />}
            {result === "testing" ? "Sending a test clip…" : "Test"}
          </button>
          {result && result !== "testing" && (
            <p
              className={`text-right text-[12px] leading-relaxed ${"listError" in result || !result.ok ? "text-danger" : "text-ok"}`}
            >
              {"listError" in result
                ? result.listError
                : result.ok
                  ? `The server transcribed a test clip in ${result.seconds}s.`
                  : result.message}
            </p>
          )}
        </div>
      </Row>
    </>
  );
}

/** Pictures (/image): where they're drawn, and the local image server when it's this computer. */
function PicturesRows({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const route = imageRoute(settings);
  const local = "via" in route && route.via === "local";
  const localWanted = settings.imageRunsOn === "local" || (settings.imageRunsOn === "auto" && settings.provider === "local");
  const [server, setServer] = useState<ImageServer | null>(null);
  const [check, setCheck] = useState<{ state: "checking" } | { state: "error"; message: string } | null>(null);
  const [draw, setDraw] = useState<{ state: "drawing" } | { state: "ok"; image: string; seconds: number } | { state: "error"; message: string } | null>(null);
  const activePreset = LOCAL_IMAGE_PRESETS.find((p) => p.url === settings.localImageBaseUrl)?.id ?? "custom";

  const connect = async (url = settings.localImageBaseUrl, key = settings.localImageKey) => {
    if (!url.trim()) return;
    setCheck({ state: "checking" });
    setDraw(null);
    try {
      const found = await detectImageServer({ localImageBaseUrl: url, localImageKey: key });
      setServer(found);
      setCheck(null);
      const next: Partial<Settings> = {};
      if (found.api !== settings.localImageApi) next.localImageApi = found.api;
      if (found.models.length && !found.models.includes(settings.localImageModel)) next.localImageModel = found.models[0];
      if (Object.keys(next).length) patch(next);
    } catch (e) {
      setServer(null);
      setCheck({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    if (localWanted && settings.localImageBaseUrl) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localWanted]);

  const testDraw = async () => {
    setDraw({ state: "drawing" });
    const started = Date.now();
    try {
      const { images } = await generateLocalImages(
        settings,
        { prompt: "a red apple on a white table, studio photo", aspectRatio: "1:1" },
        (api) => patch({ localImageApi: api })
      );
      setDraw({ state: "ok", image: images[0], seconds: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      setDraw({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const options: { value: ImageRunsOn; label: string }[] = [
    {
      value: "auto",
      label:
        settings.provider === "local"
          ? "Automatic · this computer"
          : settings.provider === "brewlm"
            ? "Automatic · BrewLM AI"
            : "Automatic · OpenRouter",
    },
    { value: "local", label: "This computer" },
    { value: "openrouter", label: "OpenRouter" },
  ];

  return (
    <>
      <Row label="Pictures (/image)" desc="Draws pictures from what you type. Only your prompt is sent — and, to edit one, that picture." alignTop>
        <div className="w-72">
          <select
            value={settings.imageRunsOn}
            onChange={(e) => patch({ imageRunsOn: e.target.value as ImageRunsOn })}
            className={inputClass}
            aria-label="Where pictures are drawn"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className={`mt-1.5 text-right text-[12px] leading-relaxed ${"error" in route ? "text-warn" : local ? "text-ok" : "text-ink-3"}`}>
            {"error" in route
              ? local || localWanted
                ? "Set the address of an image server below."
                : "Needs an OpenRouter key. Add one in AI Model."
              : local
                ? `Drawn on this computer${settings.localImageModel ? ` with ${settings.localImageModel}` : ""}.`
                : route.via === "brewlm"
                  ? "Drawn by BrewLM AI's image model."
                  : `Drawn by ${settings.imageModel} on OpenRouter.`}
          </p>
        </div>
      </Row>
      {localWanted && (
        <>
          <Row label="Image server" desc="Forge, Automatic1111 or SD.Next started with --api, Draw Things with its API server on, or LocalAI." alignTop>
            <div className="flex w-72 flex-col gap-2">
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-canvas p-1">
                {LOCAL_IMAGE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      patch({ localImageBaseUrl: p.url, localImageApi: "" });
                      void connect(p.url);
                    }}
                    className={`rounded-md px-1.5 py-1.5 text-[12px] font-medium leading-tight transition-colors ${
                      p.id === "a1111" ? "col-span-2" : ""
                    } ${activePreset === p.id ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                value={settings.localImageBaseUrl}
                onChange={(e) => patch({ localImageBaseUrl: e.target.value, localImageApi: "" })}
                onBlur={(e) => {
                  const url = imageServerRoot(e.target.value);
                  // Keep /v1 for OpenAI-style servers; the A1111 root has none.
                  const keep = /\/v1\/?$/i.test(e.target.value.trim()) ? `${url}/v1` : url;
                  if (keep !== e.target.value) patch({ localImageBaseUrl: keep });
                  void connect(keep);
                }}
                placeholder="http://localhost:7860"
                aria-label="Image server address"
                className={inputClass}
              />
              <input
                type="password"
                value={settings.localImageKey}
                onChange={(e) => patch({ localImageKey: e.target.value })}
                placeholder="API key (optional)"
                aria-label="Image server API key"
                className={inputClass}
              />
              {check?.state === "checking" && (
                <p className="flex items-center justify-end gap-1.5 text-[12px] text-ink-3">
                  <Spinner size={11} /> Checking the server…
                </p>
              )}
              {check?.state === "error" && <p className="text-right text-[12px] leading-relaxed text-danger">{check.message}</p>}
              {server && (
                <p className="text-right text-[12px] leading-relaxed text-ok">
                  Connected · {server.api === "a1111" ? "Automatic1111-style API: draws and edits" : "OpenAI-style API: draws new pictures only"}
                </p>
              )}
            </div>
          </Row>
          <Row label="Image model" desc="Leave empty to use whatever the server has loaded." alignTop>
            <div className="flex w-72 flex-col items-end gap-1.5">
              {server && server.models.length > 0 ? (
                <select
                  value={settings.localImageModel}
                  onChange={(e) => patch({ localImageModel: e.target.value })}
                  className={inputClass}
                  aria-label="Local image model"
                >
                  {settings.localImageModel && !server.models.includes(settings.localImageModel) && (
                    <option value={settings.localImageModel}>{settings.localImageModel} (not on the server)</option>
                  )}
                  {server.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={settings.localImageModel}
                  onChange={(e) => patch({ localImageModel: e.target.value.trim() })}
                  placeholder="Server's loaded model"
                  aria-label="Local image model"
                  className={inputClass}
                />
              )}
              <button
                onClick={() => void testDraw()}
                disabled={!settings.localImageBaseUrl.trim() || draw?.state === "drawing"}
                className={smallButton}
              >
                {draw?.state === "drawing" ? <Spinner size={12} /> : <RefreshCw size={12} />}
                {draw?.state === "drawing" ? "Drawing a test picture…" : "Draw a test picture"}
              </button>
              {draw?.state === "ok" && (
                <div className="flex flex-col items-end gap-1">
                  <img src={draw.image} alt="Test picture: a red apple" className="h-28 w-28 rounded-lg border border-edge object-cover" />
                  <p className="text-[12px] text-ok">Drawn in {draw.seconds}s.</p>
                </div>
              )}
              {draw?.state === "error" && <p className="text-right text-[12px] leading-relaxed text-danger">{draw.message}</p>}
            </div>
          </Row>
        </>
      )}
    </>
  );
}

/** A job that has no choice here: where it runs now, and where to change it. */
function StatusRow({
  label,
  where,
  local,
  goTo,
}: {
  label: string;
  where: string;
  local: boolean;
  goTo?: { section: SettingsSectionId; label: string };
}) {
  return (
    <Row label={label}>
      <div className="flex w-72 flex-col items-end gap-0.5 text-right text-[12.5px]">
        <span className={local ? "text-ok" : "text-ink-2"}>{where}</span>
        {goTo && (
          <button
            onClick={() => goToSettingsSection(goTo.section)}
            className="flex items-center gap-1 text-[12px] text-link hover:underline"
          >
            {goTo.label} <ArrowRight size={11} />
          </button>
        )}
      </div>
    </Row>
  );
}

export default function LocalModelsSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [served, setServed] = useState<string[]>([]);
  const chatLocal = settings.provider === "local";
  const chatLabel = PROVIDER_LABELS[settings.provider];
  return (
    <div>
      <SectionTitle
        title="Local Models"
        desc="Run BrewLM's AI on this computer with Ollama, LM Studio or any app that serves an OpenAI-compatible API, and choose where each job runs."
      />

      <Card>
        <LocalServerRows settings={settings} patch={patch} onModels={setServed} detect />
      </Card>

      <Card>
        <RunsOnRow
          feature="vision"
          label="Image reading"
          desc="Describes image sources and copies out their text, so the AI can answer questions about them."
          settings={settings}
          patch={patch}
        />
        {staysLocal(settings, "vision") && <VisionModelRows settings={settings} patch={patch} served={served} />}
        <RunsOnRow
          feature="transcribe"
          label="Transcription"
          desc="Turns audio and video sources into text."
          settings={settings}
          patch={patch}
        />
        {staysLocal(settings, "transcribe") && <TranscriptionServerRows settings={settings} patch={patch} />}
      </Card>

      <Card>
        <PicturesRows settings={settings} patch={patch} />
      </Card>

      <Card>
        <StatusRow
          label="Chat and Studio"
          where={chatLocal ? `This computer · ${settings.model || "no model picked"}` : chatLabel}
          local={chatLocal}
          goTo={{ section: "ai", label: "Change in AI Model" }}
        />
        <StatusRow
          label="Finding passages"
          where={
            chatLocal
              ? settings.localEmbedModel
                ? `This computer · ${settings.localEmbedModel}`
                : "This computer · keyword search"
              : "Follows your chat provider"
          }
          local={chatLocal}
        />
        <StatusRow
          label="Audio overview voices"
          where={
            settings.ttsProvider === "system"
              ? "This computer · system voices"
              : settings.ttsProvider === "local"
                ? `This computer · ${settings.ttsModel.trim() || DEFAULT_TTS_MODELS.local}`
                : TTS_PROVIDER_LABELS[settings.ttsProvider]
          }
          local={settings.ttsProvider === "system" || settings.ttsProvider === "local"}
          goTo={{ section: "audio", label: "Change in Audio Voices" }}
        />

        <StatusRow
          label="Web search and deep research"
          where={
            settings.searchService === "auto"
              ? chatLocal
                ? "Needs a search service"
                : `${chatLabel}'s own search`
              : `${SEARCH_SERVICE_LABELS[settings.searchService]} finds pages · ${chatLocal ? "this computer" : chatLabel} writes`
          }
          local={settings.searchService === "searxng" && chatLocal}
          goTo={{ section: "ai", label: "Change in AI Model" }}
        />
      </Card>
      <Footnote>
        Automatic follows your chat provider. With a local chat model, Automatic keeps the job on this
        computer and never falls back to a saved cloud key: a job with nothing set up here waits
        instead. Pick a cloud provider for a job to send just that job to it.
      </Footnote>
    </div>
  );
}
