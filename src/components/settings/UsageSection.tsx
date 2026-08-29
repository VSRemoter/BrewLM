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
  summarizeByModel,
  usageToCsv,
  type UsageEvent,
} from "../../lib/usage";
import { GhostButton, Segmented, Spinner } from "../ui";
import { ActivityChart, DonutChart, type Metric } from "./charts";
import { Card, Footnote, Row, SectionTitle } from "./controls";

type Range = "1" | "7" | "30" | "90" | "all";

const RANGE_LABELS: { id: Range; label: string }[] = [
  { id: "1", label: "1d" },
  { id: "7", label: "7d" },
  { id: "30", label: "30d" },
  { id: "90", label: "90d" },
  { id: "all", label: "all" },
];

const METRIC_LABELS: { id: Metric; label: string }[] = [
  { id: "tokens", label: "tokens" },
  { id: "cost", label: "$ cost" },
  { id: "calls", label: "calls" },
];

/** Palette for model coloring — reads well on light and dark themes alike. */
const MODEL_COLORS = ["#e0607a", "#6b8afd", "#8b5cf6", "#f0a24b", "#34b39a", "#5eb0ef"];

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-1 truncate text-[18px] font-semibold tracking-tight text-ink" title={value}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

export default function UsageSection() {
  const [range, setRange] = useState<Range>("7");
  const [metric, setMetric] = useState<Metric>("tokens");
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
  const byModel = events ? summarizeByModel(events) : [];
  const hitRate = events ? cacheHitRate(events) : 0;
  const models = byModel.length;

  /** Per-model cache hit rates + call counts for the ranking rows. */
  const modelRows = useMemo(() => {
    if (!events) return [];
    const groups = new Map<string, UsageEvent[]>();
    for (const e of events) groups.set(e.model, [...(groups.get(e.model) ?? []), e]);
    return [...groups.entries()]
      .map(([model, evs]) => ({
        model,
        calls: evs.length,
        tokens: evs.reduce((s, e) => s + e.input + e.output, 0),
        hit: cacheHitRate(evs),
      }))
      .sort((a, b) => b.calls - a.calls);
  }, [events]);

  const maxCalls = Math.max(1, ...modelRows.map((m) => m.calls));

  /** Donut: top models by token share, rest lumped into "Other". */
  const tokenSorted = [...byModel].sort((a, b) => b.input + b.output - (a.input + a.output));
  const donutSlices = tokenSorted.slice(0, 6).map((m, i) => ({
    label: m.model,
    value: m.input + m.output,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));
  const otherTokens = tokenSorted.slice(6).reduce((s, m) => s + m.input + m.output, 0);
  if (otherTokens > 0) {
    donutSlices.push({ label: "Other", value: otherTokens, color: "#a3a3a3" });
  }

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

  const colorFor = (model: string) =>
    MODEL_COLORS[donutSlices.findIndex((s) => s.label === model) % MODEL_COLORS.length] ?? "#a3a3a3";

  return (
    <div>
      <SectionTitle title="Usage & Cost" />

      {/* Controls */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={RANGE_LABELS} value={range} onChange={setRange} />
          <Segmented options={METRIC_LABELS} value={metric} onChange={setMetric} />
        </div>
        <GhostButton onClick={() => void exportCsv()} disabled={!events?.length}>
          <span className="inline-flex items-center gap-1.5">
            <Download size={12} /> Export CSV
          </span>
        </GhostButton>
      </div>

      {!events ? (
        <div className="flex justify-center py-12">
          <Spinner size={18} />
        </div>
      ) : total!.events === 0 ? (
        <p className="rounded-2xl border border-edge bg-panel px-4 py-10 text-center text-[12.5px] text-ink-3">
          Nothing recorded yet — token usage appears here after your first chat reply or Studio
          generation.
        </p>
      ) : (
        <>
          {/* Overview */}
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Overview · {range === "all" ? "all time" : `last ${RANGE_LABELS.find((r) => r.id === range)!.label}`}
          </p>
          <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            <StatCard
              label="Total tokens"
              value={fmtTokens(total!.input + total!.output)}
              sub={`${fmtTokens(total!.input)} in · ${fmtTokens(total!.output)} out`}
            />
            <StatCard
              label="Cache hit rate"
              value={`${(hitRate * 100).toFixed(1)}%`}
              sub="cache reads / total input"
            />
            <StatCard label="Generations" value={String(total!.events)} />
            <StatCard label="Active models" value={String(models)} />
            <StatCard label="Spend" value={fmtUsd(total!.realCostUsd + total!.estCostUsd)} />
          </div>

          {/* Activity */}
          <div className="mb-6 rounded-2xl border border-edge bg-panel px-4 pb-1 pt-3">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                Activity
              </span>
            </div>
            <ActivityChart buckets={buckets} metric={metric} />
          </div>

          {/* Models: ranking + share */}
          <div className="mb-6 grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <div className="rounded-2xl border border-edge bg-panel px-4 py-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Models
                </span>
                <span className="text-[11px] text-ink-3">by calls · cache hit</span>
              </div>
              <div className="divide-y divide-edge-soft">
                {modelRows.slice(0, 8).map((m) => (
                  <div key={m.model} className="flex items-center gap-3 py-2" title={`${m.model} — ${fmtTokens(m.tokens)} tokens`}>
                    <span className="w-32 shrink-0 truncate font-mono text-[11px] text-ink-2" title={m.model}>
                      {m.model}
                    </span>
                    <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${(m.calls / maxCalls) * 100}%`, background: colorFor(m.model) }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right">
                      <span className="block text-[11.5px] font-medium text-ink">{m.calls} calls</span>
                      <span className="block text-[10px] text-ink-3">
                        {m.hit > 0 ? `${(m.hit * 100).toFixed(0)}% hit · ` : ""}
                        {fmtTokens(m.tokens)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-edge bg-panel px-4 py-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Share
                </span>
                <span className="text-[11px] text-ink-3">by tokens</span>
              </div>
              <div className="flex items-center gap-5">
                <DonutChart slices={donutSlices} center={fmtTokens(total!.input + total!.output)} sub="TOKENS" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  {donutSlices.map((s) => {
                    const sum = donutSlices.reduce((acc, x) => acc + x.value, 0);
                    return (
                      <div key={s.label} className="flex items-center gap-2 text-[11.5px]" title={`${s.label} — ${((s.value / sum) * 100).toFixed(1)}%`}>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={s.label}>
                          {s.label}
                        </span>
                        <span className="shrink-0 text-ink-3">{((s.value / sum) * 100).toFixed(0)}%</span>
                        <span className="w-14 shrink-0 text-right text-ink">{fmtTokens(s.value)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Reset */}
      <Card>
        <Row label="Reset statistics">
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <button
                onClick={reset}
                className="rounded-full border border-danger-edge bg-danger-bg px-3.5 py-1.5 text-[12px] font-medium text-danger"
              >
                Confirm reset
              </button>
              <button onClick={() => setConfirmReset(false)} className="text-[12px] text-ink-3 hover:text-ink">
                Cancel
              </button>
            </div>
          ) : (
            <GhostButton onClick={() => setConfirmReset(true)}>Reset</GhostButton>
          )}
        </Row>
      </Card>
      {exportNote && <Footnote>{exportNote}</Footnote>}
      <Footnote>
        Tokens are tracked for every provider. For cost, OpenRouter reports the real billed amount
        per generation; OpenAI and Anthropic costs are estimated from public list prices (unknown
        models estimate as $0). Web-search fees (billed per query by your provider) and TTS audio
        aren't included.
      </Footnote>
    </div>
  );
}
