/**
 * Share a notebook as read-only links (shareLinks.ts). A notebook can have
 * several, each with its own name, contents and expiry ("Class, 7 days",
 * "Study group, with chats"): create one, copy it, and later update, re-key
 * or stop each on its own.
 */
import { Check, Copy, Link2, Lock, Plus, RefreshCw, Settings2 } from "lucide-react";
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
import { GhostButton, inputClass, Modal, PrimaryButton, Segmented, Spinner } from "./ui";

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
      {error?.id === id && <p className="mt-2.5 text-[12.5px] leading-relaxed text-danger">{error.text}</p>}
      {busy?.id === id && (
        <p className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ink-3">
          <Spinner size={12} />
          {busy.label}
          {progress && progress.total > 1 && ` ${progress.done} of ${progress.total}`}
        </p>
      )}
    </>
  );

  /** Explanation + one button, for when links can't be made yet. */
  const notice = (text: string, action?: { label: string; onClick: () => void }) => (
    <div className="flex flex-col items-center px-4 py-6 text-center">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-hover text-ink-2">
        <Link2 size={18} strokeWidth={1.8} />
      </span>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink-2">{text}</p>
      {action && (
        <div className="mt-4">
          <GhostButton onClick={action.onClick}>{action.label}</GhostButton>
        </div>
      )}
    </div>
  );

  let body;
  let footer;
  if (sync.state === "off") {
    body = notice("Sharing links isn't available in this build.");
  } else if (!account) {
    body = notice("Sharing links needs BrewLM Sync. Sign in under Settings → Sync, then come back here.", {
      label: "Open Settings",
      onClick: onOpenSettings,
    });
  } else if (links === undefined) {
    body = (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  } else if (!paid && links.length === 0) {
    body = notice(
      "Sharing links come with a BrewLM Sync plan. Anyone you send a link to can read the notebook and save a copy; they don't need an account.",
      { label: "Choose a plan", onClick: onOpenSettings }
    );
  } else if (links.length === 0) {
    // First link: its settings are the whole dialog, Create link in the footer.
    body = (
      <>
        <Privacy />
        <LinkSettings draft={draft} onChange={setDraft} existing={false} current={null} />
        {status("new")}
      </>
    );
    footer = (
      <PrimaryButton
        disabled={!!busy || !paid}
        onClick={() => run("new", "Uploading…", () => publishShare(notebookId, optionsOf(draft, null), undefined, setProgress))}
      >
        Create link
      </PrimaryButton>
    );
  } else {
    body = (
      <>
        <p className="mb-4 text-[13px] leading-relaxed text-ink-3">
          People with a link see the notebook as it was when you last updated that link, and can save their own copy.
        </p>

        <div className="flex flex-col gap-3">
          {links.map((r, i) => {
            const meta = info.get(r.id);
            const open = editing === r.id;
            const name = r.label || `Link ${i + 1}`;
            return (
              <div
                key={r.id}
                className={`rounded-xl border bg-panel transition-colors ${open ? "border-ink-3/40" : "border-edge"}`}
              >
                <div className="p-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-hover text-ink-2">
                      <Link2 size={15} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-ink">{name}</p>
                      <p className="line-clamp-2 text-[12px] leading-snug text-ink-3">
                        {r.version === 0 ? "Not published yet" : `Updated ${when(r.updated_at || r.created_at)}`} · {contents(r)}
                        {meta && ` · ${meta.views} ${meta.views === 1 ? "view" : "views"}`}
                        {r.expires_at ? ` · until ${when(r.expires_at)}` : ""}
                        {meta?.disabled && " · taken down"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        disabled={!!busy || !paid}
                        onClick={() => run(r.id, "Updating…", () => publishShare(notebookId, rowOptions(r), r, setProgress))}
                        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                        title="Publish the notebook as it is now to this link"
                        aria-label={`Update ${name}`}
                      >
                        <RefreshCw size={13} strokeWidth={1.8} />
                        <span className="hidden sm:inline">Update</span>
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          setEditing(open ? null : r.id);
                          setDraft(draftOf(r));
                          setError(null);
                        }}
                        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
                          open ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"
                        }`}
                        aria-expanded={open}
                        aria-label={`${name} settings`}
                        title="Settings"
                      >
                        <Settings2 size={15} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>

                  {/* The address and Copy as one control. */}
                  <div className="mt-3 flex h-9 items-center overflow-hidden rounded-lg border border-edge bg-canvas/60">
                    {/* Text, not an input: phones enlarge text fields to 16px, which hid most of the address. */}
                    <span
                      className="min-w-0 flex-1 cursor-text truncate px-3 font-mono text-[11.5px] text-ink-2 select-all"
                      aria-label={`${name} address`}
                      title={shareUrl(r)}
                    >
                      {shareUrl(r)}
                    </span>
                    <button
                      onClick={() => void copy(r)}
                      className={`flex h-full shrink-0 items-center gap-1.5 border-l border-edge px-3 text-[12.5px] font-medium transition-colors ${
                        copied === r.id ? "text-ok" : "text-ink hover:bg-hover"
                      }`}
                    >
                      {copied === r.id ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.8} />}
                      {copied === r.id ? "Copied" : "Copy link"}
                    </button>
                  </div>

                  {!open && status(r.id)}
                </div>

                {open && (
                  <div className="border-t border-edge-soft p-3">
                    <LinkSettings draft={draft} onChange={setDraft} existing current={r.expires_at} />
                    {status(r.id)}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <button
                        disabled={!!busy}
                        onClick={async () => {
                          const ok = await confirmAction({
                            title: "Stop sharing this link?",
                            message: `“${name}” stops working for everyone right away. Your other links keep working, and copies people already saved stay theirs.`,
                            confirmLabel: "Stop sharing",
                          });
                          if (ok) await run(r.id, "Stopping…", () => stopSharing(r));
                        }}
                        className="rounded-md px-2 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
                      >
                        Stop sharing
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
                              resetShare({ ...r, ...rowFields(optionsOf(draft, r.expires_at)) }, setProgress)
                            );
                        }}
                        className="mr-auto rounded-md px-2 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
                      >
                        New address
                      </button>
                      {/* Kept together so on a phone they wrap as a pair, right-aligned. */}
                      <div className="ml-auto flex items-center gap-1.5">
                        <GhostButton disabled={!!busy} onClick={() => setEditing(null)}>
                          Cancel
                        </GhostButton>
                        <PrimaryButton
                          disabled={!!busy || !paid}
                          onClick={() =>
                            run(r.id, "Updating…", () => publishShare(notebookId, optionsOf(draft, r.expires_at), r, setProgress))
                          }
                        >
                          Save and update
                        </PrimaryButton>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {editing === "new" && (
            <div className="rounded-xl border border-accent/50 p-3">
              <p className="mb-2 text-[13.5px] font-medium text-ink">New link</p>
              <LinkSettings draft={draft} onChange={setDraft} existing={false} current={null} />
              {status("new")}
              <div className="mt-3 flex items-center justify-end gap-2">
                <GhostButton disabled={!!busy} onClick={() => setEditing(null)}>
                  Cancel
                </GhostButton>
                <PrimaryButton
                  disabled={!!busy || !paid}
                  onClick={() => run("new", "Uploading…", () => publishShare(notebookId, optionsOf(draft, null), undefined, setProgress))}
                >
                  Create link
                </PrimaryButton>
              </div>
            </div>
          )}
          {status("all")}
        </div>

        {!paid && <p className="mt-3 text-[12px] text-ink-3">Updating or adding links needs an active Sync plan.</p>}
      </>
    );
    footer = editing !== "new" && (
      <>
        <button
          disabled={!!busy || !paid}
          onClick={() => {
            setEditing("new");
            setDraft(newDraft(links.length, links[links.length - 1]?.shared_by ?? ""));
            setError(null);
          }}
          className="mr-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <Plus size={15} strokeWidth={1.8} />
          New link
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
      </>
    );
  }

  return (
    <Modal title="Share notebook" size="lg" onClose={busy ? () => {} : onClose} footer={footer || undefined}>
      {body}
    </Modal>
  );
}

/** The one-line privacy promise shown above a first link's settings. */
function Privacy() {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-hover/60 px-3 py-2.5">
      <Lock size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-3" />
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        Anyone with the link can read this notebook and save a copy, without an account. It's encrypted with a key
        only the link carries, so BrewLM's server can't read it.
      </p>
    </div>
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
  const row = "flex items-center justify-between gap-4 py-3";
  const title = "block text-[13px] text-ink";
  const desc = "mt-0.5 block text-[12px] leading-snug text-ink-3";
  return (
    <div className={`divide-y divide-edge-soft ${className}`}>
      <label className="block pb-3">
        <span className={`${title} mb-1.5`}>
          Name <span className="text-ink-3">· only you see it</span>
        </span>
        <input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value.slice(0, 40) })}
          placeholder="e.g. Class, Study group"
          className={inputClass}
        />
      </label>
      <div className={row}>
        <span>
          <span className={title}>Sources and Studio outputs</span>
          <span className={desc}>Always included. API keys and settings never are.</span>
        </span>
        <Check size={16} strokeWidth={2} className="mr-2.5 shrink-0 text-ink-3" />
      </div>
      <div className={row}>
        <span>
          <span className={title}>Media files</span>
          <span className={desc}>
            Images, recordings and audio overviews. Off shares only their text (descriptions, transcripts, scripts). PDFs and
            documents are always shared as text.
          </span>
        </span>
        <span className="shrink-0">
          <Toggle checked={draft.includeMedia} onChange={(v) => set({ includeMedia: v })} label="Include media files" />
        </span>
      </div>
      <div className={row}>
        <span>
          <span className={title}>Chats</span>
          <span className={desc}>Your conversations with this notebook.</span>
        </span>
        <span className="shrink-0">
          <Toggle checked={draft.includeChats} onChange={(v) => set({ includeChats: v })} label="Include chats" />
        </span>
      </div>
      <label className="block py-3">
        <span className={`${title} mb-1.5`}>
          Shared by <span className="text-ink-3">· optional</span>
        </span>
        <input
          value={draft.sharedBy}
          onChange={(e) => set({ sharedBy: e.target.value.slice(0, 60) })}
          placeholder="Your name, shown to viewers"
          className={inputClass}
        />
      </label>
      <div className="pt-3">
        <span className={`${title} mb-1.5`}>Link works</span>
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
