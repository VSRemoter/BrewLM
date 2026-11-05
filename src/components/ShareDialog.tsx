/**
 * Share a notebook as a read-only link (shareLinks.ts): pick what goes in,
 * create the link, copy it, and later update, reset or stop it.
 */
import { Check, Copy, Link2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchShareInfo,
  listShares,
  publishShare,
  resetShare,
  shareUrl,
  stopSharing,
  type Progress,
  type ShareInfo,
  type ShareRow,
} from "../lib/shareLinks";
import { confirmAction } from "./ConfirmDialog";
import { useSyncStatus } from "./settings/SyncSection";
import { Toggle } from "./settings/controls";
import { GhostButton, Modal, PrimaryButton, Segmented, Spinner } from "./ui";

type Expiry = "keep" | "never" | "7" | "30";
const DAY = 86_400_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function expiryAt(choice: Expiry, current: number | null): number | null {
  if (choice === "keep") return current;
  return choice === "never" ? null : Date.now() + Number(choice) * DAY;
}

export default function ShareDialog({
  notebookId,
  onClose,
  onOpenSettings,
}: {
  notebookId: string;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const sync = useSyncStatus();
  const [link, setLink] = useState<ShareRow | null | undefined>(undefined);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [includeChats, setIncludeChats] = useState(false);
  const [sharedBy, setSharedBy] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [row] = await listShares(notebookId);
    setLink(row ?? null);
    if (row) {
      setIncludeMedia(!!row.include_media);
      setIncludeChats(!!row.include_chats);
      setSharedBy(row.shared_by);
      setExpiry("keep");
      fetchShareInfo()
        .then((m) => setInfo(m.get(row.id) ?? null))
        .catch(() => setInfo(null));
    }
  }, [notebookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setProgress(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const opts = () => ({ includeChats, includeMedia, sharedBy, expiresAt: expiryAt(expiry, link?.expires_at ?? null) });

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(shareUrl(link)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const account = sync.account;
  const paid = account && (account.plan === "sync" || account.plan === "plus") && account.canSync;

  let body;
  if (sync.state === "off") {
    body = <p className="text-[12.5px] leading-relaxed text-ink-3">Sharing links isn't available in this build.</p>;
  } else if (!account) {
    body = (
      <>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
          Sharing links needs BrewLM Sync. Sign in under Settings → Sync, then come back here.
        </p>
        <GhostButton onClick={onOpenSettings}>Open Settings</GhostButton>
      </>
    );
  } else if (!paid && !link) {
    body = (
      <>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
          Sharing links come with a BrewLM Sync plan. Anyone you send a link to can read the notebook and save a copy;
          they don't need an account.
        </p>
        <GhostButton onClick={onOpenSettings}>Choose a plan</GhostButton>
      </>
    );
  } else if (link === undefined) {
    body = <Spinner />;
  } else {
    body = (
      <>
        {link && (
          <div className="mb-4">
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-canvas px-3 py-2">
              <Link2 size={14} className="shrink-0 text-ink-3" />
              <input
                readOnly
                value={shareUrl(link)}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none"
                aria-label="Link"
              />
              <button
                onClick={copy}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-hover-soft"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
              Updated {when(link.updated_at || link.created_at)}
              {info && ` · ${info.views} ${info.views === 1 ? "view" : "views"}`}
              {link.expires_at ? ` · stops working ${when(link.expires_at)}` : ""}
              {info?.disabled && " · taken down"}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              People with the link see the notebook as it was when you last updated it, and can save their own copy.
            </p>
          </div>
        )}

        {!link && (
          <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
            Anyone with the link can read this notebook and save a copy, without an account. It's encrypted with a key
            only the link carries: BrewLM's server can't read it.
          </p>
        )}

        <div className="divide-y divide-edge-soft rounded-xl border border-edge px-3.5">
          <label className="flex items-center justify-between gap-4 py-2.5">
            <span>
              <span className="block text-[12.5px] font-medium text-ink">Sources and Studio outputs</span>
              <span className="block text-[11.5px] text-ink-3">Always included. API keys and settings never are.</span>
            </span>
            <Check size={15} className="text-ink-3" />
          </label>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <span>
              <span className="block text-[12.5px] font-medium text-ink">Media files</span>
              <span className="block text-[11.5px] text-ink-3">
                Images, recordings and audio overviews. Off = their text only (descriptions, transcripts, scripts); PDFs and
                documents are always shared as text.
              </span>
            </span>
            <Toggle checked={includeMedia} onChange={setIncludeMedia} label="Include media files" />
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <span>
              <span className="block text-[12.5px] font-medium text-ink">Chats</span>
              <span className="block text-[11.5px] text-ink-3">Your conversations with this notebook.</span>
            </span>
            <Toggle checked={includeChats} onChange={setIncludeChats} label="Include chats" />
          </div>
          <div className="py-2.5">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Shared by (optional)</span>
            <input
              value={sharedBy}
              onChange={(e) => setSharedBy(e.target.value.slice(0, 60))}
              placeholder="Your name, shown to people who open the link"
              className="w-full rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          </div>
          <div className="py-2.5">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Link works</span>
            <Segmented<Expiry>
              options={[
                ...(link ? [{ id: "keep" as const, label: link.expires_at ? `Until ${when(link.expires_at)}` : "Always" }] : []),
                ...(link && !link.expires_at ? [] : [{ id: "never" as const, label: "Always" }]),
                { id: "7", label: "7 days" },
                { id: "30", label: "30 days" },
              ]}
              value={expiry}
              onChange={setExpiry}
            />
          </div>
        </div>

        {error && <p className="mt-3 text-[12px] leading-relaxed text-danger">{error}</p>}
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
            <Spinner size={12} />
            {busy}
            {progress && progress.total > 1 && ` ${progress.done} of ${progress.total}`}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {link ? (
            <>
              <button
                disabled={!!busy}
                onClick={async () => {
                  const ok = await confirmAction({
                    title: "Stop sharing?",
                    message: "The link stops working for everyone right away. Copies people already saved stay theirs.",
                    confirmLabel: "Stop sharing",
                  });
                  if (ok) await run("Stopping…", () => stopSharing(link));
                }}
                className="mr-auto rounded-full px-3 py-2 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:opacity-40"
              >
                Stop sharing
              </button>
              <GhostButton
                disabled={!!busy || !paid}
                onClick={async () => {
                  const ok = await confirmAction({
                    title: "Make a new link?",
                    message: "The current link stops working. Send the new one to the people who should keep access.",
                    confirmLabel: "New link",
                  });
                  if (ok) await run("Making a new link…", () => resetShare({ ...link, ...rowOpts(opts()) }, setProgress));
                }}
              >
                New link
              </GhostButton>
              <PrimaryButton
                disabled={!!busy || !paid}
                onClick={() => run("Updating…", () => publishShare(notebookId, opts(), link, setProgress))}
              >
                Update link
              </PrimaryButton>
            </>
          ) : (
            <PrimaryButton
              disabled={!!busy}
              onClick={() => run("Uploading…", () => publishShare(notebookId, opts(), undefined, setProgress))}
            >
              Create link
            </PrimaryButton>
          )}
        </div>
        {link && !paid && (
          <p className="mt-2 text-right text-[11.5px] text-ink-3">Updating a link needs an active Sync plan.</p>
        )}
      </>
    );
  }

  return (
    <Modal title="Share notebook" onClose={busy ? () => {} : onClose}>
      {body}
    </Modal>
  );
}

/** Dialog choices in the row's shape, for a reset that keeps them. */
function rowOpts(o: { includeChats: boolean; includeMedia: boolean; sharedBy: string; expiresAt: number | null }) {
  return {
    include_chats: o.includeChats ? 1 : 0,
    include_media: o.includeMedia ? 1 : 0,
    shared_by: o.sharedBy,
    expires_at: o.expiresAt,
  };
}
