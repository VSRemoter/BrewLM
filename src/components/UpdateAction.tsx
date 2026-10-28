import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { installUpdate, type UpdateInfo } from "../lib/updates";

type Phase = { kind: "idle" } | { kind: "downloading"; progress: number | null } | { kind: "restarting" } | { kind: "failed" };

/**
 * "Update & restart" for a release that can be installed in place; otherwise
 * (or if installing fails) a link to the release page to download it by hand.
 */
export default function UpdateAction({ info }: { info: UpdateInfo }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const { update } = info;

  if (!update || phase.kind === "failed") {
    return (
      <span className="flex items-center gap-2">
        {phase.kind === "failed" && <span className="text-ink-3">Couldn't install the update.</span>}
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 font-medium text-link hover:underline"
        >
          Download <ExternalLink size={11} />
        </a>
      </span>
    );
  }

  const run = async () => {
    setPhase({ kind: "downloading", progress: null });
    try {
      await installUpdate(update, (progress) => setPhase({ kind: "downloading", progress }));
      setPhase({ kind: "restarting" });
    } catch (e) {
      console.warn("update install:", e);
      setPhase({ kind: "failed" });
    }
  };

  return (
    <button
      onClick={() => void run()}
      disabled={phase.kind !== "idle"}
      className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-70"
    >
      <RefreshCw size={12} strokeWidth={2} className={phase.kind === "idle" ? "" : "animate-spin"} />
      {phase.kind === "idle"
        ? "Update & restart"
        : phase.kind === "downloading"
          ? phase.progress === null
            ? "Downloading…"
            : `Downloading ${Math.round(phase.progress * 100)}%`
          : "Restarting…"}
    </button>
  );
}
