import { useEffect, useState } from "react";
import { AI_TIERS, aiConfigNow, fetchAiUsage, loadAiConfig, TIER_DESCRIPTIONS, tierOf, type AiConfig, type AiUsage } from "../../lib/brewlmAi";
import { getSyncStatus, onSyncStatus, type SyncStatus } from "../../lib/sync";
import type { Settings } from "../../lib/types";
import { Row } from "./controls";

/** Signed in, and on a plan that includes BrewLM AI? */
function useAccess(): { status: SyncStatus; access: "off" | "signed-out" | "no-plan" | "ok" } {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus());
  useEffect(() => onSyncStatus(setStatus), []);
  const plan = status.account?.plan;
  const access =
    status.state === "off"
      ? "off"
      : status.state === "signed-out" || !status.account
        ? "signed-out"
        : plan === "pro" || plan === "max"
          ? "ok"
          : "no-plan";
  return { status, access };
}

const resetsOn = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric" });

/**
 * Settings → AI Model (and Audio voices) with BrewLM AI picked: whether it's
 * ready, and how much of this month's allowance is left. Never shows dollars.
 */
export function BrewLmAiStatusRow() {
  const { status, access } = useAccess();
  const [usage, setUsage] = useState<AiUsage | null>(null);
  useEffect(() => {
    if (access !== "ok") return;
    let live = true;
    void fetchAiUsage().then((u) => live && setUsage(u));
    return () => {
      live = false;
    };
  }, [access]);

  let desc: string;
  if (access === "off") desc = "This build has no BrewLM account server, so BrewLM AI isn't available. Pick another provider.";
  else if (access === "signed-out") desc = "Sign in under Settings → Sync to use it. It's included with the Pro and Max plans.";
  else if (access === "no-plan")
    desc = `Included with the Pro and Max plans; you're on ${status.account?.plan === "trial" ? "the free trial" : "a plan without it"}. Choose Pro or Max in Settings → Sync, or pick another provider with your own key.`;
  else if (!usage?.left) desc = `Included with your ${status.account?.plan === "max" ? "Max" : "Pro"} plan. No API key needed.`;
  else
    desc = `${usage.trial ? "Trial allowance" : "This month"}: about ${usage.left.chats.toLocaleString()} more chats, or ${usage.left.audioOverviews} audio overviews. Refills ${resetsOn(usage.resetsAt)}.`;

  const used = usage && access === "ok" ? Math.round(usage.usedFraction * 100) : null;
  return (
    <Row label="BrewLM AI" desc={desc} alignTop>
      <div className="w-40 pt-1 text-right">
        {used !== null ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
              <div className={`h-full rounded-full ${used >= 90 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(2, used)}%` }} />
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">{used}% used</div>
          </>
        ) : (
          <span className={`text-[12px] font-medium ${access === "ok" ? "text-ink-2" : "text-warn"}`}>
            {access === "ok" ? "Ready" : access === "signed-out" ? "Not signed in" : access === "no-plan" ? "Needs Pro or Max" : "Unavailable"}
          </span>
        )}
      </div>
    </Row>
  );
}

/** BrewLM AI's model choice: Fast, Smart or Best. Model names stay out of sight. */
export function BrewLmTierRow({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const [config, setConfig] = useState<AiConfig>(aiConfigNow());
  useEffect(() => {
    let live = true;
    void loadAiConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);
  const current = tierOf(settings.model) ?? config.defaultTier;
  return (
    <Row label="Model" desc={TIER_DESCRIPTIONS[current]} alignTop>
      <div className="grid w-72 grid-cols-3 gap-1 rounded-lg border border-edge bg-canvas p-1">
        {AI_TIERS.map((t) => (
          <button
            key={t}
            onClick={() => patch({ model: config.tiers[t].model })}
            className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
              current === t ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {config.tiers[t].label}
          </button>
        ))}
      </div>
    </Row>
  );
}
