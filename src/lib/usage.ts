/**
 * Token-usage ledger powering Settings → Usage & Cost.
 *
 * Every chat reply and Studio generation records one row in `usage_events`
 * (tokens only — never content). OpenRouter additionally reports the real
 * billed cost, stored in cost_usd; everything else gets an estimate from the
 * price table below, clearly labeled as such in the UI.
 */
import { getDb, uid } from "./db";
import type { StreamUsage } from "./llm";
import type { Provider } from "./types";

export type UsageKind = "chat" | "studio" | "research" | "sources" | "image";

export interface UsageEvent {
  id: string;
  ts: number;
  provider: string;
  model: string;
  kind: string;
  input: number;
  output: number;
  cached_read: number;
  cached_write: number;
  cost_usd: number | null;
}

/** Persist one completion's usage; no-ops when the provider reported nothing. */
export async function recordUsage(
  kind: UsageKind,
  provider: Provider,
  model: string,
  u: StreamUsage
): Promise<void> {
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cachedRead = u.cachedRead ?? 0;
  const cachedWrite = u.cachedWrite ?? 0;
  // Image generations may report only a cost.
  if (!input && !output && !cachedRead && !cachedWrite && !u.costUsd) return;
  const d = await getDb();
  await d.execute(
    `INSERT INTO usage_events
       (id, ts, provider, model, kind, input, output, cached_read, cached_write, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [uid(), Date.now(), provider, model, kind, input, output, cachedRead, cachedWrite, u.costUsd ?? null]
  );
}

/* ------------------------- Multi-call accumulation ------------------------ */

/**
 * Running total for pipelines that fire MANY completions per user action
 * (e.g. the whole-notebook map-reduce condensation). Recorded as ONE event
 * so the dashboard shows the true token cost without 100 phantom generations.
 */
export interface UsageAccumulator {
  input: number;
  output: number;
  cachedRead: number;
  cachedWrite: number;
  costUsd: number;
  hasCost: boolean;
}

export function newUsageAccumulator(): UsageAccumulator {
  return { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, costUsd: 0, hasCost: false };
}

export function addUsage(acc: UsageAccumulator, u: StreamUsage): void {
  acc.input += u.input ?? 0;
  acc.output += u.output ?? 0;
  acc.cachedRead += u.cachedRead ?? 0;
  acc.cachedWrite += u.cachedWrite ?? 0;
  if (u.costUsd != null) {
    acc.costUsd += u.costUsd;
    acc.hasCost = true;
  }
}

/** Record an accumulated pipeline total as one ledger event (no-op when empty). */
export async function recordAccumulated(
  kind: UsageKind,
  provider: Provider,
  model: string,
  acc: UsageAccumulator
): Promise<void> {
  await recordUsage(kind, provider, model, {
    input: acc.input,
    output: acc.output,
    cachedRead: acc.cachedRead,
    cachedWrite: acc.cachedWrite,
    costUsd: acc.hasCost ? acc.costUsd : undefined,
  });
}

export async function listUsageEvents(since = 0): Promise<UsageEvent[]> {
  const d = await getDb();
  return d.select<UsageEvent[]>(
    "SELECT * FROM usage_events WHERE ts >= $1 ORDER BY ts DESC",
    [since]
  );
}

export async function clearUsageEvents(): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM usage_events");
}

/* ------------------------------ Cost estimates ---------------------------- */

/** USD per 1M tokens: [input, output, cache-read, cache-write]. */
interface PriceEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Rough public list prices for common models (mid-2025). Estimates ONLY —
 * OpenRouter events carry real billed costs and never touch this table.
 * Keys are matched longest-first against the model tail (after any "vendor/").
 */
const PRICE_TABLE: Record<string, PriceEntry> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  "gpt-4.1": { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },
  "claude-haiku-4": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  "deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  "llama-3.3-70b": { input: 0.12, output: 0.3, cacheRead: 0.12, cacheWrite: 0.12 },
};

function priceFor(model: string): PriceEntry | null {
  const tail = model.toLowerCase().split("/").pop() ?? "";
  // Longest key first so "gpt-4o-mini" beats "gpt-4o".
  for (const key of Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length)) {
    if (tail.startsWith(key)) return PRICE_TABLE[key];
  }
  return null;
}

/**
 * Estimated USD for one event, or null when the model isn't in the table.
 * OpenAI-style `input` includes cached tokens; Anthropic reports them
 * separately — subtract only for the OpenAI convention to avoid double-counting.
 */
export function estimateCostUsd(e: UsageEvent): number | null {
  const p = priceFor(e.model);
  if (!p) return null;
  const freshInput =
    e.provider === "anthropic" ? e.input : Math.max(0, e.input - e.cached_read);
  return (
    (freshInput * p.input +
      e.output * p.output +
      e.cached_read * p.cacheRead +
      e.cached_write * p.cacheWrite) /
    1_000_000
  );
}

/* ------------------------------ Aggregations ------------------------------ */

export interface UsageSummary {
  events: number;
  input: number;
  output: number;
  cachedRead: number;
  /** Sum of provider-reported real costs (OpenRouter). */
  realCostUsd: number;
  /** Sum of table estimates for events without a real cost. */
  estCostUsd: number;
}

export interface ModelUsage extends UsageSummary {
  model: string;
  provider: string;
}

export interface DayUsage {
  /** YYYY-MM-DD (local). */
  day: string;
  input: number;
  output: number;
  costUsd: number;
}

export function summarize(events: UsageEvent[]): UsageSummary {
  const s: UsageSummary = { events: 0, input: 0, output: 0, cachedRead: 0, realCostUsd: 0, estCostUsd: 0 };
  for (const e of events) {
    s.events += 1;
    s.input += e.input;
    s.output += e.output;
    s.cachedRead += e.cached_read;
    if (e.cost_usd != null) s.realCostUsd += e.cost_usd;
    else s.estCostUsd += estimateCostUsd(e) ?? 0;
  }
  return s;
}

export function summarizeByModel(events: UsageEvent[]): ModelUsage[] {
  const byModel = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const key = `${e.provider}::${e.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), e]);
  }
  return [...byModel.entries()]
    .map(([key, evs]) => {
      const [provider, model] = key.split("::");
      return { provider, model, ...summarize(evs) };
    })
    .sort((a, b) => b.realCostUsd + b.estCostUsd - (a.realCostUsd + a.estCostUsd));
}

/** Per-day totals, oldest first, for the last `days` days that have activity. */
export function summarizeByDay(events: UsageEvent[], days: number): DayUsage[] {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const byDay = new Map<string, DayUsage>();
  for (const e of events) {
    if (e.ts < cutoff.getTime()) continue;
    const d = new Date(e.ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = byDay.get(day) ?? { day, input: 0, output: 0, costUsd: 0 };
    row.input += e.input;
    row.output += e.output;
    row.costUsd += e.cost_usd ?? estimateCostUsd(e) ?? 0;
    byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/* ------------------------------- Dashboard -------------------------------- */

/**
 * Total input tokens for one event under the right provider convention:
 * OpenAI-style prompt_tokens already includes cached reads; Anthropic reports
 * cache reads/writes as separate counters.
 */
export function totalInputOf(e: UsageEvent): number {
  return e.provider === "anthropic" ? e.input + e.cached_read + e.cached_write : e.input;
}

/** Fraction of input tokens served from the provider's cache (0–1). */
export function cacheHitRate(events: UsageEvent[]): number {
  let cached = 0;
  let total = 0;
  for (const e of events) {
    cached += e.cached_read;
    total += totalInputOf(e);
  }
  return total > 0 ? cached / total : 0;
}

export interface Bucket {
  /** Bucket start (epoch ms). */
  ts: number;
  /** "20 Aug" (day) or "14:00" (hour). */
  label: string;
  input: number;
  output: number;
  cachedRead: number;
  costUsd: number;
  calls: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(t: number): string {
  const d = new Date(t);
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
}

/**
 * Continuous time buckets (zeros filled) covering [startTs, now]. mode "hour"
 * yields the last 24 hourly buckets; mode "day" daily buckets from startTs.
 */
export function bucketize(events: UsageEvent[], mode: "hour" | "day", startTs: number): Bucket[] {
  const buckets: Bucket[] = [];
  const index = new Map<number, Bucket>();

  const push = (ts: number) => {
    const b: Bucket = {
      ts,
      label: mode === "hour" ? `${String(new Date(ts).getHours()).padStart(2, "0")}:00` : dayLabel(ts),
      input: 0,
      output: 0,
      cachedRead: 0,
      costUsd: 0,
      calls: 0,
    };
    buckets.push(b);
    index.set(ts, b);
  };

  if (mode === "hour") {
    const current = Math.floor(Date.now() / HOUR) * HOUR;
    for (let i = 23; i >= 0; i--) push(current - i * HOUR);
  } else {
    const start = localMidnight(startTs);
    const end = localMidnight(Date.now());
    let t = start;
    let guard = 0;
    while (t <= end && guard++ < 3000) {
      push(t);
      t = localMidnight(t + DAY); // DST-proof next midnight
    }
  }

  const floor = (t: number) => (mode === "hour" ? Math.floor(t / HOUR) * HOUR : localMidnight(t));
  for (const e of events) {
    const b = index.get(floor(e.ts));
    if (!b) continue;
    b.input += e.input;
    b.output += e.output;
    b.cachedRead += e.cached_read;
    b.costUsd += e.cost_usd ?? estimateCostUsd(e) ?? 0;
    b.calls += 1;
  }
  return buckets;
}

/** CSV export of raw events (Excel/Sheets-friendly). */
export function usageToCsv(events: UsageEvent[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head =
    "timestamp,provider,model,kind,input_tokens,output_tokens,cached_read_tokens,cached_write_tokens,cost_usd";
  const rows = events.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.provider,
      e.model,
      e.kind,
      e.input,
      e.output,
      e.cached_read,
      e.cached_write,
      e.cost_usd ?? "",
    ]
      .map(esc)
      .join(",")
  );
  return [head, ...rows].join("\n");
}
