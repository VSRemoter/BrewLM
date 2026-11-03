import { ArrowDown, ArrowUp, ExternalLink, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  baseSlug,
  findProvider,
  loadModelEndpoints,
  loadProviders,
  type ModelEndpoint,
  type ModelPin,
  pinFor,
  pinKey,
  type ProviderInfo,
  type RoutingSort,
  SORT_LABELS,
  withPin,
} from "../../lib/routing";
import type { Settings } from "../../lib/types";
import { Spinner } from "../ui";
import { Card, Footnote, Row, Toggle } from "./controls";

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

/** USD per million tokens: "$0.14", "$15", "free". */
function fmtPrice(n: number): string {
  if (n === 0) return "free";
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}

function fmtContext(n: number): string {
  if (!n) return "";
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

/** One provider for the picked model: name, variant, price, context, and its controls. */
function EndpointRow({ endpoint, slug, children }: { endpoint?: ModelEndpoint; slug: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] text-ink">{endpoint?.name ?? slug}</span>
          <span className="truncate font-mono text-[11px] text-ink-3">{slug}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-ink-3">
          {endpoint ? (
            <>
              {fmtPrice(endpoint.promptPrice)} in · {fmtPrice(endpoint.completionPrice)} out per 1M
              {endpoint.context ? ` · ${fmtContext(endpoint.context)} context` : ""}
              {endpoint.quantization ? ` · ${endpoint.quantization}` : ""}
              {endpoint.status < 0 && <span className="text-warn"> · having trouble right now</span>}
            </>
          ) : (
            <span className="text-warn">No longer serves this model</span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Settings → AI Model → Provider routing (OpenRouter only). Global rules that
 * are safe for any model, then pins for one model at a time.
 */
export default function ProviderRoutingCard({
  settings,
  patch,
  models,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  /** The saved chat models, offered in the "Providers for" picker. */
  models: string[];
}) {
  const routing = settings.openrouterRouting;
  const setRouting = (next: Partial<typeof routing>) => patch({ openrouterRouting: { ...routing, ...next } });

  /* ------------------------------ Blocked providers ------------------------------ */
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const nameOf = (slug: string) => providers.find((p) => p.slug === slug)?.name ?? slug;

  const [blockDraft, setBlockDraft] = useState("");
  const blockMatch = findProvider(providers, blockDraft);
  const blockSlug = blockMatch?.slug ?? (providers.length === 0 ? baseSlug(blockDraft.trim().toLowerCase()) : "");
  const block = () => {
    if (!blockSlug || routing.ignore.includes(blockSlug)) return;
    setRouting({ ignore: [...routing.ignore, blockSlug] });
    setBlockDraft("");
  };

  /* ------------------------------ Per-model pins ------------------------------ */
  // Saved models, the active one and anything already pinned, one entry per model.
  const pickable = useMemo(() => {
    const ids = [settings.model, ...models, ...Object.keys(routing.pins)].map((m) => m.trim()).filter(Boolean);
    const seen = new Set<string>();
    return ids.filter((m) => {
      const k = pinKey(m);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [settings.model, models, routing.pins]);
  const [picked, setPicked] = useState(settings.model.trim());
  // Follow the main model when it changes elsewhere (Model box, /model).
  useEffect(() => setPicked(settings.model.trim()), [settings.model]);

  const [endpoints, setEndpoints] = useState<ModelEndpoint[] | null | "loading">("loading");
  useEffect(() => {
    if (!picked) return setEndpoints(null);
    let cancelled = false;
    setEndpoints("loading");
    loadModelEndpoints(picked).then((list) => {
      if (!cancelled) setEndpoints(list);
    });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const pin: ModelPin = pinFor(routing, picked) ?? { order: [], only: false };
  const savePin = (next: ModelPin) => patch({ openrouterRouting: withPin(routing, picked, next) });
  const move = (i: number, by: number) => {
    const order = [...pin.order];
    [order[i], order[i + by]] = [order[i + by], order[i]];
    savePin({ ...pin, order });
  };
  const list = Array.isArray(endpoints) ? endpoints : [];
  const unpinned = list
    .filter((e) => !pin.order.includes(e.slug))
    .sort((a, b) => a.promptPrice + a.completionPrice - (b.promptPrice + b.completionPrice));
  const pinnedCount = Object.keys(routing.pins).length;

  return (
    <>
      <Card>
        <div className="pt-3">
          <div className="text-[13px] font-medium text-ink">Provider routing</div>
          <div className="mt-0.5 pb-3 text-[12px] leading-relaxed text-ink-3">
            Most OpenRouter models are run by several providers, each with its own price, speed and
            privacy terms.
          </div>
        </div>
        <Row
          label="Priority"
          desc="Balanced is OpenRouter's default: mostly the cheapest provider that's up, spread across a few. Quickest start favors the shortest wait before the first word."
          alignTop
        >
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
            {(Object.keys(SORT_LABELS) as RoutingSort[]).map((s) => (
              <button
                key={s || "default"}
                onClick={() => setRouting({ sort: s })}
                className={`whitespace-nowrap rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                  routing.sort === s ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Don't let providers train on my data"
          desc="Skips providers that may store your prompts or use them for training. Some free models have no provider left with this on."
        >
          <Toggle
            label="Don't let providers train on my data"
            checked={routing.noTraining}
            onChange={(on) => setRouting({ noTraining: on })}
          />
        </Row>
        <Row
          label="Zero data retention only"
          desc="Only providers that keep nothing once they've answered. Far fewer models qualify."
        >
          <Toggle label="Zero data retention only" checked={routing.zdr} onChange={(on) => setRouting({ zdr: on })} />
        </Row>
        <Row label="Blocked providers" desc="Never used, for any model. A provider you pin for a model is still used for it." alignTop>
          <div className="w-72">
            <div className="flex gap-1.5">
              <input
                list="openrouter-providers"
                value={blockDraft}
                onChange={(e) => setBlockDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    block();
                  }
                }}
                placeholder="Provider name"
                className={inputClass}
              />
              <datalist id="openrouter-providers">
                {providers
                  .filter((p) => !routing.ignore.includes(p.slug))
                  .map((p) => (
                    <option key={p.slug} value={p.name} />
                  ))}
              </datalist>
              <button
                onClick={block}
                disabled={!blockSlug || routing.ignore.includes(blockSlug)}
                title="Block this provider"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40"
              >
                <Plus size={12} strokeWidth={2.5} />
                Block
              </button>
            </div>
            {blockDraft.trim() && providers.length > 0 && !blockMatch && (
              <p className="mt-1.5 text-[12px] text-ink-3">No provider called “{blockDraft.trim()}” on OpenRouter.</p>
            )}
            {routing.ignore.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {routing.ignore.map((slug) => (
                  <span
                    key={slug}
                    className="flex items-center gap-1 rounded-md border border-edge bg-canvas py-0.5 pl-2 pr-1 text-[12px] text-ink-2"
                  >
                    {nameOf(slug)}
                    <button
                      onClick={() => setRouting({ ignore: routing.ignore.filter((s) => s !== slug) })}
                      title={`Unblock ${nameOf(slug)}`}
                      className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Row>

        {/* Pins: one model at a time, since each model has its own providers. */}
        <div className="py-3">
          <div className="text-[13px] font-medium text-ink">Pin providers for a model</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">
            Pinned providers are tried first, in order, and replace Priority for that model.
            {pinnedCount > 0 && ` ${pinnedCount} ${pinnedCount === 1 ? "model has" : "models have"} pins.`}
          </div>
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className={`${inputClass} mt-2.5`}
            aria-label="Model to pin providers for"
          >
            {pickable.map((m) => (
              <option key={m} value={m}>
                {m}
                {pinFor(routing, m) ? "  · pinned" : ""}
              </option>
            ))}
          </select>

          {endpoints === "loading" ? (
            <div className="flex items-center gap-2 py-4 text-[12px] text-ink-3">
              <Spinner size={12} /> Looking up who serves this model…
            </div>
          ) : (
            <>
              {endpoints === null && (
                <p className="mt-2.5 text-[12px] leading-relaxed text-warn">
                  Couldn't get this model's providers from OpenRouter. Check the model id, or try again
                  later.
                </p>
              )}
              {pin.order.length > 0 && (
                <>
                  <div className="mb-1.5 mt-3 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Pinned, in order</span>
                    <button onClick={() => savePin({ order: [], only: false })} className="text-[11.5px] text-link hover:underline">
                      Clear pins
                    </button>
                  </div>
                  <div className="divide-y divide-edge-soft rounded-lg border border-edge">
                    {pin.order.map((slug, i) => (
                      <EndpointRow key={slug} slug={slug} endpoint={list.find((e) => e.slug === slug)}>
                        <span className="w-4 text-center font-mono text-[11px] text-ink-3">{i + 1}</span>
                        <button onClick={() => move(i, -1)} disabled={i === 0} title="Try earlier" className={iconButton}>
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={i === pin.order.length - 1}
                          title="Try later"
                          className={iconButton}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          onClick={() => savePin({ ...pin, order: pin.order.filter((s) => s !== slug) })}
                          title="Unpin"
                          className={iconButton}
                        >
                          <X size={13} />
                        </button>
                      </EndpointRow>
                    ))}
                  </div>
                  <div className="mt-2.5 flex items-start justify-between gap-6">
                    <div>
                      <div className="text-[12.5px] font-medium text-ink">Only these providers</div>
                      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">
                        {pin.only
                          ? "If none of them can answer, the request fails instead of going to another provider."
                          : "Off: if none of them can answer, OpenRouter falls back to the others."}
                      </div>
                    </div>
                    <Toggle label="Only these providers" checked={pin.only} onChange={(on) => savePin({ ...pin, only: on })} />
                  </div>
                </>
              )}
              {unpinned.length > 0 && (
                <>
                  <div className="mb-1.5 mt-3 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      {pin.order.length ? "Other providers" : "Providers for this model"}, cheapest first
                    </span>
                    <span className="text-[11px] text-ink-3">{unpinned.length}</span>
                  </div>
                  <div className="max-h-64 divide-y divide-edge-soft overflow-y-auto rounded-lg border border-edge">
                    {unpinned.map((e) => (
                      <EndpointRow key={e.slug} slug={e.slug} endpoint={e}>
                        {routing.ignore.includes(baseSlug(e.slug)) && (
                          <span className="text-[11px] text-ink-3">blocked</span>
                        )}
                        <button
                          onClick={() => savePin({ ...pin, order: [...pin.order, e.slug] })}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-edge px-2 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover"
                        >
                          <Plus size={11} strokeWidth={2.5} />
                          Pin
                        </button>
                      </EndpointRow>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Card>
      <Footnote>
        Rules you set in your{" "}
        <a
          href="https://openrouter.ai/settings/preferences"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-link hover:underline"
        >
          OpenRouter account <ExternalLink size={10} />
        </a>{" "}
        apply on top of these. Use them for <code>/image</code>, embeddings and the Audio overview's
        speech models, which these rules don't reach. In chat: <code>/provider</code>.
      </Footnote>
    </>
  );
}
