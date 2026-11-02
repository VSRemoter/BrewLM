import { describe, expect, it, vi } from "vitest";
import { bucketize, rangeStart, type UsageEvent } from "./usage";

vi.mock("./db", () => ({ getDb: vi.fn(), uid: () => "id" }));
// A US zone, so the clock changes (1 Nov and 8 Mar 2026) are inside the tested ranges.
vi.stubEnv("TZ", "America/New_York");

const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).getTime();

const event = (ts: number, cost: number): UsageEvent => ({
  id: String(ts),
  ts,
  provider: "openrouter",
  model: "test/model",
  kind: "chat",
  input: 100,
  output: 50,
  cached_read: 0,
  cached_write: 0,
  cost_usd: cost,
});

describe("day buckets", () => {
  const now = at(2026, 11, 2, 17); // the day after clocks fell back

  it.each([7, 30, 90])("has one bucket per day across a 25-hour day (%i days)", (days) => {
    const buckets = bucketize([], "day", rangeStart(days, now), now);
    expect(buckets).toHaveLength(days);
    expect(new Set(buckets.map((b) => b.label)).size).toBe(days);
    expect(buckets.filter((b) => b.label === "1 Nov")).toHaveLength(1);
    expect(buckets[buckets.length - 1].label).toBe("2 Nov");
  });

  it("has one bucket per day across a 23-hour day", () => {
    const march = at(2026, 3, 10, 17); // clocks sprang forward on 8 Mar
    const buckets = bucketize([], "day", rangeStart(7, march), march);
    expect(buckets.map((b) => b.label)).toEqual(["4 Mar", "5 Mar", "6 Mar", "7 Mar", "8 Mar", "9 Mar", "10 Mar"]);
  });

  it("puts each event on its own day", () => {
    const events = [event(at(2026, 11, 1, 23), 0.25), event(at(2026, 11, 2, 9), 0.5), event(at(2026, 10, 27, 0), 0.1)];
    const buckets = bucketize(events, "day", rangeStart(7, now), now);
    const cost = Object.fromEntries(buckets.map((b) => [b.label, b.costUsd]));
    expect(cost["27 Oct"]).toBeCloseTo(0.1);
    expect(cost["1 Nov"]).toBeCloseTo(0.25);
    expect(cost["2 Nov"]).toBeCloseTo(0.5);
    expect(buckets.reduce((n, b) => n + b.calls, 0)).toBe(3);
  });

  it("starts the range at the first bucket, so totals and chart match", () => {
    expect(rangeStart(7, now)).toBe(new Date(2026, 9, 27).getTime());
    expect(bucketize([], "day", rangeStart(7, now), now)[0].ts).toBe(rangeStart(7, now));
  });
});

describe("hour buckets", () => {
  it("covers the last 24 hours, starting where the range starts", () => {
    const now = at(2026, 11, 1, 17);
    const buckets = bucketize([], "hour", 0, now);
    expect(buckets).toHaveLength(24);
    expect(buckets[0].ts).toBe(rangeStart("hours", now));
    expect(new Set(buckets.map((b) => b.ts)).size).toBe(24);
  });
});
