import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AI_TIERS,
  aiBlock,
  aiConfigNow,
  brewlmModelLabel,
  costLabel,
  costVsFast,
  fetchAiUsage,
  loadAiConfig,
  TIER_DESCRIPTIONS,
  tierOf,
  type AiConfig,
  type AiCounts,
  type AiUsage,
} from "../../lib/brewlmAi";
import { buyAiTopup, changePlan, getSyncStatus, onSyncStatus, type SyncStatus } from "../../lib/sync";
import type { Settings } from "../../lib/types";
import { Row } from "./controls";
import { openSettingsAt } from "../../lib/settingsNav";
import { confirmAction } from "../ConfirmDialog";

type Access = "off" | "signed-out" | "no-plan" | "ok";

/** Signed in, and on a plan that includes BrewLM AI? */
export function useAiAccess(): { status: SyncStatus; access: Access } {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus());
  useEffect(() => onSyncStatus(setStatus), []);
  const plan = status.account?.plan;
  const access: Access =
    status.state === "off"
      ? "off"
      : status.state === "signed-out" || !status.account
        ? "signed-out"
        : plan === "pro" || plan === "max"
          ? "ok"
          : "no-plan";
  return { status, access };
}

/** This month's allowance, refetched when the window regains focus (e.g. back from a top-up checkout). */
function useAiUsage(enabled: boolean): AiUsage | null {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => void fetchAiUsage().then((u) => live && u && setUsage(u));
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return usage;
}

/** How many times Fast's cost a model's chats use, once OpenRouter's prices load. */
function useCostVsFast(models: string[]): Record<string, number> {
  const [out, setOut] = useState<Record<string, number>>({});
  const key = models.join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(models.map(async (m) => [m, await costVsFast(m)] as const)).then((pairs) => {
      if (!live) return;
      setOut(Object.fromEntries(pairs.filter((p): p is readonly [string, number] => p[1] !== null)));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

const resetsOn = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric" });

/** "about 1,200 chats, 6 audio overviews or 2 research reports", with chats counted on `ratio`× Fast's cost. */
function countsLine(c: AiCounts, ratio = 1): string {
  const chats = Math.floor(c.chats / Math.max(1, ratio));
  const parts = [
    `${chats.toLocaleString()} chat${chats === 1 ? "" : "s"}`,
    `${c.audioOverviews} audio overview${c.audioOverviews === 1 ? "" : "s"}`,
    `${c.researchRuns} research report${c.researchRuns === 1 ? "" : "s"}`,
  ];
  return `about ${parts[0]}, ${parts[1]} or ${parts[2]}`;
}

function TopupButton({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={() => {
        setBusy(true);
        void buyAiTopup()
          .catch((e) => onError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
      disabled={busy}
      className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-50"
    >
      {busy ? "Opening…" : "Top up…"}
    </button>
  );
}

/**
 * Settings → AI Model (and Audio voices) with BrewLM AI picked: whether it's
 * ready, how much of this month is left (as things you can still do, counted
 * on the chat model picked), and a top-up. Never shows dollars.
 */
export function BrewLmAiStatusRow({ model }: { model?: string }) {
  const { status, access } = useAiAccess();
  const usage = useAiUsage(access === "ok");
  const ratio = useCostVsFast(model ? [model] : [])[model ?? ""] ?? 1;
  const [error, setError] = useState<string | null>(null);

  let desc: string;
  if (access === "off") desc = "This build has no BrewLM account server, so BrewLM AI isn't available. Pick another provider.";
  else if (access === "signed-out") desc = "Sign in under Settings → Sync to use it. It's included with the Pro and Max plans.";
  else if (access === "no-plan")
    desc = `Included with the Pro and Max plans; you're on ${status.account?.plan === "trial" ? "the free trial" : "a plan without it"}. Choose Pro or Max in Settings → Sync, or pick another provider with your own key.`;
  else if (usage?.paused) desc = "BrewLM AI is paused for a little while. Try again later, or use your own API key meanwhile.";
  else if (!usage?.left) desc = `Included with your ${status.account?.plan === "max" ? "Max" : "Pro"} plan. No API key needed.`;
  else
    desc = `${usage.trial ? "Left in your trial" : "Left this month"}: ${countsLine(usage.left, ratio)}${
      model && ratio >= 1.5 ? ` on ${brewlmModelLabel(model)}` : ""
    }. Refills ${resetsOn(usage.resetsAt)}.${
      usage.topupAdds ? ` A top-up adds ${countsLine(usage.topupAdds, ratio)} and lasts until you use it.` : ""
    }`;

  const used = usage && access === "ok" ? Math.round(usage.usedFraction * 100) : null;
  return (
    <>
      <Row label="BrewLM AI" desc={desc} alignTop>
        <div className="w-40 pt-1 text-right">
          {used !== null ? (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
                <div className={`h-full rounded-full ${used >= 90 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(2, used)}%` }} />
              </div>
              <div className="mt-1 text-[11.5px] text-ink-3">{used}% used</div>
              {!usage?.trial && (
                <div className="mt-2">
                  <TopupButton onError={setError} />
                </div>
              )}
            </>
          ) : (
            <span className={`text-[12px] font-medium ${access === "ok" ? "text-ink-2" : "text-warn"}`}>
              {access === "ok" ? "Ready" : access === "signed-out" ? "Not signed in" : access === "no-plan" ? "Needs Pro or Max" : "Unavailable"}
            </span>
          )}
        </div>
      </Row>
      {error && <p className="pb-3 text-[12px] text-danger">{error}</p>}
    </>
  );
}

function useConfig(): AiConfig {
  const [config, setConfig] = useState<AiConfig>(aiConfigNow());
  useEffect(() => {
    let live = true;
    void loadAiConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/** "Each chat uses about 20× as much of your allowance as one on Fast." */
function costWarning(ratio: number | undefined): string {
  if (!ratio || ratio < 1.5) return "";
  return ` Each chat uses ${costLabel(ratio).replace(/ Fast$/, "")} as much of your allowance as one on Fast.`;
}

/**
 * BrewLM AI's model choice: Fast, Smart or Best, each with how fast it uses
 * the allowance; More models below for the curious. Model names stay out of
 * the way.
 */
export function BrewLmTierRow({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const config = useConfig();
  const more = config.more ?? [];
  const ratios = useCostVsFast([...AI_TIERS.map((t) => config.tiers[t].model), ...more.map((m) => m.model)]);
  const current = tierOf(settings.model);
  const pickedMore = more.find((m) => m.model === settings.model);
  const [open, setOpen] = useState(!!pickedMore);
  const desc = current
    ? TIER_DESCRIPTIONS[current] + costWarning(ratios[settings.model])
    : pickedMore
      ? `${pickedMore.label}, from More models.${costWarning(ratios[settings.model])}`
      : TIER_DESCRIPTIONS[config.defaultTier];
  return (
    <>
      <Row label="Model" desc={desc} alignTop>
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
      {more.length > 0 && (
        <div className="py-3">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            More models
          </button>
          {open && (
            <>
              <p className="mt-1.5 mb-2 text-[12px] leading-relaxed text-ink-3">
                Other capable models, if you'd like a different voice or strength. Each shows how much of your
                allowance a chat uses next to Fast.
              </p>
              <div className="flex flex-col">
                {more.map((m) => {
                  const r = ratios[m.model];
                  const active = settings.model === m.model;
                  return (
                    <button
                      key={m.model}
                      onClick={() => patch({ model: m.model })}
                      className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                        active ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover"
                      }`}
                    >
                      <span>{m.label}</span>
                      <span className={`text-[11.5px] ${r && r >= 10 ? "text-warn" : "text-ink-3"}`}>{r ? costLabel(r) : ""}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Shown in place of an error when BrewLM AI refused a request: the month's
 * allowance is used up (top up, move to Max, or use your own key), or the
 * account has no plan with AI. `null` for any other error.
 */
export function AiBlockedNotice({ message, onOpenSettings }: { message: string; onOpenSettings: () => void }) {
  const block = aiBlock(message);
  const { status } = useAiAccess();
  const usage = useAiUsage(block === "limit");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!block) return null;

  const plan = status.account?.plan;
  const interval = status.account?.interval ?? "year";
  const settingsAt = (id: "ai" | "sync") => {
    openSettingsAt(id);
    onOpenSettings();
  };
  const upgrade = async () => {
    const ok = await confirmAction({
      title: "Move to Max?",
      message: `Max has a bigger monthly BrewLM AI allowance and 100 GB of storage. It starts now: your card is charged the difference for the rest of this ${interval === "month" ? "month" : "year"}.`,
      confirmLabel: "Move to Max",
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      await changePlan("max", interval);
      setNote("You're on Max now. Your bigger allowance is ready in a few seconds — try again.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const button = "rounded-lg border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-50";

  return (
    <div className="text-[12.5px] leading-relaxed text-ink">
      <div className="font-semibold">
        {block === "limit" ? "You've used this month's BrewLM AI" : "BrewLM AI comes with Pro and Max"}
      </div>
      <div className="mt-0.5 text-ink-2">
        {block === "limit"
          ? `It refills ${usage ? resetsOn(usage.resetsAt) : "at the start of next month"}. To keep going now, add a top-up${
              plan === "pro" ? ", move to Max for a bigger allowance," : ""
            } or use your own API key.`
          : "Choose Pro or Max in Settings → Sync for AI without an API key, or pick another provider with your own key."}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {block === "limit" ? (
          <>
            <TopupButton onError={setNote} />
            {plan === "pro" && (
              <button onClick={() => void upgrade()} disabled={busy} className={button}>
                {busy ? "Switching…" : "Move to Max"}
              </button>
            )}
          </>
        ) : (
          <button onClick={() => settingsAt("sync")} className={button}>
            See plans
          </button>
        )}
        <button onClick={() => settingsAt("ai")} className={button}>
          Use my own key
        </button>
      </div>
      {note && <div className="mt-1.5 text-[12px] text-ink-2">{note}</div>}
    </div>
  );
}
