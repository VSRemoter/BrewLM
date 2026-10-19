import { Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useState } from "react";
import {
  bucketize,
  cacheHitRate,
  clearUsageEvents,
  fmtTokens,
  fmtUsd,
  listUsageEvents,
  summarize,
  usageToCsv,
  type UsageEvent,
} from "../../lib/usage";
import { Segmented, Spinner } from "../ui";
import { ActivityChart, type Metric } from "./charts";
import { Footnote, SectionTitle } from "./controls";

type Range = "1" | "7" | "30" | "90" | "all";

const RANGE_LABELS: { id: Range; label: string }[] = [
  { id: "1", label: "24h" },
  { id: "7", label: "7d" },
  { id: "30", label: "30d" },
  { id: "90", label: "90d" },
  { id: "all", label: "All" },
];

/** Palette for model coloring — reads well on light and dark themes alike. */
const MODEL_COLORS = ["#e0607a", "#6b8afd", "#8b5cf6", "#f0a24b", "#34b39a", "#5eb0ef"];
const OTHER_COLOR = "#8a8a8a";

/** A headline number that doubles as the chart's metric switch. */
function MetricTab({
  label,
  value,
  sub,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`group relative min-w-0 flex-1 px-5 pb-4 pt-4 text-left transition-colors ${
        active ? "" : "hover:bg-hover-soft"
      }`}
    >
      <div className={`text-[12px] font-medium ${active ? "text-ink-2" : "text-ink-3"}`}>{label}</div>
      <div
        className={`mt-1 truncate text-[26px] font-semibold leading-tight tracking-tight tabular-nums ${
          active ? "text-ink" : "text-ink-2 group-hover:text-ink"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 truncate text-[12px] text-ink-3 tabular-nums">{sub}</div>
      <span
        className={`absolute inset-x-5 bottom-0 h-0.5 rounded-full transition-opacity ${
          active ? "bg-accent opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );
}

/** "provider/model-name" → dim provider prefix, bright model name. */
function ModelName({ id }: { id: string }) {
  const slash = id.indexOf("/");
  if (slash < 0) return <span className="text-ink">{id}</span>;
  return (
    <>
      <span className="text-ink-3">{id.slice(0, slash + 1)}</span>
      <span className="text-ink">{id.slice(slash + 1)}</span>
    </>
  );
}

export default function UsageSection() {
  const [range, setRange] = useState<Range>("7");
  const [metric, setMetric] = useState<Metric>("cost");
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const load = (r: Range) => {
    const s = r === "all" ? 0 : Date.now() - Number(r) * 86_400_000;
    listUsageEvents(s).then(setEvents);
  };

  useEffect(() => {
    setEvents(null);
    load(range);
  }, [range]);

  const startTs = range === "all" ? (events?.length ? events[events.length - 1].ts : Date.now()) : Date.now() - (Number(range) - 1) * 86_400_000;
  const buckets = useMemo(
    () => (events ? bucketize(events, range === "1" ? "hour" : "day", startTs) : []),
    [events, range, startTs]
  );

  const total = events ? summarize(events) : null;
  const hitRate = events ? cacheHitRate(events) : 0;
  const totalTokens = total ? total.input + total.output : 0;

  /** One row per model, biggest token consumer first. */
  const modelRows = useMemo(() => {
    if (!events) return [];
    const groups = new Map<string, UsageEvent[]>();
    for (const e of events) groups.set(e.model, [...(groups.get(e.model) ?? []), e]);
    return [...groups.entries()]
      .map(([model, evs]) => {
        const s = summarize(evs);
        return {
          model,
          calls: s.events,
          tokens: s.input + s.output,
          cost: s.realCostUsd + s.estCostUsd,
          hit: cacheHitRate(evs),
        };
      })
      .sort((a, b) => b.tokens - a.tokens)
      .map((m, i) => ({ ...m, color: i < MODEL_COLORS.length ? MODEL_COLORS[i] : OTHER_COLOR }));
  }, [events]);

  const exportCsv = async () => {
    if (!events?.length) return;
    setExportNote(null);
    const dest = await save({
      defaultPath: `brewlm-usage-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!dest) return;
    await writeTextFile(dest, usageToCsv(events));
    setExportNote(`Exported ${events.length} rows to ${dest}`);
  };

  const reset = async () => {
    await clearUsageEvents();
    setConfirmReset(false);
    load(range);
  };

  const rangeText = range === "all" ? "all time" : range === "1" ? "the last 24 hours" : `the last ${range} days`;

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle title="Usage & Cost" />
        </div>
        <div className="mb-3 flex items-center gap-1.5">
          <Segmented options={RANGE_LABELS} value={range} onChange={setRange} />
          <button
            onClick={() => void exportCsv()}
            disabled={!events?.length}
            title="Export CSV"
            aria-label="Export CSV"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-edge text-ink-2 transition-colors hover:bg-hover-soft hover:text-ink disabled:opacity-40"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {!events ? (
        <div className="flex justify-center py-16">
          <Spinner size={18} />
        </div>
      ) : total!.events === 0 ? (
        <div className="rounded-2xl border border-edge bg-panel px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink">No usage in {rangeText}</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Token usage appears here after your first chat reply or Studio generation.
          </p>
        </div>
      ) : (
        <>
          {/* Overview: headline numbers + chart in one panel */}
          <div className="mb-8 overflow-hidden rounded-2xl border border-edge bg-panel">
            <div role="tablist" className="flex divide-x divide-edge-soft border-b border-edge-soft">
              <MetricTab
                label="Spend"
                value={fmtUsd(total!.realCostUsd + total!.estCostUsd)}
                sub={total!.estCostUsd > 0 ? "includes estimates" : "billed by provider"}
                active={metric === "cost"}
                onClick={() => setMetric("cost")}
              />
              <MetricTab
                label="Tokens"
                value={fmtTokens(totalTokens)}
                sub={`${fmtTokens(total!.input)} in · ${fmtTokens(total!.output)} out`}
                active={metric === "tokens"}
                onClick={() => setMetric("tokens")}
              />
              <MetricTab
                label="Generations"
                value={String(total!.events)}
                sub={`${modelRows.length} ${modelRows.length === 1 ? "model" : "models"} · ${(hitRate * 100).toFixed(0)}% cached`}
                active={metric === "calls"}
                onClick={() => setMetric("calls")}
              />
            </div>
            <div className="px-3 pb-2 pt-4">
              <ActivityChart buckets={buckets} metric={metric} />
            </div>
          </div>

          {/* Models */}
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[14px] font-semibold text-ink">Models</h3>
            <span className="text-[12px] text-ink-3">{rangeText}</span>
          </div>

          {/* Token share, as one stacked bar */}
          <div className="mb-4 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full">
            {modelRows.map((m) => (
              <div
                key={m.model}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(m.tokens / Math.max(1, totalTokens)) * 100}%`, background: m.color }}
                title={`${m.model} — ${((m.tokens / Math.max(1, totalTokens)) * 100).toFixed(1)}%`}
              />
            ))}
          </div>

          <div className="mb-8 overflow-hidden rounded-2xl border border-edge bg-panel">
            <table className="w-full table-fixed text-[13px]">
              <thead>
                <tr className="border-b border-edge-soft text-left text-[11.5px] text-ink-3">
                  <th className="px-5 py-2.5 font-medium">Model</th>
                  <th className="w-[72px] px-2 py-2.5 text-right font-medium">Share</th>
                  <th className="w-[84px] px-2 py-2.5 text-right font-medium">Tokens</th>
                  <th className="w-[64px] px-2 py-2.5 text-right font-medium">Calls</th>
                  <th className="w-[76px] px-2 py-2.5 text-right font-medium">Cached</th>
                  <th className="w-[92px] py-2.5 pl-2 pr-5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-soft tabular-nums">
                {modelRows.map((m) => (
                  <tr key={m.model} className="transition-colors hover:bg-hover-soft">
                    <td className="px-5 py-3">
                      <div className="flex min-w-0 items-center gap-2.5" title={m.model}>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.color }} />
                        <span className="truncate font-mono text-[12.5px]">
                          <ModelName id={m.model} />
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right text-ink-2">
                      {((m.tokens / Math.max(1, totalTokens)) * 100).toFixed(0)}%
                    </td>
                    <td className="px-2 py-3 text-right text-ink">{fmtTokens(m.tokens)}</td>
                    <td className="px-2 py-3 text-right text-ink-2">{m.calls}</td>
                    <td className="px-2 py-3 text-right text-ink-3">
                      {m.hit > 0 ? `${(m.hit * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="py-3 pl-2 pr-5 text-right font-medium text-ink">{fmtUsd(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {exportNote && <Footnote>{exportNote}</Footnote>}
      <Footnote>
        Tokens are tracked for every provider. For cost, OpenRouter reports the real billed amount
        per generation; OpenAI and Anthropic costs are estimated from public list prices (unknown
        models estimate as $0). Web-search fees (billed per query by your provider) and TTS audio
        aren't included.
      </Footnote>

      {/* Reset — quiet, at the very end */}
      <div className="mt-4 flex items-center gap-3 text-[12.5px]">
        {confirmReset ? (
          <>
            <span className="text-ink-2">Delete all recorded usage?</span>
            <button onClick={() => void reset()} className="font-medium text-danger hover:underline">
              Reset
            </button>
            <button onClick={() => setConfirmReset(false)} className="text-ink-3 hover:text-ink">
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmReset(true)} className="text-ink-3 transition-colors hover:text-danger">
            Reset statistics…
          </button>
        )}
      </div>
    </div>
  );
}
