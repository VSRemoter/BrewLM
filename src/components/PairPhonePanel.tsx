import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, Smartphone, Square } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import type { ActivityEntry, SharedDevice } from "../lib/db";
import { listActivity, listDevices, revokeDevice } from "../lib/db";
import { GhostButton } from "./ui";

/** Mirrors Rust `ShareInfo` (server.rs). */
type ShareInfo = {
  url: string | null;
  port: number;
  tunnel: boolean;
  warning: string | null;
  pairing_code: string;
  pin: string;
  scope: string;
};

const ACTION_LABELS: Record<string, string> = {
  pair: "paired",
  chat: "chat",
  generate: "generate",
  "notebook.create": "created notebook",
  "notebook.rename": "renamed notebook",
  "notebook.trash": "trashed notebook",
  "source.text": "added note",
  "source.url": "added link",
};

function timeAgo(ms: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * "Pair your phone" block: starts the local server + quick tunnel, shows the
 * QR + PIN, and lists linked devices with revoke + recent activity.
 * Used in Settings and the notebook header.
 */
export default function PairPhonePanel() {
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fullAccess, setFullAccess] = useState(true);
  const [devices, setDevices] = useState<SharedDevice[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  const refreshDevices = () => {
    listDevices().then(setDevices).catch(() => {});
    listActivity(12).then(setActivity).catch(() => {});
  };

  useEffect(() => {
    invoke<ShareInfo | null>("share_status")
      .then((s) => setShare(s))
      .catch(() => setShare(null));
    refreshDevices();
  }, []);

  const shareUrl = share?.url ? `${share.url}/p/${share.pairing_code}/` : null;

  const startShare = async () => {
    setStarting(true);
    try {
      setShare(await invoke<ShareInfo>("start_sharing", { scope: fullAccess ? "full" : "read" }));
      setTimeout(refreshDevices, 1500);
    } catch (e) {
      console.error("start_sharing failed:", e);
    } finally {
      setStarting(false);
    }
  };

  const stopShare = async () => {
    await invoke("stop_sharing").catch(() => {});
    setShare(null);
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Pair your phone</label>
      <div className="rounded-lg border border-edge bg-panel p-3.5">
        {share === null && (
          <>
            <p className="mb-2.5 text-[12px] leading-relaxed text-ink-3">
              Chat with your notebooks, generate Studio outputs, add sources, and listen to audio
              overviews — from your phone, on any network. Your data and API keys stay on this Mac;
              only paired devices get in.
            </p>
            <label className="mb-3 flex items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
              />
              Full access for this pairing (chat, generation, writes) — off = read-only
            </label>
            <GhostButton onClick={startShare} disabled={starting}>
              <span className="inline-flex items-center gap-2">
                <Smartphone size={14} />
                {starting ? "Starting secure tunnel…" : "Pair a device"}
              </span>
            </GhostButton>
          </>
        )}
        {share !== null && (
          <div className="flex flex-col items-center gap-2.5">
            {shareUrl ? (
              <>
                <div className="rounded-lg bg-white p-2">
                  <QRCodeSVG value={shareUrl} size={168} />
                </div>
                <p className="text-center text-[12px] leading-relaxed text-ink-2">
                  Scan, then enter this PIN on your phone:
                  <span className="mt-1 block font-mono text-[22px] font-bold tracking-[0.35em] text-ink">
                    {share.pin}
                  </span>
                </p>
                <p className="text-center text-[11px] leading-relaxed text-ink-3">
                  Pairing code valid ~20 min · scope:{" "}
                  {share.scope === "full" ? "full access" : "read-only"} · works on cellular.
                </p>
                {share.scope !== "full" && (
                  <p className="text-center text-[11px] leading-relaxed text-ink-3">
                    Read-only pairing — devices can browse chats & sources and listen to audio,
                    but can’t chat, generate, or change anything. Stop sharing and re-pair with
                    “Full access” to change this.
                  </p>
                )}
              </>
            ) : (
              <p className="text-center text-[12px] leading-relaxed text-ink-3">
                {share.warning ?? "Waiting for the tunnel URL… close and try again."}
              </p>
            )}
            {share.warning && shareUrl && (
              <p className="text-center text-[11px] text-ink-3">{share.warning}</p>
            )}
            <div className="flex items-center gap-2 pt-1">
              {shareUrl && (
                <GhostButton onClick={copyShareUrl}>
                  <span className="inline-flex items-center gap-2">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy link"}
                  </span>
                </GhostButton>
              )}
              <GhostButton onClick={stopShare}>
                <span className="inline-flex items-center gap-2">
                  <Square size={13} />
                  Stop sharing
                </span>
              </GhostButton>
            </div>
          </div>
        )}

        {/* Linked devices */}
        {(devices.length > 0 || share !== null) && (
          <div className="mt-4 border-t border-edge-soft pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
                Linked devices
              </span>
              <button
                onClick={refreshDevices}
                className="text-[11px] text-ink-3 underline-offset-2 hover:underline"
              >
                Refresh
              </button>
            </div>
            {devices.length === 0 ? (
              <p className="text-[11.5px] text-ink-3">No devices paired yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {devices.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-medium text-ink">{d.name}</span>
                    <span
                      className={`rounded-full border px-1.5 py-px text-[10px] ${
                        d.scope === "full"
                          ? "border-edge text-ink-2"
                          : "border-edge-soft text-ink-3"
                      }`}
                    >
                      {d.scope === "full" ? "full" : "read-only"}
                    </span>
                    <span className="ml-auto text-[11px] text-ink-3">
                      {d.last_seen ? timeAgo(d.last_seen) : "never used"}
                    </span>
                    <button
                      onClick={() => revokeDevice(d.id).then(refreshDevices).catch(() => {})}
                      className="rounded-md px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger-bg"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
            {activity.length > 0 && (
              <div className="mt-3 rounded-md bg-canvas p-2 text-[11px] leading-relaxed text-ink-3">
                {activity.map((a) => (
                  <div key={a.id} className="flex gap-2">
                    <span className="shrink-0 text-ink-3">{timeAgo(a.created_at)}</span>
                    <span className="truncate">
                      {ACTION_LABELS[a.action] ?? a.action}
                      {a.detail ? ` — ${a.detail}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
