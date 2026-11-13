/**
 * Share a notebook as read-only links (shareLinks.ts). A notebook can have
 * several, each with its own name, contents and expiry ("Class, 7 days",
 * "Study group, with chats"): create one, copy it, and later update, re-key
 * or stop each on its own.
 */
import { Check, ChevronDown, Copy, Link2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchShareInfo,
  listShares,
  publishShare,
  resetShare,
  rowOptions,
  shareUrl,
  stopSharing,
  type Progress,
  type ShareInfo,
  type ShareOptions,
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

/** What a link holds, in a few words. */
function contents(r: ShareRow): string {
  return [r.include_media ? "with media" : "text only", r.include_chats ? "with chats" : ""].filter(Boolean).join(", ");
}

/** A link's settings being edited; `expiry` is relative to the link's current one. */
interface Draft {
  label: string;
  includeMedia: boolean;
  includeChats: boolean;
  sharedBy: string;
  expiry: Expiry;
}

const newDraft = (n: number, sharedBy = ""): Draft => ({
  label: n === 0 ? "" : `Link ${n + 1}`,
  includeMedia: true,
  includeChats: false,
  sharedBy,
  expiry: "never",
});

const draftOf = (r: ShareRow): Draft => ({
  label: r.label ?? "",
  includeMedia: !!r.include_media,
  includeChats: !!r.include_chats,
  sharedBy: r.shared_by,
  expiry: "keep",
});

const optionsOf = (d: Draft, current: number | null): ShareOptions => ({
  label: d.label,
  includeMedia: d.includeMedia,
  includeChats: d.includeChats,
  sharedBy: d.sharedBy,
  expiresAt: expiryAt(d.expiry, current),
});

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
  const [links, setLinks] = useState<ShareRow[] | undefined>(undefined);
  const [info, setInfo] = useState<Map<string, ShareInfo>>(new Map());
  /** Link whose settings are open, or "new" for one being made. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft(0));
  /** What's running: a link id ("new" for a new one, "all" for Update all) and its label. */
  const [busy, setBusy] = useState<{ id: string; label: string } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const rows = await listShares(notebookId);
    // Oldest first, so a new link appears at the bottom, next to where it was made.
    setLinks([...rows].reverse());
    if (rows.length === 0) {
      setEditing("new");
      setDraft(newDraft(0));
    }
    fetchShareInfo().then(setInfo, () => setInfo(new Map()));
  }, [notebookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusy({ id, label });
    setError(null);
    setProgress(null);
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (e) {
      setError({ id, text: message(e) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const copy = async (r: ShareRow) => {
    await navigator.clipboard.writeText(shareUrl(r)).catch(() => {});
    setCopied(r.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const account = sync.account;
  // Any plan that includes Sync (Sync, Sync Plus, Pro, Max); not the trial.
  const paid = !!account && account.canSync && account.plan !== "trial" && account.plan !== "none";

  const status = (id: string) => (
    <>
      {error?.id === id && <p className="mt-2 text-[12px] leading-relaxed text-danger">{error.text}</p>}
      {busy?.id === id && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
          <Spinner size={12} />
          {busy.label}
          {progress && progress.total > 1 && ` ${progress.done} of ${progress.total}`}
        </p>
      )}
    </>
  );

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
  } else if (links === undefined) {
    body = <Spinner />;
  } else if (!paid && links.length === 0) {
    body = (
      <>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
          Sharing links come with a BrewLM Sync plan. Anyone you send a link to can read the notebook and save a copy;
          they don't need an account.
        </p>
        <GhostButton onClick={onOpenSettings}>Choose a plan</GhostButton>
      </>
    );
  } else {
    body = (
      <>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
          {links.length === 0
            ? "Anyone with the link can read this notebook and save a copy, without an account. It's encrypted with a key only the link carries: BrewLM's server can't read it."
            : "People with a link see the notebook as it was when you last updated that link, and can save their own copy. Each link stops on its own."}
        </p>

        <div className="flex flex-col gap-2.5">
          {links.map((r, i) => {
            const meta = info.get(r.id);
            const open = editing === r.id;
            return (
              <div key={r.id} className="rounded-xl border border-edge p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{r.label || `Link ${i + 1}`}</span>
                  <button
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(open ? null : r.id);
                      setDraft(draftOf(r));
                      setError(null);
                    }}
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-ink-3 hover:bg-hover-soft hover:text-ink disabled:opacity-40"
                    aria-expanded={open}
                  >
                    Settings
                    <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
                  </button>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-edge bg-canvas px-3 py-1.5">
                  <Link2 size={13} className="shrink-0 text-ink-3" />
                  <input
                    readOnly
                    value={shareUrl(r)}
                    onFocus={(e) => e.target.select()}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none"
                    aria-label={`${r.label || `Link ${i + 1}`} address`}
                  />
                  <button
                    onClick={() => void copy(r)}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-hover-soft"
                  >
                    {copied === r.id ? <Check size={13} /> : <Copy size={13} />}
                    {copied === r.id ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                  {r.version === 0 ? "Not published yet" : `Updated ${when(r.updated_at || r.created_at)}`} · {contents(r)}
                  {meta && ` · ${meta.views} ${meta.views === 1 ? "view" : "views"}`}
                  {r.expires_at ? ` · until ${when(r.expires_at)}` : ""}
                  {meta?.disabled && " · taken down"}
                </p>

                {open && (
                  <LinkSettings draft={draft} onChange={setDraft} existing current={r.expires_at} className="mt-3" />
                )}

                {status(r.id)}

                <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
                  <button
                    disabled={!!busy}
                    onClick={async () => {
                      const ok = await confirmAction({
                        title: "Stop sharing this link?",
                        message: `“${r.label || `Link ${i + 1}`}” stops working for everyone right away. Your other links keep working, and copies people already saved stay theirs.`,
                        confirmLabel: "Stop sharing",
                      });
                      if (ok) await run(r.id, "Stopping…", () => stopSharing(r));
                    }}
                    className="mr-auto rounded-full px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger-bg disabled:opacity-40"
                  >
                    Stop
                  </button>
                  <button
                    disabled={!!busy || !paid}
                    onClick={async () => {
                      const ok = await confirmAction({
                        title: "Give this link a new address?",
                        message: "The current address stops working. Send the new one to the people who should keep access.",
                        confirmLabel: "New address",
                      });
                      if (ok)
                        await run(r.id, "Making a new address…", () =>
                          resetShare(open ? { ...r, ...rowFields(optionsOf(draft, r.expires_at)) } : r, setProgress)
                        );
                    }}
                    className="rounded-full px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-hover-soft disabled:opacity-40"
                  >
                    New address
                  </button>
                  <button
                    disabled={!!busy || !paid}
                    onClick={() =>
                      run(r.id, "Updating…", () =>
                        publishShare(notebookId, open ? optionsOf(draft, r.expires_at) : rowOptions(r), r, setProgress)
                      )
                    }
                    className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:opacity-85 disabled:opacity-40"
                  >
                    {open ? "Save and update" : "Update"}
                  </button>
                </div>
              </div>
            );
          })}

          {editing === "new" ? (
            // The first link's settings stand alone; another one gets a card like the links above.
            <div className={links.length > 0 ? "rounded-xl border border-accent/50 p-3" : ""}>
              {links.length > 0 && <p className="mb-2 text-[12.5px] font-semibold text-ink">New link</p>}
              <LinkSettings draft={draft} onChange={setDraft} existing={false} current={null} />
              {status("new")}
              <div className="mt-3 flex items-center justify-end gap-2">
                {links.length > 0 && (
                  <GhostButton disabled={!!busy} onClick={() => setEditing(null)}>
                    Cancel
                  </GhostButton>
                )}
                <PrimaryButton
                  disabled={!!busy || !paid}
                  onClick={() => run("new", "Uploading…", () => publishShare(notebookId, optionsOf(draft, null), undefined, setProgress))}
                >
                  Create link
                </PrimaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                disabled={!!busy || !paid}
                onClick={() => {
                  setEditing("new");
                  setDraft(newDraft(links.length, links[links.length - 1]?.shared_by ?? ""));
                  setError(null);
                }}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-hover-soft disabled:opacity-40"
              >
                <Plus size={14} />
                Add another link
              </button>
              {links.length > 1 && (
                <GhostButton
                  disabled={!!busy || !paid}
                  onClick={() =>
                    run("all", "Updating all links…", async () => {
                      for (const r of links) await publishShare(notebookId, rowOptions(r), r);
                    })
                  }
                >
                  Update all
                </GhostButton>
              )}
            </div>
          )}
          {status("all")}
        </div>

        {links.length > 0 && !paid && (
          <p className="mt-3 text-[11.5px] text-ink-3">Updating or adding links needs an active Sync plan.</p>
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

/** One link's settings: its name, what goes in, who it's from, how long it works. */
function LinkSettings({
  draft,
  onChange,
  existing,
  current,
  className = "",
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  /** A published link (its expiry can be kept) rather than a new one. */
  existing: boolean;
  /** That link's expiry now (null = always). */
  current: number | null;
  className?: string;
}) {
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  return (
    <div className={`divide-y divide-edge-soft rounded-xl border border-edge px-3.5 ${className}`}>
      <div className="py-2.5">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Name (only you see it)</span>
        <input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value.slice(0, 40) })}
          placeholder="e.g. Class, Study group"
          className="w-full rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
        />
      </div>
      <div className="flex items-center justify-between gap-4 py-2.5">
        <span>
          <span className="block text-[12.5px] font-medium text-ink">Sources and Studio outputs</span>
          <span className="block text-[11.5px] text-ink-3">Always included. API keys and settings never are.</span>
        </span>
        <Check size={15} className="text-ink-3" />
      </div>
      <div className="flex items-center justify-between gap-4 py-2.5">
        <span>
          <span className="block text-[12.5px] font-medium text-ink">Media files</span>
          <span className="block text-[11.5px] text-ink-3">
            Images, recordings and audio overviews. Off = their text only (descriptions, transcripts, scripts); PDFs and
            documents are always shared as text.
          </span>
        </span>
        <span className="shrink-0">
          <Toggle checked={draft.includeMedia} onChange={(v) => set({ includeMedia: v })} label="Include media files" />
        </span>
      </div>
      <div className="flex items-center justify-between gap-4 py-2.5">
        <span>
          <span className="block text-[12.5px] font-medium text-ink">Chats</span>
          <span className="block text-[11.5px] text-ink-3">Your conversations with this notebook.</span>
        </span>
        <span className="shrink-0">
          <Toggle checked={draft.includeChats} onChange={(v) => set({ includeChats: v })} label="Include chats" />
        </span>
      </div>
      <div className="py-2.5">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Shared by (optional)</span>
        <input
          value={draft.sharedBy}
          onChange={(e) => set({ sharedBy: e.target.value.slice(0, 60) })}
          placeholder="Your name, shown to people who open the link"
          className="w-full rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
        />
      </div>
      <div className="py-2.5">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Link works</span>
        <Segmented<Expiry>
          options={[
            // An existing link: keep its expiry, or change it ("Always" is the kept choice when it has none).
            ...(existing ? [{ id: "keep" as const, label: current ? `Until ${when(current)}` : "Always" }] : []),
            ...(!existing || current !== null ? [{ id: "never" as const, label: "Always" }] : []),
            { id: "7", label: "7 days" },
            { id: "30", label: "30 days" },
          ]}
          value={draft.expiry}
          onChange={(v) => set({ expiry: v })}
        />
      </div>
    </div>
  );
}

/** Settings in a link row's shape, for a new address that keeps them. */
function rowFields(o: ShareOptions): Pick<ShareRow, "label" | "include_chats" | "include_media" | "shared_by" | "expires_at"> {
  return {
    label: o.label,
    include_chats: o.includeChats ? 1 : 0,
    include_media: o.includeMedia ? 1 : 0,
    shared_by: o.sharedBy,
    expires_at: o.expiresAt,
  };
}
